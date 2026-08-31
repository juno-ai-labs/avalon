import { newId, nowIso } from "@rally/db";

import type { Env } from "../../env";
import { numericEnv } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import { verifyAttachmentMimeType } from "../attachment-mime-verification";
import { putStagedResourceObject, releaseStagedResourceObject } from "../resource-object-cleanup";
import { allocateResourceSlugBesideCreation } from "../resource-slug";
import {
  attachWorkstreamRuntimeResource,
  type WorkstreamRuntimeResourceAttacher,
} from "../workstream-object-client";
import {
  MULTIMODAL_AUDIO_MODEL,
  MultimodalGenerationError,
  type AudioVoice,
} from "./contract";
import type { ResourceContext } from "./resource-service";

const PROVIDER = "avalon_generated";
const MIME_TYPE = "audio/mpeg";

interface PublishedAudioRow {
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

export interface PublishedMultimodalAudio {
  resourceId: string;
  resourceType: string;
  provider: string;
  title: string;
  mimeType: "audio/mpeg";
  bytes: Uint8Array;
  sourceSha256: string;
  createdAt: string;
  derivativeStatus: "unsupported";
  metadata: Record<string, unknown>;
}

export interface PublishAudioInput {
  bytes: Uint8Array;
  title?: string;
  voice: AudioVoice;
  providerOperationId?: string;
  billing: {
    costUsd: string | null;
    pricingSourceFingerprint: string;
    usage: Record<string, unknown> | null;
  };
}

export interface MultimodalAudioResourceStore {
  findPublished(context: ResourceContext): Promise<PublishedMultimodalAudio | null>;
  publish(context: ResourceContext, input: PublishAudioInput): Promise<PublishedMultimodalAudio>;
}

export function createMultimodalAudioResourceStore(
  env: Env,
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
): MultimodalAudioResourceStore {
  const attachResource = inObjectResourceAttacher
    ?? ((input) => attachWorkstreamRuntimeResource(env, input));
  return {
    async findPublished(context) {
      const row = await findPublishedRow(
        env.DB,
        context.workspaceId,
        providerResourceId(context.effectIntentId),
      );
      if (!row) return null;
      await attach(context, row.id, attachResource);
      return hydratePublishedAudio(env, row);
    },
    async publish(context, input) {
      const maximum = numericEnv(env, "MAX_ATTACHMENT_BYTES", 25_000_000);
      if (input.bytes.byteLength > maximum) {
        throw new MultimodalGenerationError(
          "resource_limit_exceeded",
          `The generated audio is ${input.bytes.byteLength} bytes; Rally accepts at most ${maximum} bytes. Shorten the text and try again.`,
          { field: "text", expected: `generated audio bytes at most ${maximum}` },
        );
      }
      const mimeType = verifyAttachmentMimeType(input.bytes, "generated.mp3", MIME_TYPE);
      if (mimeType !== MIME_TYPE) {
        throw new MultimodalGenerationError(
          "azure_audio_response_invalid",
          "Azure returned audio that was not an MP3. Retry later.",
          { actualMimeType: mimeType },
        );
      }
      const identity = providerResourceId(context.effectIntentId);
      const existing = await findPublishedRow(env.DB, context.workspaceId, identity);
      if (existing) {
        await attach(context, existing.id, attachResource);
        return hydratePublishedAudio(env, existing);
      }

      const digest = await sha256Hex(input.bytes);
      const resourceId = newId();
      const timestamp = nowIso();
      const objectRef = `${env.AVALON_REGION}/${context.workspaceId}/resources/${resourceId}/multimodal-generation/audio/${digest}/${newId()}`;
      const metadata = {
        size: input.bytes.byteLength,
        attachmentKind: "audio",
        contentMode: "unsupported",
        source: "multimodal_generation",
        operation: "audio",
        model: MULTIMODAL_AUDIO_MODEL,
        inferenceProvider: "azure",
        voice: input.voice,
        outputFormat: "mp3",
        aiGenerated: true,
        ...(input.providerOperationId ? { providerOperationId: input.providerOperationId } : {}),
        billing: input.billing,
      };
      await putStagedResourceObject({
        database: env.DB,
        payloads: env.PAYLOADS,
        objectRef,
        workspaceId: context.workspaceId,
        resourceId,
        objectKind: "original",
        value: input.bytes,
        options: {
          httpMetadata: { contentType: MIME_TYPE },
          customMetadata: { source: "multimodal-generation" },
        },
        at: timestamp,
      });
      const title = input.title ?? "Generated audio.mp3";
      let settled: PublishedAudioRow | null;
      try {
        await env.DB.prepare(
          `INSERT INTO resources
           (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
            content_ref, content_sha256, metadata_json, last_hydrated_at, uploaded_by_user_id,
            attachment_status, model_content_status, created_at, updated_at,
            revision_author_kind, revision_author_run_id, revision_cause)
           VALUES (?, ?, 'generated_file', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', 'unsupported', ?, ?,
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
            "The generated audio could not be recorded. Retry the same request so Rally can reconcile it.",
            { reason: "Retry the same tool call so Rally can reconcile its stable resource identity." },
            { cause: error },
          );
        }
      }
      if (!settled) {
        throw new MultimodalGenerationError(
          "resource_publish_failed",
          "The generated audio could not be recorded. Retry the same request so Rally can reconcile it.",
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
      return hydratePublishedAudio(env, settled);
    },
  };
}

function providerResourceId(effectIntentId: string): string {
  return `multimodal-generation:${effectIntentId}`;
}

async function findPublishedRow(
  database: D1Database,
  workspaceId: string,
  identity: string,
): Promise<PublishedAudioRow | null> {
  return database.prepare(
    `SELECT id, resource_type, provider, title, mime_type, content_ref, content_sha256, metadata_json,
            model_content_status, created_at
       FROM resources
      WHERE workspace_id = ? AND provider = ? AND provider_resource_id = ?`,
  ).bind(workspaceId, PROVIDER, identity).first<PublishedAudioRow>();
}

async function hydratePublishedAudio(
  env: Env,
  row: PublishedAudioRow,
): Promise<PublishedMultimodalAudio> {
  if (!row.content_ref || !row.content_sha256) {
    throw new MultimodalGenerationError(
      "resource_publish_failed",
      "The previously generated audio has no stored bytes. Retry the request.",
    );
  }
  const object = await env.PAYLOADS.get(row.content_ref);
  if (!object) {
    throw new MultimodalGenerationError(
      "resource_not_available",
      "The generated audio bytes are temporarily unavailable. Retry later.",
      { resourceId: row.id, retryable: true },
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== row.content_sha256) {
    throw new MultimodalGenerationError(
      "resource_hash_mismatch",
      "The stored generated audio failed integrity verification. Retry the request.",
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
    sourceSha256: row.content_sha256,
    createdAt: row.created_at,
    derivativeStatus: "unsupported",
    metadata,
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
