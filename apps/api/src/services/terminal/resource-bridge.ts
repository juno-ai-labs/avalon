import type { HarnessToolContext } from "@rally/agent-harness";
import {
  AttachmentKindSchema,
  type ArtifactManifest,
  ArtifactManifestSchema,
  type ArtifactHostnameStub,
  SITE_MANIFEST_MIME_TYPE,
  artifactOrigin,
  classifyAttachmentKind,
  ResourceSchema,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../../env";
import { numericEnv } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import { verifyAttachmentMimeType } from "../attachment-mime-verification";
import {
  attachWorkstreamRuntimeResource,
  type WorkstreamRuntimeResourceAttacher,
} from "../workstream-object-client";
import { createConversationResourceLinks, createResourceObjectPort } from "../../runtime/resource-port";
import { allocateResourceSlugBesideCreation } from "../resource-slug";
import { ensureArtifactHostname } from "../artifact-hostname";
import { putStagedResourceObject, releaseStagedResourceObject } from "../resource-object-cleanup";
import {
  loadVisibleWorkstreamResourcesByIds,
  type VisibleWorkstreamResourceRow,
} from "../workstream-resource-visibility";
import { TERMINAL_OUTPUT_DIRECTORY } from "./contract";
import type { TerminalPortFactory } from "./object-port";
import {
  terminalShellQuote as shellQuote,
  type TerminalSandboxProvider,
} from "./provider-contract";
import type { TerminalResourceBridge } from "./runtime";
import {
  importTreeFailure,
  materializeTreeCommand,
  readArtifactVersionFiles,
} from "./site-import";
import {
  existingArtifactForResource,
  pointArtifactAtVersion,
  registerArtifact,
  writeArtifactVersion,
} from "./site-resource-bridge";
import {
  requireTerminalEffectIntent,
  TerminalToolError,
  type TerminalImportResourceOutput,
  type TerminalPublishedResourceOutput,
  type TerminalPublishedSiteOutput,
} from "./tools";
import { AGENT_RESOURCE_TITLE_SQL } from "../agent-resource-title";

/** One captured revision, as `resource_versions` holds it. */
interface VersionRow extends Record<string, unknown> {
  title: string;
  mime_type: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  metadata_json: string;
  model_content_status: string | null;
  captured_at: string;
  author_run_id: string | null;
}

interface PublishedRow {
  id: string;
  title: string;
  mime_type: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  metadata_json: string;
  model_content_status: string | null;
  created_at: string;
}

/** A site's row also carries its alias, which the publish result reports. */
interface PublishedSiteRow extends PublishedRow {
  slug: string | null;
}

function fileName(path: string): string {
  return path.split("/").at(-1) || "resource";
}

/**
 * Where a site publishes from, spelled as an `import_resource` destination, or
 * `null` when the row cannot say.
 *
 * The two tools measure paths from different roots — publication from
 * `$AVALON_RESOURCE_DIR`, every other path from the workspace root — so the
 * round trip only closes if the suggestion carries the output directory.
 *
 * Both sources are the site's real identity: `metadata_json.sourcePath`, and
 * the path half of `provider_resource_id`, which *is* what a republish is keyed
 * to. There is deliberately no generic fallback. A guess like
 * `.rally-output/site` reads as an answer and is one for the model, which would
 * then publish to a path that mints a second site at a second URL — the exact
 * failure the refusal exists to prevent. A row that can name neither gets no
 * suggestion and says so.
 */
function sitePublishPath(row: VisibleWorkstreamResourceRow): string | null {
  let sourcePath: string | null = null;
  try {
    const metadata = JSON.parse(row.metadata_json ?? "{}") as { sourcePath?: unknown };
    if (typeof metadata.sourcePath === "string" && metadata.sourcePath) sourcePath = metadata.sourcePath;
  } catch {
    // A row whose metadata will not parse still has its identity below.
  }
  if (!sourcePath) {
    const identity = typeof row.provider_resource_id === "string" ? row.provider_resource_id : "";
    const match = /^terminal:[^:]+:(?!sha256:)(.+)$/su.exec(identity);
    // The digest form deliberately does not round-trip: it exists because the
    // path was too long to store, and `sourcePath` is where the readable value
    // lives for exactly those rows.
    sourcePath = match?.[1] ?? null;
  }
  return sourcePath ? `${TERMINAL_OUTPUT_DIRECTORY}/${sourcePath}` : null;
}

/**
 * The published path as the document's identity reads it.
 *
 * `publish_resource` already resolves its argument to this shape, so
 * for a model-driven publish this is the identity function. It is applied
 * anyway because the identity has to be one derivation rather than a promise
 * that every caller normalized first: `docs/./plan.md` and `docs/plan.md` are
 * the same file beneath the resource directory, and a document whose rail entry
 * depends on which spelling a call used is the sibling problem again.
 */
function normalizePublishPath(path: string): string {
  return path.split("/").filter((segment) => segment && segment !== ".").join("/");
}

async function storedArtifactHasSocialPreview(
  env: Pick<Env, "PAYLOADS">,
  manifestRef: string | null,
): Promise<boolean> {
  if (!manifestRef) return false;
  const object = await env.PAYLOADS.get(manifestRef);
  if (!object) return false;
  try {
    const bytes = new Uint8Array(await object.arrayBuffer());
    const manifest = ArtifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    return manifest.socialPreview !== undefined;
  } catch {
    return false;
  }
}

/**
 * A published document's identity, bounded by the contract that publishes it.
 *
 * The path half is model-chosen and the tool accepts 4,096 characters of it,
 * while `ResourceSchema` bounds `providerResourceId` at 500 — so the readable
 * form is only safe while it fits. It is not a cosmetic overflow: the identity
 * is projected into `GET /workstreams/:id` and `GET /resources`, so one row
 * past the bound stops the work stream opening at all and fails the workspace's
 * resource list, and nothing in the product deletes a published row to recover.
 *
 * Past the bound the path is replaced by its digest rather than truncated.
 * Truncating would map two different long paths onto one document; the digest
 * keeps identity one-to-one with the path, which is the whole point of scoping
 * it to the path. `metadata_json.sourcePath` still carries the readable value.
 */
const PUBLISHED_IDENTITY_MAXIMUM = ResourceSchema.shape.providerResourceId.unwrap().maxLength ?? 500;

async function publishedResourceIdentity(workstreamId: string, filePath: string, substreamId = "0"): Promise<string> {
  const owner = substreamId === "0" ? workstreamId : `${workstreamId}:substream:${substreamId}`;
  const readable = `terminal:${owner}:${normalizePublishPath(filePath)}`;
  if (readable.length <= PUBLISHED_IDENTITY_MAXIMUM) return readable;
  const digest = await sha256Hex(new TextEncoder().encode(normalizePublishPath(filePath)));
  return `terminal:${owner}:sha256:${digest}`;
}

function publishedOutput(row: PublishedRow, sizeBytes: number): TerminalPublishedResourceOutput {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { /* legacy metadata */ }
  const attachmentKind = AttachmentKindSchema.safeParse(metadata.attachmentKind);
  const contentMode = metadata.contentMode === "read" || metadata.contentMode === "view" || metadata.contentMode === "unsupported"
    ? metadata.contentMode
    : "unsupported";
  if (!row.content_sha256 || !/^[0-9a-f]{64}$/u.test(row.content_sha256)) {
    throw new TerminalToolError(
      "resource_publish_failed",
      "Rally could not verify the previously published resource identity. Retry publish_resource with the stable final file.",
      { reason: "Retry the same publish_resource call so Rally can reconcile its resource identity." },
    );
  }
  return {
    resourceId: row.id,
    title: row.title,
    publishKind: "file" as const,
    resourceType: "generated_file" as const,
    provider: "avalon_generated" as const,
    mimeType: row.mime_type ?? "application/octet-stream",
    sizeBytes,
    sourceSha256: row.content_sha256,
    attachmentKind: attachmentKind.success ? attachmentKind.data : "other",
    contentMode,
    derivativeStatus: row.model_content_status === "ready" || row.model_content_status === "unsupported"
      ? row.model_content_status
      : "pending",
    createdAt: row.created_at,
  };
}

/**
 * Swap a republished document's content onto the row it already has.
 *
 * The shape is the connector re-fetch path's: pre-register the new object in
 * the cleanup outbox, write it, then compare-and-swap the pointer against the
 * one that was read, so a lost race deletes the object it wrote rather than
 * overwriting a newer publish. What the swap does *not* do is destroy the old
 * bytes — WorkspaceDO's version triggers capture the superseded state and the
 * reaper treats a ref a version still names as active, so a revision keeps its
 * predecessor readable instead of replacing the only copy.
 */
async function swapPublishedContent(input: {
  workspace: D1Database;
  env: Env;
  workspaceId: string;
  existing: PublishedRow;
  filePath: string;
  displayName?: string | undefined;
  description?: string | undefined;
  bytes: Uint8Array;
  digest: string;
  mimeType: string;
  attachmentKind: string;
  contentMode: string;
  derivativeStatus: string;
  harnessRunId: string;
  /** The person the run acts for, when a person started it. */
  onBehalfOfUserId: string | null;
  effectIntentId: string;
  publicationEventType: "resource_attached" | "resource_updated";
}): Promise<PublishedRow> {
  const { workspace, env, workspaceId, existing, bytes, digest } = input;
  const timestamp = nowIso();
  const objectRef = `${env.AVALON_REGION}/${workspaceId}/resources/${existing.id}/terminal/${digest}/${newId()}`;
  let previousMetadata: Record<string, unknown> = {};
  try { previousMetadata = JSON.parse(existing.metadata_json) as Record<string, unknown>; } catch { /* legacy metadata */ }
  const description = input.description ?? (typeof previousMetadata.description === "string"
    ? previousMetadata.description
    : undefined);
  // A revision that names no title keeps the one participants already know the
  // document by; renaming it silently on every republish would be worse than
  // ignoring the argument. One that repeats its old name keeps a person's
  // rename (`AGENT_RESOURCE_TITLE_SQL`).
  const title = input.displayName?.trim()
    ? [...input.displayName.trim()].slice(0, 300).join("")
    : null;
  const metadata = JSON.stringify({
    sourcePath: input.filePath,
    size: bytes.byteLength,
    attachmentKind: input.attachmentKind,
    contentMode: input.contentMode,
    publicationEffectIntentId: input.effectIntentId,
    publicationEventType: input.publicationEventType,
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
      customMetadata: { source: "terminal", sourcePath: input.filePath },
    },
    at: timestamp,
  });
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
              revision_author_kind = 'agent', revision_author_run_id = ?,
              revision_author_user_id = NULL, revision_author_connection_id = NULL,
              revision_cause = 'published', revision_on_behalf_of_user_id = ?
        WHERE id = ? AND workspace_id = ? AND content_ref IS ? AND content_sha256 IS ?
      RETURNING id, title, mime_type, content_ref, content_sha256, metadata_json,
                model_content_status, created_at`,
    ).bind(
      title,
      title,
      title,
      input.mimeType,
      objectRef,
      digest,
      metadata,
      timestamp,
      input.derivativeStatus,
      input.harnessRunId,
      input.onBehalfOfUserId,
      existing.id,
      workspaceId,
      existing.content_ref,
      existing.content_sha256,
    ).first<PublishedRow>();
  } catch {
    // The insert path below converts its failures the same way; a raw D1 error
    // here would reach the model as the generic terminal_tool_failed with no
    // retry guidance, for the same operation.
    // A failed WorkspaceDO response is not evidence that its transaction
    // failed. Keep the staged bytes so a pointer that committed before the
    // response was lost can never name a deleted object.
    throw new TerminalToolError(
      "resource_publish_failed",
      "The published document could not be updated. Retry publish_resource with the stable final file.",
      { reason: "Retry the same publish_resource call so Rally can reconcile its resource identity." },
    );
  }
  // The row itself is the witness, not a write counter. `meta.changes` on a
  // WorkspaceDO-routed statement is workerd's physical `rowsWritten`, which this
  // UPDATE inflates through three version triggers — see
  // `docs/durable-object-sqlite.md`, which requires a returned witness here.
  if (swapped?.content_ref !== objectRef) {
    // Another publish of this document advanced the pointer first. Its content
    // is the current one; release this call's bytes to asynchronous cleanup and
    // report what the document now holds rather than clobbering the winner.
    await releaseStagedResourceObject(workspace, workspaceId, objectRef)
      .catch(() => undefined);
    const current = await workspace.prepare(
      `SELECT id, title, mime_type, content_ref, content_sha256, metadata_json,
              model_content_status, created_at
         FROM resources WHERE id = ? AND workspace_id = ?`,
    ).bind(existing.id, workspaceId).first<PublishedRow>();
    if (current) return current;
    throw new TerminalToolError(
      "resource_publish_failed",
      "The published document could not be updated. Retry publish_resource with the stable final file.",
      { reason: "Retry the same publish_resource call so Rally can reconcile its resource identity." },
    );
  }
  // `resources_track_original_after_update` already cancelled this object's
  // pending deletion inside the same statement and enqueued the superseded one,
  // which `resource_versions` then keeps alive. This delete is the belt for a
  // caller whose schema predates those triggers.
  await workspace.prepare(
    `DELETE FROM resource_object_deletion_outbox
      WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
  ).bind(workspaceId, objectRef).run().catch(() => undefined);
  return swapped;
}

