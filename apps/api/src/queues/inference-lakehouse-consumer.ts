import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { logStructuredEvent } from "../observability/logger";
import {
  InferenceLakehousePointerSchema,
  InferenceLakehouseRecordSchema,
  type InferenceLakehouseRecord,
} from "../services/inference-lakehouse";

export const INFERENCE_LAKEHOUSE_QUEUE_NAMES = new Set([
  "avalon-global-inference-lakehouse",
  "avalon-eu-inference-lakehouse",
]);

/** Published Cloudflare Pipelines ingestion-request limit, checked 2026-08-24. */
export const PIPELINE_INGEST_REQUEST_BYTES = 5_000_000;

export function isInferenceLakehouseQueue(queue: string): boolean {
  return INFERENCE_LAKEHOUSE_QUEUE_NAMES.has(queue);
}

function overflowRecord(
  record: InferenceLakehouseRecord,
  pointer: ReturnType<typeof InferenceLakehousePointerSchema.parse>,
): InferenceLakehouseRecord {
  const queryable = { ...record };
  delete queryable.request;
  delete queryable.response;
  return {
    ...queryable,
    payload_object_key: pointer.objectKey,
    payload_sha256: pointer.payloadSha256,
    payload_bytes: pointer.payloadBytes,
    metadata: {
      ...record.metadata,
      overflow: {
        reason: "pipeline_ingest_request_limit",
        maximumBytes: PIPELINE_INGEST_REQUEST_BYTES,
        fullRecordAvailableInRegionalR2: true,
      },
    },
  };
}

export async function deliverInferenceLakehousePointer(
  env: Pick<Env, "AVALON_REGION" | "PAYLOADS" | "INFERENCE_LAKEHOUSE">,
  body: unknown,
): Promise<{ overflow: boolean; record: InferenceLakehouseRecord }> {
  const pointer = InferenceLakehousePointerSchema.parse(body);
  if (pointer.region !== env.AVALON_REGION) {
    throw new Error(`inference_lakehouse_pointer_misrouted:${pointer.region}:${env.AVALON_REGION}`);
  }
  if (!env.INFERENCE_LAKEHOUSE) throw new Error("inference_lakehouse_pipeline_binding_missing");
  const object = await env.PAYLOADS.get(pointer.objectKey);
  if (!object) throw new Error(`inference_lakehouse_payload_object_missing:${pointer.objectKey}`);
  const serialized = await object.text();
  const actualBytes = new TextEncoder().encode(serialized).byteLength;
  const actualSha256 = await sha256(serialized);
  if (actualBytes !== pointer.payloadBytes || actualSha256 !== pointer.payloadSha256) {
    throw new Error(`inference_lakehouse_payload_integrity_failed:${pointer.eventId}`);
  }
  const record = InferenceLakehouseRecordSchema.parse(JSON.parse(serialized) as unknown);
  if (record.event_id !== pointer.eventId || record.region !== pointer.region) {
    throw new Error(`inference_lakehouse_payload_identity_failed:${pointer.eventId}`);
  }

  // The array brackets added by `send` count toward the platform's 5 MB
  // ingestion-request ceiling. The fallback row keeps queryable metadata in
  // Iceberg and the exact oversized record in regional R2 under its hash.
  const overflow = pointer.payloadBytes + 2 > PIPELINE_INGEST_REQUEST_BYTES;
  const delivered = overflow ? overflowRecord(record, pointer) : record;
  await env.INFERENCE_LAKEHOUSE.send([delivered]);
  return { overflow, record: delivered };
}

export async function consumeInferenceLakehouseQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = InferenceLakehousePointerSchema.safeParse(message.body);
    if (!parsed.success) {
      logStructuredEvent(env, "error", "inference_lakehouse_pointer_invalid", {
        queue: batch.queue,
        errors: parsed.error.issues.slice(0, 4).map((issue) =>
          `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`),
      });
      message.ack();
      return;
    }
    if (parsed.data.region !== env.AVALON_REGION) {
      logStructuredEvent(env, "error", "inference_lakehouse_pointer_misrouted", {
        queue: batch.queue,
        event_id: parsed.data.eventId,
        expected_region: env.AVALON_REGION,
        actual_region: parsed.data.region,
      });
      message.ack();
      return;
    }
    try {
      const result = await deliverInferenceLakehousePointer(env, parsed.data);
      logStructuredEvent(env, "info", "inference_lakehouse_delivered", {
        queue: batch.queue,
        event_id: result.record.event_id,
        event_type: result.record.event_type,
        inference_request_id: result.record.inference_request_id,
        workspace_id: result.record.workspace_id,
        workstream_id: result.record.workstream_id,
        substream_id: result.record.substream_id,
        source: result.record.source,
        overflow: result.overflow,
      });
      message.ack();
    } catch (error) {
      logStructuredEvent(env, "warn", "inference_lakehouse_delivery_failed", {
        queue: batch.queue,
        event_id: parsed.data.eventId,
        object_key: parsed.data.objectKey,
        error_name: error instanceof Error ? error.name : "UnknownError",
        error_message: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }));
}
