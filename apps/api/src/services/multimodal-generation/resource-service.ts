import { classifyAttachmentKind, type ExecutionPrincipal } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../../env";
import { numericEnv } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import {
  conversationResourceLinksFrom,
  createResourcePortFactory,
  type ResourcePortFactory,
} from "../../runtime/resource-port";
import { verifyAttachmentMimeType } from "../attachment-mime-verification";
import { putStagedResourceObject, releaseStagedResourceObject } from "../resource-object-cleanup";
import { allocateResourceSlugBesideCreation } from "../resource-slug";
import {
  attachWorkstreamRuntimeResource,
  type WorkstreamRuntimeResourceAttacher,
} from "../workstream-object-client";
import {
  loadVisibleWorkstreamResourcesByIds,
  type VisibleWorkstreamResourceRow,
} from "../workstream-resource-visibility";
import { MultimodalGenerationError } from "./contract";
import { AGENT_RESOURCE_TITLE_SQL } from "../agent-resource-title";

interface PublishedImageRow {
  id: string;
  resource_type: string;
  provider: string;
  title: string;
  mime_type: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  metadata_json: string;
  model_content_status: string | null;
  created_at: string;
}

export interface MultimodalImageSource {
  resourceId: string;
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  contentRef: string;
  storedSha256: string | null;
}

export interface PublishedMultimodalImage {
  resourceId: string;
  resourceType: string;
  provider: string;
  title: string;
  mimeType: "image/png";
  bytes: Uint8Array;
  base64: string;
  sourceSha256: string;
  createdAt: string;
  derivativeStatus: "pending" | "ready" | "unsupported";
  metadata: Record<string, unknown>;
}

export interface MultimodalGenerationResourceStore {
  findPublished(
    context: ResourceContext,
    operation: "generate" | "edit",
    sourceResourceId?: string,
  ): Promise<PublishedMultimodalImage | null>;
  loadEditSources(
    context: ResourceContext,
    resourceId: string,
    maskResourceId?: string,
  ): Promise<{ image: MultimodalImageSource; mask?: MultimodalImageSource }>;
  publish(context: ResourceContext, input: PublishImageInput): Promise<PublishedMultimodalImage>;
}

export interface ResourceContext {
  workspaceId: string;
  workstreamId: string;
  harnessRunId: string;
  effectIntentId: string;
  executionPrincipal: ExecutionPrincipal;
  /** The person who asked for this run (`runRequesterUserId`); null for a Sidekick run. */
  onBehalfOfUserId: string | null;
}

export interface PublishImageInput {
  bytes: Uint8Array;
  title?: string;
  operation: "generate" | "edit";
  requestedSize: string;
  actualSize?: string;
  providerOperationId?: string;
  sourceResourceId?: string;
  sourceContentRef?: string;
  sourceContentSha256?: string | null;
  maskResourceId?: string;
  billing: {
    costUsd: string | null;
    pricingSourceFingerprint: string;
    usage: Record<string, unknown> | null;
  };
}

