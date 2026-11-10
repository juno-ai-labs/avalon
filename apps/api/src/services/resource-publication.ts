import { ResourceSchema } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { AGENT_RESOURCE_TITLE_SQL } from "./agent-resource-title";
import { putStagedResourceObject, releaseStagedResourceObject } from "./resource-object-cleanup";

/**
 * The writes that make a published artifact: a `generated_file` or
 * `generated_site` row keyed by a stable publication identity, and the swap
 * that gives an existing one new content, so a republish is a new version of
 * the same artifact rather than a second one. Rally's own publish
 * (`services/terminal/resource-bridge.ts`) and a person's
 * (`canvas-publication-service.ts`) both write through here; each owns its own
 * identity, replay and attachment rules. `docs/rally-mcp.md#publishing`.
 *
 * Every statement here is a resource statement: `workspace` must route to
 * WorkspaceDO (`withWorkspaceRuntimeDatabase`), never plain D1.
 */

/** Who a revision is by. Rally's run, or a person publishing by hand. */
export type PublicationAuthor =
  | { kind: "agent"; runId: string; onBehalfOfUserId: string | null }
  | { kind: "member"; userId: string };

export interface PublishedRow {
  id: string;
  title: string;
  mime_type: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  metadata_json: string;
  model_content_status: string | null;
  created_at: string;
}

export interface PublishedSiteRow extends PublishedRow {
  slug: string | null;
}

/** A write the platform may or may not have committed; the caller retries with the same identity. */
export class PublicationWriteFailed extends Error {
  constructor(readonly operation: "insert" | "swap") {
    super(`publication_${operation}_failed`);
    this.name = "PublicationWriteFailed";
  }
}

function publicationFailure(error: unknown, operation: "insert" | "swap"): never {
  if (error instanceof Error && /\bcanvas_archived\b/u.test(error.message)) {
    throw new ApiError(409, "canvas_archived", "This Canvas was archived");
  }
  throw new PublicationWriteFailed(operation);
}

/**
 * The longest identity a row may carry: `ResourceSchema` bounds
 * `providerResourceId`, and one row past it stops every list that projects it.
 */
const PUBLISHED_IDENTITY_MAXIMUM = ResourceSchema.shape.providerResourceId.unwrap().maxLength ?? 500;

/** The path as an identity reads it: `docs/./plan.md` and `docs/plan.md` are one file. */
export function normalizePublishPath(path: string): string {
  return path.split("/").filter((segment) => segment && segment !== ".").join("/");
}

/**
 * A publication's identity, `<namespace>:<owner>:<path>`, with the path
 * replaced by its digest past the bound rather than truncated, so two long
 * paths never land on one artifact.
 */
export async function publicationIdentity(namespace: string, owner: string, path: string): Promise<string> {
  const normalized = normalizePublishPath(path);
  const readable = `${namespace}:${owner}:${normalized}`;
  if (readable.length <= PUBLISHED_IDENTITY_MAXIMUM) return readable;
  return `${namespace}:${owner}:sha256:${await sha256Hex(new TextEncoder().encode(normalized))}`;
}

const PUBLICATION_SELECT = `SELECT id, title, mime_type, content_ref, content_sha256, metadata_json,
    model_content_status, created_at, slug, resource_type FROM resources
    WHERE workspace_id = ? AND provider = 'avalon_generated' AND provider_resource_id = ?`;

export function publishedRowByIdentity(workspace: D1Database, workspaceId: string, providerResourceId: string) {
  return workspace.prepare(PUBLICATION_SELECT).bind(workspaceId, providerResourceId)
    .first<PublishedSiteRow & { resource_type: string }>();
}

function authorColumns(author: PublicationAuthor) {
  return author.kind === "agent"
    ? { kind: "agent", runId: author.runId, userId: null, onBehalfOf: author.onBehalfOfUserId }
    : { kind: "member", runId: null, userId: author.userId, onBehalfOf: null };
}

/** The first revision of a publication: one INSERT, `attached`, created by `author`. */
export async function insertPublishedResource(workspace: D1Database, input: {
  resourceId: string;
  workspaceId: string;
  /** Persisted before attachment so archive fences a delayed publication. */
  publicationParentId: string;
  resourceType: "generated_file" | "generated_site";
  providerResourceId: string;
  title: string;
  mimeType: string;
  contentRef: string;
  contentSha256: string;
  metadataJson: string;
  uploadedByUserId: string | null;
  modelContentStatus: string;
  timestamp: string;
  author: PublicationAuthor;
}): Promise<void> {
  const author = authorColumns(input.author);
  try {
    await workspace.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
        content_ref, content_sha256, metadata_json, last_hydrated_at, uploaded_by_user_id,
        attachment_status, model_content_status, created_at, updated_at,
        revision_author_kind, revision_author_run_id, revision_author_user_id, revision_cause, publication_parent_id)
       VALUES (?, ?, ?, 'avalon_generated', ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, ?, ?, ?, ?, ?, 'created', ?)`,
    ).bind(
      input.resourceId, input.workspaceId, input.resourceType, input.providerResourceId, input.title,
      input.mimeType, input.contentRef, input.contentSha256, input.metadataJson, input.timestamp,
      input.uploadedByUserId, input.modelContentStatus, input.timestamp, input.timestamp,
      author.kind, author.runId, author.userId, input.publicationParentId,
    ).run();
  } catch (error) {
    // The insert may have committed before its response was lost. The caller
    // keeps the stable identity, so a retry observes and attaches the row.
    publicationFailure(error, "insert");
  }
}

/**
 * Release a staged object's cleanup fence once the row that names it
 * committed. Failing to clear it never fails a publish: maintenance sees the
 * active pointer and retires the row without touching R2.
 */
export async function settleStagedObject(workspace: D1Database, workspaceId: string, objectRef: string): Promise<void> {
  await workspace.prepare(
    `DELETE FROM resource_object_deletion_outbox
      WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
  ).bind(workspaceId, objectRef).run().catch(() => undefined);
}