export function createTerminalResourceBridge(
  env: Env,
  terminalPort: TerminalPortFactory,
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
  /**
   * Where a published document belongs, when that is not the conversation the
   * run is executing in.
   *
   * A work-stream-scoped Sidekick runs in its own conversation under the
   * automation, with the Sidekick's shared sandbox and its own transcript, but the documents
   * it publishes are the owning room's: "refresh the dashboard" means the
   * dashboard that room already has. Without this the publish identity is
   * `terminal:<automation-id>:<path>`, which can never collide with the room's
   * `terminal:<room-id>:<path>`, so every run created a private fork at v1 and
   * the room's copy was never touched again.
   *
   * The sandbox stays with the Sidekick's authoring conversation. Imports
   * resolve the live authorized resource scope independently of publication;
   * a publication target is not an access grant.
   */
  publicationHome?: (() => Promise<{ parentId: string; substreamId: string } | null>) | null,
  /**
   * The conversation this run executes in, when it is not the one whose
   * object holds the sandbox: a background agent importing into its owner's
   * sandbox. Recorded on each import so the revocation check reads the
   * import's authorization from the conversation whose attachment gave it,
   * which is this run's own, rather than from the sandbox's.
   */
  importingSubstreamId?: string | null,
  /**
   * The person who asked for this run (`runRequesterUserId`), recorded on each
   * revision it publishes so the revision is never news to them. Null for a
   * Sidekick run, whose principal nobody asked to act.
   */
  onBehalfOfUserId: string | null = null,
  publicationSubstreamId = "0",
): TerminalResourceBridge {
  // The layered runtime database routes resource rows to WorkspaceDO and
  // tool/link rows to SubstreamAgent. Keep every statement single-authority;
  // no query may join across those object-local databases.
  const workspace = env.DB;
  const attachResource = inObjectResourceAttacher
    ?? ((input) => attachWorkstreamRuntimeResource(env, input));
  /**
   * Where a publication belongs.
   *
   * Redirected only for a document the model published from a path. An
   * internal capture names its own namespace instead — a command log
   * (`terminal-command-log:…`) or a checkout backup — and those are recovery
   * artifacts the run never chose to deliver. Redirecting one would put raw
   * command output in the owning room's resource list, disclosure the Sidekick
   * did not ask for and its delivered result deliberately excluded, so an
   * internal capture stays in the conversation that produced it.
   */
  const publicationAddress = async (
    context: { workstreamId: string },
    internalProviderResourceId?: string,
  ) => {
    // Internal captures stay local and require no access to the home.
    const home = internalProviderResourceId === undefined ? await publicationHome?.() : null;
    return home ?? { parentId: context.workstreamId, substreamId: publicationSubstreamId };
  };
  const assertExistingPublicationVisible = async (context: HarnessToolContext, target: { parentId: string; substreamId: string },
    row: Pick<PublishedRow, "id" | "metadata_json"> | null) => {
    if (!row || !publicationHome) return;
    // A response-lost insert may precede its link. Only that exact receipt may repair it.
    let metadata: { publicationEffectIntentId?: string } = {};
    try { metadata = JSON.parse(row.metadata_json) as typeof metadata; } catch { /* legacy metadata */ }
    if (context.effectIntentId && metadata.publicationEffectIntentId === context.effectIntentId) return;
    const visible = await createConversationResourceLinks(env, context.workspaceId, target.parentId, undefined,
      target.substreamId, context.executionPrincipal).links({ resourceIds: [row.id] });
    if (!visible.links.some((link) => link.resource_id === row.id)) {
      throw new TerminalToolError("resource_not_found", "The existing publication is not attached to this destination. Restore its attachment before updating it.");
    }
  };
  const publicationSelect = `SELECT id, title, mime_type, content_ref, content_sha256, metadata_json,
      model_content_status, created_at, slug, resource_type FROM resources
      WHERE workspace_id = ? AND provider = 'avalon_generated' AND provider_resource_id = ?`;
  const publicationRow = (workspaceId: string, providerResourceId: string) => workspace.prepare(publicationSelect)
    .bind(workspaceId, providerResourceId).first<PublishedSiteRow & { resource_type: string }>();
  const existingPublication = async (context: HarnessToolContext, target: { parentId: string; substreamId: string },
    filePath: string, providerResourceId: string) => {
    const current = await publicationRow(context.workspaceId, providerResourceId);
    if (current) {
      await assertExistingPublicationVisible(context, target, current);
      return current;
    }
    // Wizards formerly published under the Sidekick ID. Keep an admitted legacy
    // publication's resource and URL when the home has no publication at this path.
    if (publicationHome && target.parentId !== context.workstreamId) {
      const legacy = await publicationRow(context.workspaceId, await publishedResourceIdentity(context.workstreamId, filePath));
      if (legacy) {
        await assertExistingPublicationVisible(context, { parentId: context.workstreamId,
          substreamId: importingSubstreamId ?? publicationSubstreamId }, legacy);
        return legacy;
      }
    }
    return null;
  };
  /**
   * Link a published document to the work stream that owns it, and to the one
   * that produced it when those differ.
   *
   * Both, not either. The owning room is where the document belongs and where a
   * reader looks for it. But visibility is resolved from the links held by the
   * object a run executes in (`loadVisibleRows` starts at `attachedLinks`), so
   * a redirected document linked only to the room is one its own run cannot
   * read back: `publish_resource` then `import_resource` on the id just
   * returned would answer `resource_not_found`, which is the natural shape of
   * "refresh the document" and worked before the redirect existed.
   *
   * The in-object attacher writes through the object this run executes in,
   * which is the right door for the producing half only. The owning room is a
   * different object and takes the ordinary cross-object path.
   */
  const attachPublication = async (
    context: { workspaceId: string; workstreamId: string },
    input: {
      resourceId: string;
      attachedByUserId: string | null;
      eventType?: "resource_attached" | "resource_updated";
    },
    target: { parentId: string; substreamId: string },
  ) => {
    const workstreamId = target.parentId;
    await (workstreamId === context.workstreamId
      ? attachResource({ workspaceId: context.workspaceId, workstreamId, ...input })
      : attachWorkstreamRuntimeResource(env, {
        workspaceId: context.workspaceId,
        workstreamId,
        substreamId: target.substreamId,
        ...input,
      }));
    if (workstreamId === context.workstreamId) return;
    await attachResource({
      workspaceId: context.workspaceId,
      workstreamId: context.workstreamId,
      ...input,
    });
  };
  /**
   * Materialize a published site's own source back into the sandbox.
   *
   * This is the half of the revision loop that was specified and never
   * connected. `site-import.ts` has read a version's files out of the bucket
   * and staged the tree since sites shipped, `import_resource` has documented
   * `destinationPath` as a site's directory root and `overwrite` as whole-tree
   * replacement, and the sites skill tells a run to re-import before editing —
   * but nothing called any of it, so a site fell through to the single-file
   * path below and the model received the manifest that indexes the site
   * instead of the site. A run could then only rewrite from memory and
   * republish, which is not a revision of what is being served.
   *
   * The version imported is the one the resource points at, not whatever an
   * earlier sandbox happened to hold, so an edit starts from what viewers see.
   */
  const importSiteTree = async (
    context: HarnessToolContext,
    row: VisibleWorkstreamResourceRow,
    destination: string,
    overwrite: boolean,
    sandboxGeneration: number,
    providerSandboxId: string,
    provider: TerminalSandboxProvider,
  ): Promise<TerminalImportResourceOutput> => {
    const stored = row.content_ref ? await env.PAYLOADS.get(row.content_ref) : null;
    if (!stored) {
      throw new TerminalToolError(
        "resource_not_importable",
        "This site's manifest is temporarily unavailable. Retry the import; the site keeps serving its current version either way.",
        { reason: "Retry the import once." },
      );
    }
    const manifestBytes = new Uint8Array(await stored.arrayBuffer());
    // A site's `content_sha256` is publication's digest over the *file list*,
    // not over the manifest bytes — the manifest carries a version number and a
    // timestamp, so hashing it would make every republish look like a content
    // change. The durable import record stores the digest publication stored,
    // which is what identifies the version that was materialized.
    //
    // There is no fallback. Hashing the manifest instead would record a value
    // nothing in the product can compare against, which is worse than refusing:
    // publication writes this column on every site and `publishedOutput`
    // already refuses a published row without it, so a site that reaches here
    // without one is malformed rather than merely old.
    const digest = row.content_sha256;
    if (!digest) {
      throw new TerminalToolError(
        "resource_not_importable",
        "Rally could not verify which version of this site is published, so it cannot reconstruct its source. Publish a fresh directory at the site's path to replace it.",
        { reason: "Publish a fresh directory at the site's path." },
      );
    }
    let manifest: ArtifactManifest;
    try {
      manifest = ArtifactManifestSchema.parse(
        JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
      );
    } catch {
      throw new TerminalToolError(
        "resource_not_importable",
        "This site's manifest could not be read, so Rally cannot reconstruct its source. Publish a fresh directory at the site's path to replace it.",
        { reason: "Publish a fresh directory at the site's path." },
      );
    }
    // Throws `resource_not_importable` for a version whose bytes are gone,
    // rather than materializing part of a tree.
    const files = await readArtifactVersionFiles(env, manifest);
    const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
    const absolute = `/workspace/${destination}`;
    const staging = `/workspace/.rally/tmp/${newId()}`;
    const cleanupStaging = async (): Promise<void> => {
      await provider.runUtilityCommand(providerSandboxId, {
        operation: "file.temp_cleanup",
        command: `rm -rf -- ${shellQuote(staging)}`,
        cwd: "/workspace",
        timeoutMs: 10_000,
      }).catch(() => undefined);
    };
    // One command, not one per directory: it makes every staging parent the
    // uploads need and reports what is already at the destination — which
    // separates a created import from a replacing one, and decides the two
    // refusals below.
    const parents = [...new Set(files
      .map((file) => file.path.split("/").slice(0, -1).join("/"))
      .filter(Boolean))];
    const prepared = await provider.runUtilityCommand(providerSandboxId, {
      operation: "resource.import.stage",
      command: [
        `staging=${shellQuote(staging)}`,
        `destination=${shellQuote(absolute)}`,
        `mkdir -p -- "$staging"${parents.map((parent) => ` "$staging"/${shellQuote(parent)}`).join("")} || exit 46`,
        'if [ -e "$destination" ] && [ ! -d "$destination" ]; then printf "occupied\\n"',
        'elif [ -d "$destination" ] && [ -n "$(ls -A "$destination" 2>/dev/null)" ]; then printf "exists\\n"',
        'fi',
      ].join("\n"),
      cwd: "/workspace",
      timeoutMs: 30_000,
    });
    if (prepared.exitCode !== 0) {
      await cleanupStaging();
      throw new TerminalToolError(
        "resource_import_failed",
        "The site's files could not be staged in the workspace. Retry the import.",
        { reason: "Retry the import." },
      );
    }
    const occupancy = prepared.stdout.trim();
    // Both refusals happen here, before any durable row and before a byte
    // moves. `materializeTreeCommand` raises the same two conditions as its own
    // last guard, but reaching them there would mean a `planned` import row
    // already existed for a call that changed nothing — and the next
    // acquisition reads any row that is not `completed` as a revoked import,
    // which replaces the sandbox and discards the work stream's files. A
    // refusal must cost nothing.
    if (occupancy === "occupied" || (occupancy === "exists" && !overwrite)) {
      await cleanupStaging();
      throw importTreeFailure(occupancy === "occupied" ? 45 : 44)!;
    }
    const replaced = occupancy === "exists";
    const plannedAt = Date.now();
    await terminalPort(context.workspaceId, context.workstreamId)
      .recordImportedResource({
        sandboxGeneration,
        resourceId: row.id,
        destinationPath: destination,
        sourceSha256: digest,
        sizeBytes: totalBytes,
        state: "planned",
        importedAt: null,
        attachedSubstreamId: importingSubstreamId ?? null,
        now: plannedAt,
      });
    try {
      for (const file of files) {
        await provider.writeFile(
          providerSandboxId,
          `${staging}/${file.path}`,
          file.bytes,
          context.signal,
        );
      }
    } catch (error) {
      await cleanupStaging();
      throw error;
    }
    const materialized = await provider.runUtilityCommand(providerSandboxId, {
      operation: "resource.import.finalize",
      command: materializeTreeCommand({ destination: absolute, staging, overwrite }),
      cwd: "/workspace",
      timeoutMs: 60_000,
    });
    const failure = importTreeFailure(materialized.exitCode);
    if (failure) {
      await cleanupStaging();
      throw failure;
    }
    const written = Number(materialized.stdout.trim());
    if (!Number.isSafeInteger(written) || written !== files.length) {
      await cleanupStaging();
      throw new TerminalToolError(
        "resource_import_failed",
        "Daytona did not confirm every file of the site's source. Retry the import before editing, so a partial tree is not republished as a version.",
        { reason: "Retry the import before editing the site." },
      );
    }
    const importedAt = Date.now();
    await terminalPort(context.workspaceId, context.workstreamId)
      .completeImportedResource({
        sandboxGeneration,
        resourceId: row.id,
        destinationPath: destination,
        sourceSha256: digest,
        importedAt,
        now: importedAt,
      });
    return {
      resourceId: row.id,
      filePath: destination,
      outcome: replaced ? "replaced" : "created",
      mimeType: row.mime_type ?? SITE_MANIFEST_MIME_TYPE,
      sizeBytes: totalBytes,
      sourceSha256: digest,
      fileCount: files.length,
    };
  };
  return {
    async importResource(context, input, destinationPath, sandboxGeneration, providerSandboxId, provider) {
      const rows = await loadVisibleWorkstreamResourcesByIds(
        env.DB,
        createConversationResourceLinks(env, context.workspaceId, context.workstreamId, undefined, importingSubstreamId ?? undefined, context.executionPrincipal),
        {
          workspaceId: context.workspaceId,
          workstreamId: context.workstreamId,
          principal: context.executionPrincipal,
          resourceIds: [input.resourceId],
        },
      );
      const row = rows[0];
      if (!row) {
        throw new TerminalToolError(
          "resource_not_found",
          "resourceId could not be read. Check the Rally resource ID and this run's access. Sidekicks can import a known resource their execution user can read without attaching it first. Use list_resources to discover other resources.",
          { field: "resourceId", reason: "Check the Rally resource ID and the execution user's current read access." },
        );
      }
      if (row.resource_type === "generated_site") {
        // Deterministic placement exists to give a *file* import provenance: a
        // fixed path, a digest, and a reuse when they match. A tree has no
        // single body to match, and the path a site wants is not Rally's to
        // pick anyway — it is the one the site publishes from, because
        // republishing that path is what updates this site rather than minting
        // a second one at a second URL.
        if (!("destinationPath" in input)) {
          const suggestion = sitePublishPath(row);
          throw new TerminalToolError(
            "destination_required",
            suggestion
              ? `Importing a site needs an explicit destinationPath naming the directory to materialize its files into. Use ${suggestion}, then publish that same path to update this site; a different path would mint a second site at a second URL.`
              : "Importing a site needs an explicit destinationPath naming the directory to materialize its files into. Rally cannot recover the path this site publishes from, so choose the one this work stream last published it from — publishing a different path would mint a second site at a second URL.",
            {
              field: "destinationPath",
              reason: suggestion
                ? `Retry with destinationPath: "${suggestion}".`
                : "Retry with the destinationPath this site was published from.",
            },
          );
        }
        return importSiteTree(
          context,
          row,
          destinationPath,
          input.overwrite === true,
          sandboxGeneration,
          providerSandboxId,
          provider,
        );
      }
      if (!row.content_ref) {
        throw new TerminalToolError(
          "resource_not_importable",
          "The resource has no stored bytes yet. Hydrate or download it with its connector tool, then retry import_resource.",
          { reason: "Hydrate or download the source with its connector tool, then retry the import." },
        );
      }
      const object = await env.PAYLOADS.get(row.content_ref);
      if (!object) {
        throw new TerminalToolError(
          "resource_not_importable",
          "The resource bytes are temporarily unavailable. Retry the import; if it persists, reattach the source resource.",
          { reason: "Retry once; if bytes remain unavailable, reattach the source resource." },
        );
      }
      const maximum = numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000);
      if (Number.isFinite(object.size) && object.size > maximum) {
        throw new TerminalToolError("resource_limit_exceeded", `The resource is ${object.size} bytes; Terminal imports allow at most ${maximum}. Publish or attach a smaller source file.`, { field: "resourceId", expected: `resource bytes at most ${maximum}` });
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength > maximum) {
        throw new TerminalToolError("resource_limit_exceeded", `The resource is ${bytes.byteLength} bytes; Terminal imports allow at most ${maximum}. Publish or attach a smaller source file.`, { field: "resourceId", expected: `resource bytes at most ${maximum}` });
      }
      const digest = await sha256Hex(bytes);
      if (row.content_sha256 && digest !== row.content_sha256) {
        throw new TerminalToolError(
          "resource_hash_mismatch",
          "The stored resource bytes changed while importing. Re-list the work-stream resources and retry from the current version.",
          { reason: "Re-list work-stream resources and retry the import from its current version." },
        );
      }
      const automatic = !("destinationPath" in input);
      // The runtime resolved this exact path inside /workspace, including
      // symlink containment. Never derive a sibling path from untrusted title
      // metadata after that check.
      const destination = destinationPath;
      const absolute = `/workspace/${destination}`;
      const existence = await provider.runUtilityCommand(providerSandboxId, {
        operation: "resource.import.inspect",
        command: [
          `target='${absolute.replace(/'/gu, `'"'"'`)}'`,
          'if [ ! -e "$target" ]; then exit 44; fi',
          'if [ -L "$target" ] || [ ! -f "$target" ]; then exit 45; fi',
          'size=$(stat -c %s -- "$target") || exit 46',
          'digest=$(sha256sum -- "$target" | cut -d " " -f 1) || exit 46',
          'printf "%s %s\\n" "$size" "$digest"',
        ].join("\n"),
        cwd: "/workspace",
        timeoutMs: 10_000,
      });
      if (existence.exitCode === 0) {
        if (automatic) {
          const existing = /^(\d+) ([0-9a-f]{64})\s*$/u.exec(existence.stdout);
          if (!existing || Number(existing[1]) !== bytes.byteLength || existing[2] !== digest) {
            throw new TerminalToolError(
              "destination_exists",
              "The deterministic import path already contains different bytes. Do not overwrite it; start a fresh Terminal workspace so Rally can re-establish resource provenance.",
              { reason: "Start a fresh Terminal workspace so Rally can re-establish automatic import provenance." },
            );
          }
          const timestamp = Date.now();
          await terminalPort(context.workspaceId, context.workstreamId)
            .recordImportedResource({
              sandboxGeneration,
              resourceId: row.id,
              destinationPath: destination,
              sourceSha256: digest,
              sizeBytes: bytes.byteLength,
              state: "completed",
              importedAt: timestamp,
              attachedSubstreamId: importingSubstreamId ?? null,
              now: timestamp,
            });
          return {
            resourceId: row.id,
            filePath: destination,
            outcome: "reused",
            mimeType: row.mime_type ?? "application/octet-stream",
            sizeBytes: bytes.byteLength,
            sourceSha256: digest,
          };
        }
        if (!input.overwrite) {
          throw new TerminalToolError(
            "destination_exists",
            "The destination already exists. Choose another destinationPath or retry with overwrite: true after verifying that replacement is intended.",
            { reason: "Choose another destinationPath, or use overwrite: true only after confirming replacement." },
          );
        }
      }
      if (existence.exitCode !== 0 && existence.exitCode !== 44) {
        throw new TerminalToolError(
          "destination_not_regular",
          "The destination exists but is not a regular file Rally can safely replace. Choose a different destinationPath and retry.",
          { reason: "Choose a destinationPath that is absent or names a regular file beneath the Terminal workspace." },
        );
      }
      const plannedAt = Date.now();
      await terminalPort(context.workspaceId, context.workstreamId)
        .recordImportedResource({
          sandboxGeneration,
          resourceId: row.id,
          destinationPath: destination,
          sourceSha256: digest,
          sizeBytes: bytes.byteLength,
          state: "planned",
          importedAt: null,
          attachedSubstreamId: importingSubstreamId ?? null,
          now: plannedAt,
        });
      const parent = absolute.slice(0, Math.max(absolute.lastIndexOf("/"), 1));
      const temporary = `/workspace/.rally/tmp/${newId()}`;
      await provider.writeFile(providerSandboxId, temporary, bytes, context.signal);
      let verified: Awaited<ReturnType<TerminalSandboxProvider["runUtilityCommand"]>>;
      try {
        verified = await provider.runUtilityCommand(providerSandboxId, {
          operation: "resource.import.finalize",
          command: [
            `target='${absolute.replace(/'/gu, `'"'"'`)}'`,
            `temporary='${temporary.replace(/'/gu, `'"'"'`)}'`,
            'trap \'rm -f -- "$temporary"\' EXIT',
            `mkdir -p -- '${parent.replace(/'/gu, `'"'"'`)}' || exit 46`,
            'mv -- "$temporary" "$target" || exit 46',
            "trap - EXIT",
            'printf "%s %s\\n" "$(stat -c %s -- "$target")" "$(sha256sum -- "$target" | cut -d " " -f 1)"',
          ].join("\n"),
          cwd: "/workspace",
          timeoutMs: 30_000,
        });
      } catch (error) {
        await provider.runUtilityCommand(providerSandboxId, {
          operation: "file.temp_cleanup",
          command: `rm -f -- '${temporary.replace(/'/gu, `'"'"'`)}'`,
          cwd: "/workspace",
          timeoutMs: 10_000,
        }).catch(() => undefined);
        throw error;
      }
      const observed = /^(\d+) ([0-9a-f]{64})\s*$/u.exec(verified.stdout);
      if (verified.exitCode !== 0 || !observed || Number(observed[1]) !== bytes.byteLength || observed[2] !== digest) {
        throw new TerminalToolError(
          "resource_import_failed",
          "Daytona did not confirm the imported bytes. Start a fresh Terminal workspace before retrying so unverified bytes cannot be reused.",
          { reason: "Start a fresh Terminal workspace before retrying the import." },
        );
      }
      const importedAt = Date.now();
      await terminalPort(context.workspaceId, context.workstreamId)
        .completeImportedResource({
          sandboxGeneration,
          resourceId: row.id,
          destinationPath: destination,
          sourceSha256: digest,
          importedAt,
          now: importedAt,
        });
      return {
        resourceId: row.id,
        filePath: destination,
        outcome: existence.exitCode === 0 ? "replaced" : "created",
        mimeType: row.mime_type ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
        sourceSha256: digest,
      };
    },

    /**
     * Whether *this* attempt's publication happened, asked of the version
     * ledger rather than of the document.
     *
     * `publishResource` resolves a document by `(work stream, normalized
     * path)`, which answers what is published there now. That is the wrong
     * question after an interruption, and the gap is not academic: on a digest
     * mismatch the publish swaps the stored content, so re-entering blind
     * would write the subject a second time whenever the sandbox file had
     * moved on, and would overwrite a newer document somebody else published
     * into the same window.
     *
     * `resource_versions` answers the right question, because it is
     * append-only. WorkspaceDO's triggers capture every insert and every
     * semantic update into it with the writing run's `author_run_id` and a
     * `captured_at`, then clear the `revision_author_*` columns on the row
     * itself — so the current row cannot say who wrote it and the ledger
     * always can, including for a publication that has since been revised
     * away. That last case is the one that matters most: a landed attempt
     * whose document somebody else has already replaced must still read as
     * landed, or re-entry would undo their work.
     *
     * Ordered accordingly: this run's own version in the window first, then
     * anyone else's, then absence.
     *
     * Deliberately reads no sandbox bytes. The file is shared mutable state
     * and the interrupted attempt's digest was never recorded, so bytes cannot
     * distinguish "I wrote this" from "somebody wrote this".
     */
    async reconcilePublishedResource(context, input) {
      const target = await publicationAddress(context);
      const providerResourceId = await publishedResourceIdentity(target.parentId, input.filePath, target.substreamId);
      const document = await existingPublication(context, target, input.filePath, providerResourceId);
      if (!document) return { outcome: "not_landed" as const };
      const versions = await workspace.prepare(
        `SELECT title, mime_type, content_ref, content_sha256, metadata_json,
                model_content_status, captured_at, author_run_id
           FROM resource_versions
          WHERE workspace_id = ? AND resource_id = ? AND captured_at >= ?
          ORDER BY version ASC`,
      ).bind(context.workspaceId, document.id, new Date(context.attemptStartedAt).toISOString())
        .all<VersionRow>();
      const inWindow = versions.results ?? [];
      const mine = inWindow.find((version) => version.author_run_id === context.harnessRunId);
      if (mine) {
        let size = 0;
        try {
          const metadata = JSON.parse(mine.metadata_json) as { size?: unknown };
          size = typeof metadata.size === "number" ? metadata.size : 0;
        } catch { /* legacy metadata; every other output field still resolves */ }
        // Built from the captured version rather than the live row, because
        // those differ exactly when somebody revised the document afterwards,
        // and what this attempt published is the version it wrote.
        return { outcome: "landed" as const, result: {
          output: publishedOutput({ ...mine, id: document.id, created_at: mine.captured_at }, size),
          summary: `Published ${input.filePath}`,
        } };
      }
      return inWindow.length > 0
        ? { outcome: "unknown" as const, reason: "publication_revised_by_another_run" }
        : { outcome: "not_landed" as const };
    },

    async publishResource(context, input, bytes) {
      const target = await publicationAddress(context, input.providerResourceId);
      const maximum = numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000);
      if (bytes.byteLength > maximum) {
        throw new TerminalToolError("resource_limit_exceeded", `The file is ${bytes.byteLength} bytes; published resources allow at most ${maximum}. Reduce or split it and retry.`, { field: "filePath", expected: `file bytes at most ${maximum}` });
      }
      // A receipt is still required before anything is written: an unplanned
      // call has no attempt to be replaying, and refusing it here is what keeps
      // an unreceipted publish from reaching R2 at all.
      const effectIntentId = requireTerminalEffectIntent(context, "publication");
      // The published document's stable identity is the document's own
      // coordinates — this work stream and the path it was published from — so
      // revising the file and publishing it again lands on the row the first
      // publish created. Deriving it from the call instead made every identity
      // unique per call, which recognized a replay of that one call and nothing
      // else, so a second draft of the same file became a second document.
      const providerResourceId = input.providerResourceId
        ?? await publishedResourceIdentity(target.parentId, input.filePath, target.substreamId);
      const existing = input.providerResourceId === undefined
        ? await existingPublication(context, target, input.filePath, providerResourceId)
        : await publicationRow(context.workspaceId, providerResourceId);
      // Preserve the exact per-call identity of publications that predate path identities.
      const settled = existing ?? await publicationRow(context.workspaceId, `terminal:${effectIntentId}`);

      const sourceName = fileName(input.filePath);
      const mimeType = verifyAttachmentMimeType(bytes, sourceName, null);
      const attachmentKind = classifyAttachmentKind({ mimeType, fileName: sourceName });
      const contentMode = attachmentKind === "image" ? "view" : attachmentKind === "audio" || attachmentKind === "other" ? "unsupported" : "read";
      const derivativeStatus = attachmentKind === "audio" || attachmentKind === "other" ? "unsupported" : "pending";
      const digest = await sha256Hex(bytes);

      if (settled) {
        const relink = async (eventType?: "resource_attached" | "resource_updated") => {
          const linked = await createResourceObjectPort(
            env,
            context.workspaceId,
            target.parentId, undefined, target.substreamId,
          ).isAttached({ resourceId: settled.id });
          if (linked && eventType === undefined) return;
          await attachPublication(context, {
            resourceId: settled.id,
            attachedByUserId: context.executionPrincipal.type === "user"
              ? context.executionPrincipal.userId
              : null,
            ...(eventType ? { eventType } : {}),
          }, target);
        };
        // Equal content covers both a crash-replay of a settled call and a
        // republish that changed nothing: the stored bytes are already these
        // bytes, so there is nothing to write. A row found only under the
        // per-call identity is a replay by definition and is never rewritten —
        // it keeps the identity it was published with.
        const perCallReplay = existing === null;
        if (perCallReplay || settled.content_sha256 === digest) {
          let metadata: Record<string, unknown> = {};
          try { metadata = JSON.parse(settled.metadata_json) as Record<string, unknown>; } catch { /* legacy metadata */ }
          const replayEvent = metadata.publicationEffectIntentId === effectIntentId
            && (metadata.publicationEventType === "resource_attached"
              || metadata.publicationEventType === "resource_updated")
            ? metadata.publicationEventType
            : undefined;
          await relink(replayEvent);
          return publishedOutput(settled, bytes.byteLength);
        }
        const updated = await swapPublishedContent({
          workspace,
          env,
          workspaceId: context.workspaceId,
          existing: settled,
          filePath: input.filePath,
          displayName: input.displayName,
          description: input.description,
          bytes,
          digest,
          mimeType,
          attachmentKind,
          contentMode,
          derivativeStatus,
          harnessRunId: context.harnessRunId,
          onBehalfOfUserId,
          effectIntentId,
          publicationEventType: "resource_updated",
        });
        await attachPublication(context, {
          resourceId: settled.id,
          attachedByUserId: context.executionPrincipal.type === "user"
            ? context.executionPrincipal.userId
            : null,
          eventType: "resource_updated",
        }, target);
        return publishedOutput(updated, bytes.byteLength);
      }

      const resourceId = newId();
      const timestamp = nowIso();
      const objectRef = `${env.AVALON_REGION}/${context.workspaceId}/resources/${resourceId}/terminal/${digest}/${newId()}`;
      await putStagedResourceObject({
        database: workspace,
        payloads: env.PAYLOADS,
        objectRef,
        workspaceId: context.workspaceId,
        resourceId,
        objectKind: "original",
        value: bytes,
        options: {
          httpMetadata: { contentType: mimeType },
          customMetadata: { source: "terminal", sourcePath: input.filePath },
        },
        at: timestamp,
      });
      const title = [...(input.displayName?.trim() || sourceName)].slice(0, 300).join("");
      const metadata = JSON.stringify({
        sourcePath: input.filePath,
        size: bytes.byteLength,
        attachmentKind,
        contentMode,
        publicationEffectIntentId: effectIntentId,
        publicationEventType: "resource_attached",
        ...(input.description ? { description: input.description } : {}),
      });
      try {
        await workspace.prepare(
            `INSERT INTO resources
             (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
              content_ref, content_sha256, metadata_json, last_hydrated_at, uploaded_by_user_id,
              attachment_status, model_content_status, created_at, updated_at,
              revision_author_kind, revision_author_run_id, revision_cause)
             VALUES (?, ?, 'generated_file', 'avalon_generated', ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, ?, ?,
                     'agent', ?, 'created')`,
          ).bind(
            resourceId,
            context.workspaceId,
            providerResourceId,
            title,
            mimeType,
            objectRef,
            digest,
            metadata,
            timestamp,
            context.executionPrincipal.type === "user" ? context.executionPrincipal.userId : null,
            derivativeStatus,
            timestamp,
            timestamp,
            context.harnessRunId,
          ).run();
        await attachPublication(context, {
          resourceId,
          attachedByUserId: context.executionPrincipal.type === "user"
            ? context.executionPrincipal.userId
            : null,
        }, target);
      } catch {
        // The resource insert may have committed before its response was lost.
        // Keep both the stable resource identity and staging fence intact so a
        // retry can observe and attach it without risking referenced bytes.
        throw new TerminalToolError(
          "resource_publish_failed",
          "The generated resource could not be recorded. Retry publish_resource; Rally retained cleanup ownership for the uploaded object.",
          { reason: "Retry the same publish_resource call so Rally can reconcile its stable resource identity." },
        );
      }
      // Failure to clear a staged row cannot make a published document fail:
      // maintenance will observe the active pointer and retire the row without
      // touching R2.
      await workspace.prepare(
        `DELETE FROM resource_object_deletion_outbox
          WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
      ).bind(context.workspaceId, objectRef).run().catch(() => undefined);
      // Outside the block that unwinds a failed publication: the document is
      // recorded and addressable by UUID now, and its alias is owed rather
      // than required — a reason to keep the row, never to drop it.
      await allocateResourceSlugBesideCreation(env, context.workspaceId, resourceId);
      return {
        resourceId,
        title,
        publishKind: "file",
        resourceType: "generated_file",
        provider: "avalon_generated",
        mimeType,
        sizeBytes: bytes.byteLength,
        sourceSha256: digest,
        attachmentKind,
        contentMode,
        derivativeStatus,
        createdAt: timestamp,
      };
    },

    async publishedKindForPath(context, filePath) {
      const target = await publicationAddress(context);
      const providerResourceId = await publishedResourceIdentity(target.parentId, filePath, target.substreamId);
      const row = await existingPublication(context, target, filePath, providerResourceId);
      if (!row) return null;
      if (row.resource_type === "generated_site") return "site";
      // An archive and an ordinary document are the same row type; only the
      // mime type separates them, and only the site transition is guarded, so
      // the distinction is reported rather than acted on here.
      return row.mime_type === "application/zip" ? "archive" : "file";
    },

    /**
     * Publish a directory that carried a site entry, as a resource Rally serves.
     *
     * The identity is the document rule unchanged — `(work stream, normalized
     * path)` — so a republish of the same directory updates the same artifact,
     * keeps the same URL, and lets the versioning layer capture the superseded
     * state at the site it already owns. What differs is what is stored: the
     * resource's content is the *manifest*, not any page, so a content read on
     * a site resource has nothing single-bodied to return and is redirected to
     * the Terminal import instead.
     */
    async publishSiteResource(context, input, site) {
      const target = await publicationAddress(context);
      const effectIntentId = requireTerminalEffectIntent(context, "publication");
      const providerResourceId = await publishedResourceIdentity(target.parentId, input.filePath, target.substreamId);
      const existing = await existingPublication(context, target, input.filePath, providerResourceId);
      const settled = existing ?? await publicationRow(context.workspaceId, `terminal:${effectIntentId}`);

      // A republish that would turn a live site back into an archive never
      // reaches here — the runtime refuses it — but a republish that changes
      // nothing does, and it must not mint a version. The manifest carries the
      // version number and the timestamp, so the comparison is over the files
      // rather than over the manifest that describes them.
      const contentDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(
        site.files.map((file) => [file.path, file.sha256]),
      )));
      const previous = settled
        ? await existingArtifactForResource(workspace, context.workspaceId, settled.id)
        : null;
      const currentHasSocialPreview = settled && previous && settled.content_sha256 === contentDigest
        ? await storedArtifactHasSocialPreview(env, settled.content_ref)
        : false;
      if (settled && previous && settled.content_sha256 === contentDigest && currentHasSocialPreview) {
        // Equal content covers both a crash-replay of a settled call and a
        // republish that changed nothing.
        const hostnameStub = previous.hostnameStub ?? await ensureArtifactHostname(env, {
          workspaceId: context.workspaceId,
          artifactId: previous.artifactId,
        });
        if (previous.hostnameStub === null) {
          await workspace.prepare(
            `UPDATE artifact_registry SET hostname_stub = ?
              WHERE workspace_id = ? AND artifact_id = ? AND hostname_stub IS NULL`,
          ).bind(hostnameStub, context.workspaceId, previous.artifactId).run();
        }
        let settledMetadata: Record<string, unknown> = {};
        try { settledMetadata = JSON.parse(settled.metadata_json) as Record<string, unknown>; } catch { /* legacy metadata */ }
        if (settledMetadata.publicationEffectIntentId === effectIntentId
          && (settledMetadata.publicationEventType === "resource_attached"
            || settledMetadata.publicationEventType === "resource_updated")) {
          await attachPublication(context, {
            resourceId: settled.id,
            attachedByUserId: context.executionPrincipal.type === "user"
              ? context.executionPrincipal.userId
              : null,
            eventType: settledMetadata.publicationEventType,
          }, target);
        }
        return siteOutput(env, settled, {
          artifactId: previous.artifactId,
          version: previous.version,
          mode: previous.mode,
          stateful: site.stateful,
          fileCount: site.files.length,
          totalBytes: site.files.reduce((total, file) => total + file.bytes.byteLength, 0),
          manifestSha256: settled.content_sha256 ?? "",
          hostnameStub,
          slug: settled.slug,
        });
      }

      const resourceId = settled?.id ?? newId();
      const version = (previous?.version ?? 0) + 1;
      const title = [...(input.displayName?.trim() || siteTitle(input.filePath))].slice(0, 300).join("");
      const written = await writeArtifactVersion(env, {
        workspaceId: context.workspaceId,
        workstreamId: target.parentId,
        region: env.AVALON_REGION,
        artifactId: previous?.artifactId ?? null,
        resourceId,
        version,
        mode: site.mode,
        stateful: site.stateful,
        files: site.files,
        fallbackTitle: title,
        serverModuleSha256: site.serverModuleSha256,
      });
      // Reserve the stable public origin before mutating the reusable resource
      // row. If D1 is unavailable after the swap, a retry sees equal content
      // and would otherwise return the previous registry version without ever
      // registering or pointing at the bytes just written.
      const hostnameStub = previous?.hostnameStub ?? await ensureArtifactHostname(env, {
        workspaceId: context.workspaceId,
        artifactId: written.artifactId,
      });
      const timestamp = nowIso();
      const metadata = JSON.stringify({
        sourcePath: input.filePath,
        size: written.manifest.totalBytes,
        attachmentKind: "site",
        contentMode: "unsupported",
        publicationEffectIntentId: effectIntentId,
        publicationEventType: settled ? "resource_updated" : "resource_attached",
        artifactId: written.artifactId,
        artifactVersion: version,
        artifactMode: site.mode,
        artifactStateful: site.stateful,
        ...(input.description ? { description: input.description } : {}),
      });

      // A swap keeps the row, and with it the alias it already has.
      let slug = settled?.slug ?? null;
      if (settled) {
        await swapPublishedContent({
          workspace,
          env,
          workspaceId: context.workspaceId,
          existing: settled,
          filePath: input.filePath,
          displayName: input.displayName,
          description: input.description,
          bytes: written.manifestBytes,
          digest: contentDigest,
          mimeType: SITE_MANIFEST_MIME_TYPE,
          attachmentKind: "site",
          contentMode: "unsupported",
          derivativeStatus: "unsupported",
          harnessRunId: context.harnessRunId,
          onBehalfOfUserId,
          effectIntentId,
          publicationEventType: "resource_updated",
        });
      } else {
        await workspace.prepare(
          `INSERT INTO resources
           (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
            content_ref, content_sha256, metadata_json, last_hydrated_at, uploaded_by_user_id,
            attachment_status, model_content_status, created_at, updated_at,
            revision_author_kind, revision_author_run_id, revision_cause)
           VALUES (?, ?, 'generated_site', 'avalon_generated', ?, ?, ?, ?, ?, ?, ?, ?, 'attached', 'unsupported', ?, ?,
                   'agent', ?, 'created')`,
        ).bind(
          resourceId,
          context.workspaceId,
          providerResourceId,
          title,
          SITE_MANIFEST_MIME_TYPE,
          written.manifestRef,
          contentDigest,
          metadata,
          timestamp,
          context.executionPrincipal.type === "user" ? context.executionPrincipal.userId : null,
          timestamp,
          timestamp,
          context.harnessRunId,
        ).run();
        await attachPublication(context, {
          resourceId,
          attachedByUserId: context.executionPrincipal.type === "user"
            ? context.executionPrincipal.userId
            : null,
        }, target);
        slug = await allocateResourceSlugBesideCreation(env, context.workspaceId, resourceId);
      }

      await registerArtifact(workspace, {
        artifactId: written.artifactId,
        hostnameStub,
        workspaceId: context.workspaceId,
        workstreamId: target.parentId,
        resourceId,
        mode: site.mode,
        stateful: site.stateful,
        version,
        manifestRef: written.manifestRef,
      });
      // Last, and only once every byte it names is durable. Until this returns
      // the artifact serves its previous version; after it returns the new one
      // is what every open resolves to. There is no window where the pointer
      // names bytes a viewer cannot read.
      await pointArtifactAtVersion(env, {
        artifactId: written.artifactId,
        workspaceId: context.workspaceId,
        workstreamId: target.parentId,
        resourceId,
        region: env.AVALON_REGION,
        manifest: written.manifest,
      });
      // The resource row and the public artifact pointer are separate durable
      // authorities. Advertise a revision only after both name the new version,
      // so a client refreshing in response cannot resolve the previous site.
      if (settled) {
        await attachPublication(context, {
          resourceId,
          attachedByUserId: context.executionPrincipal.type === "user"
            ? context.executionPrincipal.userId
            : null,
          eventType: "resource_updated",
        }, target);
      }

      return siteOutput(env, {
        id: resourceId,
        title,
        created_at: settled?.created_at ?? timestamp,
      }, {
        artifactId: written.artifactId,
        version,
        mode: site.mode,
        stateful: site.stateful,
        fileCount: site.files.length,
        totalBytes: written.manifest.totalBytes,
        manifestSha256: written.manifestSha256,
        hostnameStub,
        slug,
      });
    },
  };
}

/** The rail's own name for a site, taken from the directory it was written in. */
function siteTitle(filePath: string): string {
  return normalizePublishPath(filePath).split("/").at(-1) || "site";
}

function siteOutput(
  env: Env,
  row: { id: string; title: string; created_at: string },
  site: {
    artifactId: string;
    version: number;
    mode: "static" | "active";
    stateful: boolean;
    fileCount: number;
    totalBytes: number;
    manifestSha256: string;
    hostnameStub: ArtifactHostnameStub;
    slug: string | null;
  },
): TerminalPublishedSiteOutput {
  return {
    resourceId: row.id,
    title: row.title,
    publishKind: "site",
    resourceType: "generated_site",
    provider: "avalon_generated",
    attachmentKind: "site",
    slug: site.slug,
    // The model's next step is citing the artifact, so the URL is in the
    // result rather than something it has to derive from an id.
    url: artifactOrigin(site.hostnameStub, env.AVALON_REGION, env.ARTIFACT_SERVING_DOMAIN),
    mode: site.mode,
    stateful: site.stateful,
    version: site.version,
    mimeType: SITE_MANIFEST_MIME_TYPE,
    fileCount: site.fileCount,
    totalBytes: site.totalBytes,
    manifestSha256: site.manifestSha256,
    createdAt: row.created_at,
  };
}