const PROVIDER = "avalon_generated";
const MIME_TYPE = "image/png";
const ACCEPTED_EDIT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function createMultimodalGenerationResourceStore(
  env: Env,
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
  resourcePortFactory: ResourcePortFactory = createResourcePortFactory(env),
): MultimodalGenerationResourceStore {
  const attachResource = inObjectResourceAttacher
    ?? ((input) => attachWorkstreamRuntimeResource(env, input));
  return {
    async findPublished(context, operation, sourceResourceId) {
      const row = operation === "generate"
        ? await findPublishedRow(env.DB, context.workspaceId, providerResourceId(context.effectIntentId))
        : sourceResourceId
          ? await findEditedRow(env.DB, context.workspaceId, sourceResourceId, context.effectIntentId)
          : null;
      if (!row) return null;
      await attach(context, row.id, attachResource);
      return hydratePublishedRow(env, row);
    },
    async loadEditSources(context, resourceId, maskResourceId) {
      const requested = [resourceId, ...(maskResourceId ? [maskResourceId] : [])];
      const rows = await loadVisibleWorkstreamResourcesByIds(
        env.DB,
        conversationResourceLinksFrom(resourcePortFactory, context.workspaceId, context.workstreamId, undefined, { env, principal: context.executionPrincipal }),
        {
          workspaceId: context.workspaceId,
          workstreamId: context.workstreamId,
          principal: context.executionPrincipal,
          resourceIds: requested,
        },
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const image = await loadSource(env, byId.get(resourceId), resourceId, false);
      const mask = maskResourceId
        ? await loadSource(env, byId.get(maskResourceId), maskResourceId, true)
        : undefined;
      return { image, ...(mask ? { mask } : {}) };
    },
    async publish(context, input) {
      const bytes = input.bytes;
      const maximum = numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000);
      if (bytes.byteLength > maximum) {
        throw new MultimodalGenerationError(
          "resource_limit_exceeded",
          `The generated image is ${bytes.byteLength} bytes; Rally accepts at most ${maximum} bytes. Try a smaller image size.`,
          { field: "size", expected: `generated image bytes at most ${maximum}` },
        );
      }
      const mimeType = verifyAttachmentMimeType(bytes, "generated.png", MIME_TYPE);
      if (mimeType !== MIME_TYPE) {
        throw new MultimodalGenerationError(
          "azure_image_response_invalid",
          "Azure returned an image that was not a PNG. Retry later.",
          { actualMimeType: mimeType },
        );
      }
      const digest = await sha256Hex(bytes);
      if (input.operation === "edit") {
        return publishEditedVersion(env, context, input, digest, attachResource);
      }
      const identity = providerResourceId(context.effectIntentId);
      const existing = await findPublishedRow(env.DB, context.workspaceId, identity);
      if (existing) {
        await attach(context, existing.id, attachResource);
        return hydratePublishedRow(env, existing);
      }

      const resourceId = newId();
      const timestamp = nowIso();
      const objectRef = `${env.AVALON_REGION}/${context.workspaceId}/resources/${resourceId}/multimodal-generation/${digest}/${newId()}`;
      const dimensions = pngDimensions(bytes);
      const metadata = {
        size: bytes.byteLength,
        attachmentKind: "image",
        contentMode: "view",
        source: "multimodal_generation",
        operation: input.operation,
        model: "gpt-image-2",
        inferenceProvider: "azure",
        requestedSize: input.requestedSize,
        ...(input.actualSize ? { actualSize: input.actualSize } : {}),
        ...(dimensions ? dimensions : {}),
        ...(input.providerOperationId ? { providerOperationId: input.providerOperationId } : {}),
        ...(input.sourceResourceId ? { sourceResourceId: input.sourceResourceId } : {}),
        ...(input.maskResourceId ? { maskResourceId: input.maskResourceId } : {}),
        billing: input.billing,
      };
      await putStagedResourceObject({
        database: env.DB,
        payloads: env.PAYLOADS,
        objectRef,
        workspaceId: context.workspaceId,
        resourceId,
        objectKind: "original",
        value: bytes,
        options: {
          httpMetadata: { contentType: MIME_TYPE },
          customMetadata: { source: "multimodal-generation" },
        },
        at: timestamp,
      });
      const title = input.title ?? "Generated image";
      let settled: PublishedImageRow | null;
      try {
        await env.DB.prepare(
          `INSERT INTO resources
           (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
            content_ref, content_sha256, metadata_json, last_hydrated_at, uploaded_by_user_id,
            attachment_status, model_content_status, created_at, updated_at,
            revision_author_kind, revision_author_run_id, revision_cause)
           VALUES (?, ?, 'generated_file', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', 'pending', ?, ?,
                   'agent', ?, 'created')`,
        ).bind(
          resourceId,
          context.workspaceId,
          PROVIDER,
          identity,
          title,
          MIME_TYPE,
          objectRef,
          digest,
          JSON.stringify(metadata),
          timestamp,
          context.executionPrincipal.type === "user" ? context.executionPrincipal.userId : null,
          timestamp,
          timestamp,
          context.harnessRunId,
        ).run();
        settled = await findPublishedRow(env.DB, context.workspaceId, identity);
      } catch (error) {
        settled = await findPublishedRow(env.DB, context.workspaceId, identity).catch(() => null);
        if (!settled) {
          throw new MultimodalGenerationError(
            "resource_publish_failed",
            "The generated image could not be recorded. Retry the same image request so Rally can reconcile it.",
            { reason: "Retry the same tool call so Rally can reconcile its stable resource identity." },
            { cause: error },
          );
        }
      }
      if (!settled) {
        throw new MultimodalGenerationError(
          "resource_publish_failed",
          "The generated image could not be recorded. Retry the same image request so Rally can reconcile it.",
        );
      }
      if (settled.content_ref !== objectRef) {
        await releaseStagedResourceObject(env.DB, context.workspaceId, objectRef).catch(() => undefined);
      } else {
        await env.DB.prepare(
          `DELETE FROM resource_object_deletion_outbox
            WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
        ).bind(context.workspaceId, objectRef).run().catch(() => undefined);
      }
      await attach(context, settled.id, attachResource);
      await allocateResourceSlugBesideCreation(env, context.workspaceId, settled.id);
      return hydratePublishedRow(env, settled);
    },
  };
}

async function publishEditedVersion(
  env: Env,
  context: ResourceContext,
  input: PublishImageInput,
  digest: string,
  attachResource: WorkstreamRuntimeResourceAttacher,
): Promise<PublishedMultimodalImage> {
  if (!input.sourceResourceId || !input.sourceContentRef) {
    throw new MultimodalGenerationError(
      "resource_publish_failed",
      "Rally lost the source image version before publishing the edit. List resources and retry.",
    );
  }
  const existing = await findResourceRow(env.DB, context.workspaceId, input.sourceResourceId);
  if (!existing
    || existing.content_ref !== input.sourceContentRef
    || existing.content_sha256 !== (input.sourceContentSha256 ?? null)) {
    throw new MultimodalGenerationError(
      "resource_version_changed",
      "The source image changed while Azure was editing it. View the current version and retry the edit.",
      { resourceId: input.sourceResourceId, retryable: true },
    );
  }
  const timestamp = nowIso();
  const objectRef = `${env.AVALON_REGION}/${context.workspaceId}/resources/${existing.id}/multimodal-generation/${digest}/${newId()}`;
  const dimensions = pngDimensions(input.bytes);
  let previousMetadata: Record<string, unknown> = {};
  try { previousMetadata = JSON.parse(existing.metadata_json) as Record<string, unknown>; } catch { /* legacy row */ }
  const metadata = {
    ...previousMetadata,
    size: input.bytes.byteLength,
    attachmentKind: "image",
    contentMode: "view",
    source: "multimodal_generation",
    operation: "edit",
    model: "gpt-image-2",
    inferenceProvider: "azure",
    requestedSize: input.requestedSize,
    multimodalGenerationEffectIntentId: context.effectIntentId,
    ...(input.actualSize ? { actualSize: input.actualSize } : {}),
    ...(dimensions ? dimensions : {}),
    ...(input.providerOperationId ? { providerOperationId: input.providerOperationId } : {}),
    ...(input.maskResourceId ? { maskResourceId: input.maskResourceId } : {}),
    billing: input.billing,
  };
  await putStagedResourceObject({
    database: env.DB,
    payloads: env.PAYLOADS,
    objectRef,
    workspaceId: context.workspaceId,
    resourceId: existing.id,
    objectKind: "original",
    value: input.bytes,
    options: {
      httpMetadata: { contentType: MIME_TYPE },
      customMetadata: { source: "multimodal-generation" },
    },
    at: timestamp,
  });
  let settled: PublishedImageRow | null;
  try {
    settled = await env.DB.prepare(
      `UPDATE resources
          SET title = ${AGENT_RESOURCE_TITLE_SQL}, mime_type = ?, content_ref = ?, content_sha256 = ?, metadata_json = ?,
              last_hydrated_at = ?, updated_at = ?,
              model_content_ref = NULL, model_mime_type = NULL, model_content_sha256 = NULL,
              model_metadata_json = NULL, model_content_status = 'pending',
              model_content_extractor_version = NULL, model_content_character_count = NULL,
              model_content_extracted_at = NULL, model_content_claimed_at = NULL,
              model_content_claim_id = NULL, model_content_error_code = NULL,
              revision_author_kind = 'agent', revision_author_run_id = ?,
              revision_author_user_id = NULL, revision_author_connection_id = NULL,
              revision_cause = 'replaced', revision_on_behalf_of_user_id = ?
        WHERE id = ? AND workspace_id = ? AND content_ref = ? AND content_sha256 IS ?
      RETURNING id, resource_type, provider, title, mime_type, content_ref, content_sha256, metadata_json,
                model_content_status, created_at`,
    ).bind(
      input.title ?? null,
      input.title ?? null,
      input.title ?? null,
      MIME_TYPE,
      objectRef,
      digest,
      JSON.stringify(metadata),
      timestamp,
      timestamp,
      context.harnessRunId,
      context.onBehalfOfUserId,
      existing.id,
      context.workspaceId,
      input.sourceContentRef,
      input.sourceContentSha256 ?? null,
    ).first<PublishedImageRow>();
  } catch (error) {
    const current = await findEditedRow(
      env.DB,
      context.workspaceId,
      existing.id,
      context.effectIntentId,
    ).catch(() => null);
    if (!current) {
      throw new MultimodalGenerationError(
        "resource_publish_failed",
        "The edited image version could not be recorded. Do not repeat it until Rally can reconcile the write.",
        { resourceId: existing.id },
        { cause: error },
      );
    }
    settled = current;
  }
  if (!settled) {
    await releaseStagedResourceObject(env.DB, context.workspaceId, objectRef).catch(() => undefined);
    throw new MultimodalGenerationError(
      "resource_version_changed",
      "The source image changed while Azure was editing it. View the current version and retry the edit.",
      { resourceId: existing.id, retryable: true },
    );
  }
  if (settled.content_ref !== objectRef) {
    await releaseStagedResourceObject(env.DB, context.workspaceId, objectRef).catch(() => undefined);
  } else {
    await env.DB.prepare(
      `DELETE FROM resource_object_deletion_outbox
        WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
    ).bind(context.workspaceId, objectRef).run().catch(() => undefined);
  }
  await attach(context, settled.id, attachResource);
  return hydratePublishedRow(env, settled);
}

function providerResourceId(effectIntentId: string): string {
  return `multimodal-generation:${effectIntentId}`;
}

async function findPublishedRow(
  database: D1Database,
  workspaceId: string,
  identity: string,
): Promise<PublishedImageRow | null> {
  return database.prepare(
    `SELECT id, resource_type, provider, title, mime_type, content_ref, content_sha256, metadata_json,
            model_content_status, created_at
       FROM resources
      WHERE workspace_id = ? AND provider = ? AND provider_resource_id = ?`,
  ).bind(workspaceId, PROVIDER, identity).first<PublishedImageRow>();
}

async function findResourceRow(
  database: D1Database,
  workspaceId: string,
  resourceId: string,
): Promise<PublishedImageRow | null> {
  return database.prepare(
    `SELECT id, resource_type, provider, title, mime_type, content_ref, content_sha256, metadata_json,
            model_content_status, created_at
       FROM resources WHERE workspace_id = ? AND id = ?`,
  ).bind(workspaceId, resourceId).first<PublishedImageRow>();
}

async function findEditedRow(
  database: D1Database,
  workspaceId: string,
  resourceId: string,
  effectIntentId: string,
): Promise<PublishedImageRow | null> {
  const row = await findResourceRow(database, workspaceId, resourceId);
  if (!row) return null;
  try {
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return metadata.multimodalGenerationEffectIntentId === effectIntentId ? row : null;
  } catch {
    return null;
  }
}

async function hydratePublishedRow(env: Env, row: PublishedImageRow): Promise<PublishedMultimodalImage> {
  if (!row.content_ref || !row.content_sha256) {
    throw new MultimodalGenerationError(
      "resource_publish_failed",
      "The previously generated image has no stored bytes. Retry the image request.",
    );
  }
  const object = await env.PAYLOADS.get(row.content_ref);
  if (!object) {
    throw new MultimodalGenerationError(
      "resource_not_available",
      "The generated image bytes are temporarily unavailable. Retry later.",
      { resourceId: row.id, retryable: true },
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== row.content_sha256) {
    throw new MultimodalGenerationError(
      "resource_hash_mismatch",
      "The stored generated image failed integrity verification. Retry the image request.",
      { resourceId: row.id },
    );
  }
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { /* legacy row */ }
  return {
    resourceId: row.id,
    resourceType: row.resource_type,
    provider: row.provider,
    title: row.title,
    mimeType: MIME_TYPE,
    bytes,
    base64: encodeBase64(bytes),
    sourceSha256: row.content_sha256,
    createdAt: row.created_at,
    derivativeStatus: row.model_content_status === "ready" || row.model_content_status === "unsupported"
      ? row.model_content_status
      : "pending",
    metadata,
  };
}

async function loadSource(
  env: Env,
  row: VisibleWorkstreamResourceRow | undefined,
  resourceId: string,
  mask: boolean,
): Promise<MultimodalImageSource> {
  if (!row) {
    throw new MultimodalGenerationError(
      "resource_not_found",
      `${mask ? "maskResourceId" : "resourceId"} does not identify an image this run can read.`,
      { resourceId, reason: "Check the image resource ID and the execution user's read access. Use list_resources to discover images." },
    );
  }
  const kind = classifyAttachmentKind({ mimeType: row.mime_type, fileName: row.title });
  if (kind !== "image" || !row.content_ref) {
    throw new MultimodalGenerationError(
      "resource_not_image",
      `The selected ${mask ? "mask" : "source"} resource is not a stored image.`,
      { resourceId, actualMimeType: row.mime_type, attachmentKind: kind },
    );
  }
  const object = await env.PAYLOADS.get(row.content_ref);
  if (!object) {
    throw new MultimodalGenerationError(
      "resource_not_available",
      "The selected image bytes are temporarily unavailable. Retry later.",
      { resourceId, retryable: true },
    );
  }
  const maximum = numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000);
  if (Number.isFinite(object.size) && object.size > maximum) {
    throw new MultimodalGenerationError(
      "resource_limit_exceeded",
      `The selected image is ${object.size} bytes; image editing accepts at most ${maximum} bytes.`,
      { resourceId, expected: `image bytes at most ${maximum}` },
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > maximum) {
    throw new MultimodalGenerationError(
      "resource_limit_exceeded",
      `The selected image is ${bytes.byteLength} bytes; image editing accepts at most ${maximum} bytes.`,
      { resourceId, expected: `image bytes at most ${maximum}` },
    );
  }
  if (row.content_sha256 && await sha256Hex(bytes) !== row.content_sha256) {
    throw new MultimodalGenerationError(
      "resource_hash_mismatch",
      "The selected image changed while it was being loaded. List resources and retry the current version.",
      { resourceId },
    );
  }
  const mimeType = verifyAttachmentMimeType(bytes, row.title, row.mime_type);
  if (mask ? mimeType !== "image/png" : !ACCEPTED_EDIT_MIME_TYPES.has(mimeType)) {
    throw new MultimodalGenerationError(
      "resource_image_format_unsupported",
      mask
        ? "The edit mask must be a PNG image."
        : "Image editing accepts PNG, JPEG, or WebP source images.",
      { resourceId, actualMimeType: mimeType, attachmentKind: "image" },
    );
  }
  return {
    resourceId,
    bytes,
    mimeType,
    fileName: row.title,
    contentRef: row.content_ref,
    storedSha256: row.content_sha256,
  };
}

async function attach(
  context: ResourceContext,
  resourceId: string,
  attachResource: WorkstreamRuntimeResourceAttacher,
): Promise<void> {
  await attachResource({
    workspaceId: context.workspaceId,
    workstreamId: context.workstreamId,
    resourceId,
    attachedByUserId: context.executionPrincipal.type === "user"
      ? context.executionPrincipal.userId
      : null,
    relationshipType: "generated",
  });
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24
    || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
    || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