/**
 * Swap a republished document's content onto the row it already has.
 *
 * Pre-register the new object in the cleanup outbox, write it, then
 * compare-and-swap the pointer against the one that was read, so a lost race
 * deletes the object it wrote rather than overwriting a newer publish. The
 * old bytes are not destroyed: WorkspaceDO's version triggers capture the
 * superseded state, and the reaper treats a ref a version still names as
 * active.
 */
export async function swapPublishedContent(input: {
  workspace: D1Database;
  env: Env;
  workspaceId: string;
  existing: PublishedRow;
  /** Where the bytes came from, recorded as `sourcePath` and on the object. */
  sourcePath: string;
  /** `terminal` for Rally's publish, `person` for a person's. */
  objectSource: string;
  displayName?: string | undefined;
  description?: string | undefined;
  bytes: Uint8Array;
  digest: string;
  mimeType: string;
  attachmentKind: string;
  contentMode: string;
  derivativeStatus: string;
  author: PublicationAuthor;
  /** The publication's own record in `metadata_json`: which call made this revision, and as what. */
  receipt: Record<string, string>;
}): Promise<PublishedRow & { superseded: boolean }> {
  const { workspace, env, workspaceId, existing, bytes, digest } = input;
  const timestamp = nowIso();
  const objectRef = `${env.AVALON_REGION}/${workspaceId}/resources/${existing.id}/${input.objectSource === "terminal" ? "terminal" : "published"}/${digest}/${newId()}`;
  let previousMetadata: Record<string, unknown> = {};
  try { previousMetadata = JSON.parse(existing.metadata_json) as Record<string, unknown>; } catch { /* legacy metadata */ }
  const description = input.description ?? (typeof previousMetadata.description === "string"
    ? previousMetadata.description
    : undefined);
  // A revision that names no title keeps the one participants already know the
  // document by. One that repeats its old name keeps a person's rename
  // (`AGENT_RESOURCE_TITLE_SQL`).
  const title = input.displayName?.trim()
    ? [...input.displayName.trim()].slice(0, 300).join("")
    : null;
  const metadata = JSON.stringify({
    sourcePath: input.sourcePath,
    size: bytes.byteLength,
    attachmentKind: input.attachmentKind,
    contentMode: input.contentMode,
    ...input.receipt,
    ...(description ? { description } : {}),
  });
  await putStagedResourceObject({
    database: workspace,
    payloads: env.PAYLOADS,
    objectRef,
    workspaceId,
    resourceId: existing.id,
    objectKind: "original",
    value: bytes,
    options: {
      httpMetadata: { contentType: input.mimeType },
      customMetadata: { source: input.objectSource, sourcePath: input.sourcePath },
    },
    at: timestamp,
  });
  const author = authorColumns(input.author);
  let swapped: PublishedRow | null;
  try {
    swapped = await workspace.prepare(
      `UPDATE resources
          SET title = ${AGENT_RESOURCE_TITLE_SQL}, mime_type = ?, content_ref = ?, content_sha256 = ?, metadata_json = ?,
              updated_at = ?,
              model_content_ref = NULL, model_mime_type = NULL, model_content_sha256 = NULL,
              model_metadata_json = NULL, model_content_status = ?,
              model_content_extractor_version = NULL, model_content_character_count = NULL,
              model_content_extracted_at = NULL, model_content_claimed_at = NULL,
              model_content_claim_id = NULL, model_content_error_code = NULL,
              revision_author_kind = ?, revision_author_run_id = ?,
              revision_author_user_id = ?, revision_author_connection_id = NULL,
              revision_cause = 'published', revision_on_behalf_of_user_id = ?
        WHERE id = ? AND workspace_id = ? AND content_ref IS ? AND content_sha256 IS ?
      RETURNING id, title, mime_type, content_ref, content_sha256, metadata_json,
                model_content_status, created_at`,
    ).bind(
      title, title, title,
      input.mimeType, objectRef, digest, metadata, timestamp, input.derivativeStatus,
      author.kind, author.runId, author.userId, author.onBehalfOf,
      existing.id, workspaceId, existing.content_ref, existing.content_sha256,
    ).first<PublishedRow>();
  } catch (error) {
    // A failed WorkspaceDO response is not evidence that its transaction
    // failed. Keep the staged bytes so a pointer that committed before the
    // response was lost can never name a deleted object.
    publicationFailure(error, "swap");
  }
  // The row is the witness, not a write counter: `meta.changes` on a
  // WorkspaceDO-routed statement counts the version triggers' writes too
  // (`docs/durable-object-sqlite.md`).
  if (swapped?.content_ref !== objectRef) {
    // Another publish advanced the pointer first. Its content is current;
    // release this call's bytes and report what the document now holds,
    // marked `superseded` so a caller with more to activate (a site's
    // registry and serving pointer) stops rather than activating the loser.
    await releaseStagedResourceObject(workspace, workspaceId, objectRef).catch(() => undefined);
    const current = await workspace.prepare(
      `SELECT id, title, mime_type, content_ref, content_sha256, metadata_json,
              model_content_status, created_at
         FROM resources WHERE id = ? AND workspace_id = ?`,
    ).bind(existing.id, workspaceId).first<PublishedRow>();
    if (current) return { ...current, superseded: true };
    throw new PublicationWriteFailed("swap");
  }
  await settleStagedObject(workspace, workspaceId, objectRef);
  return { ...swapped, superseded: false };
}
