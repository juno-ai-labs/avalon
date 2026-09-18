import { RegionSchema } from "@rally/contracts/regions";
import type {
  InferenceAttemptEvent,
  InferenceRequestEvent,
  StructuredModelDiagnostic,
} from "@rally/agent-harness";
import { z } from "zod";

import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { logStructuredEvent } from "../observability/logger";

export const INFERENCE_LAKEHOUSE_SCHEMA_VERSION = 1 as const;

const InferenceLakehouseRecordSchema = z.object({
  schema_version: z.literal(INFERENCE_LAKEHOUSE_SCHEMA_VERSION),
  event_id: z.string().min(1),
  event_type: z.enum(["request", "attempt"]),
  captured_at: z.string().datetime(),
  region: RegionSchema,
  invocation_type: z.enum(["streaming", "structured"]),
  source: z.string().min(1),
  environment: z.string().min(1),
  build_sha: z.string().optional(),
  workspace_id: z.string().optional(),
  user_id: z.string().optional(),
  context_user_id: z.string().optional(),
  workstream_id: z.string().optional(),
  substream_id: z.string().min(1).optional(),
  trace_id: z.string().optional(),
  request_id: z.string().optional(),
  parent_request_id: z.string().optional(),
  draft_id: z.string().optional(),
  inference_request_id: z.string().min(1),
  turn_id: z.string().optional(),
  schema_name: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  provider_model: z.string().optional(),
  success: z.boolean().optional(),
  disposition: z.string().optional(),
  failure_kind: z.string().optional(),
  latency_ms: z.number().optional(),
  ttft_ms: z.number().nullable().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  cached_input_tokens: z.number().nullable().optional(),
  cost_microusd: z.number().optional(),
  response_bytes: z.number().optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  response: z.record(z.string(), z.unknown()).optional(),
  error: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()),
  payload_object_key: z.string().optional(),
  payload_sha256: z.string().optional(),
  payload_bytes: z.number().optional(),
});

export type InferenceLakehouseRecord = z.infer<typeof InferenceLakehouseRecordSchema>;

export const InferenceLakehousePointerSchema = z.object({
  schemaVersion: z.literal(INFERENCE_LAKEHOUSE_SCHEMA_VERSION),
  eventId: z.string().min(1),
  region: RegionSchema,
  objectKey: z.string().min(1),
  payloadSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  payloadBytes: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
});

export type InferenceLakehousePointer = z.infer<typeof InferenceLakehousePointerSchema>;

export interface InferenceLakehouseContext {
  source: string;
  workspaceId?: string;
  userId?: string;
  workstreamId?: string;
  substreamId?: string;
  traceId?: string;
  requestId?: string;
  parentRequestId?: string;
  draftId?: string;
  operationId?: string;
  journey?: "workstream_create" | "substream_create" | "message_send";
  requestReceivedAt?: number;
}

function commonRecord(
  env: Env,
  context: InferenceLakehouseContext,
  eventId: string,
  eventType: "request" | "attempt",
  invocationType: "streaming" | "structured",
  inferenceRequestId: string,
  capturedAt = Date.now(),
): Pick<
  InferenceLakehouseRecord,
  | "schema_version"
  | "event_id"
  | "event_type"
  | "captured_at"
  | "region"
  | "invocation_type"
  | "source"
  | "environment"
  | "build_sha"
  | "workspace_id"
  | "user_id"
  | "context_user_id"
  | "workstream_id"
  | "substream_id"
  | "trace_id"
  | "request_id"
  | "parent_request_id"
  | "draft_id"
  | "inference_request_id"
> {
  return {
    schema_version: INFERENCE_LAKEHOUSE_SCHEMA_VERSION,
    event_id: eventId,
    event_type: eventType,
    captured_at: new Date(capturedAt).toISOString(),
    region: env.AVALON_REGION,
    invocation_type: invocationType,
    source: context.source,
    environment: env.APP_ENV,
    ...(env.BUILD_SHA ? { build_sha: env.BUILD_SHA } : {}),
    ...(context.workspaceId
      ? { workspace_id: context.workspaceId, user_id: context.workspaceId }
      : {}),
    ...(context.userId ? { context_user_id: context.userId } : {}),
    ...(context.workstreamId ? { workstream_id: context.workstreamId } : {}),
    ...(context.workstreamId ? { substream_id: context.substreamId ?? "0" } : {}),
    ...(context.traceId ?? context.requestId
      ? { trace_id: context.traceId ?? context.requestId }
      : {}),
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.parentRequestId ? { parent_request_id: context.parentRequestId } : {}),
    ...(context.draftId ? { draft_id: context.draftId } : {}),
    inference_request_id: inferenceRequestId,
  };
}

function payloadObjectKey(record: InferenceLakehouseRecord): string {
  return `inference-lakehouse/records/${record.captured_at.slice(0, 10)}/${record.event_id}.json`;
}

/**
 * Persist first, then enqueue a compact pointer. Queue messages top out at
 * 128 KB while Pipeline ingestion accepts 5 MB, and multimodal inference bodies
 * can exceed either. Global R2 is the durable hand-off that keeps the exact
 * record available without truncating it to fit the transport.
 */
export async function stageInferenceLakehouseRecord(
  env: Pick<Env, "AVALON_REGION" | "PAYLOADS" | "INFERENCE_LAKEHOUSE_QUEUE">,
  input: InferenceLakehouseRecord,
): Promise<InferenceLakehousePointer> {
  const record = InferenceLakehouseRecordSchema.parse(input);
  if (record.region !== env.AVALON_REGION) {
    throw new Error(`inference_lakehouse_region_mismatch:${record.region}:${env.AVALON_REGION}`);
  }
  const queue = env.INFERENCE_LAKEHOUSE_QUEUE;
  if (!queue) throw new Error("inference_lakehouse_queue_binding_missing");
  const serialized = JSON.stringify(record);
  const payloadBytes = new TextEncoder().encode(serialized).byteLength;
  const payloadSha256 = await sha256(serialized);
  const objectKey = payloadObjectKey(record);
  const pointer: InferenceLakehousePointer = {
    schemaVersion: INFERENCE_LAKEHOUSE_SCHEMA_VERSION,
    eventId: record.event_id,
    region: record.region,
    objectKey,
    payloadSha256,
    payloadBytes,
    capturedAt: record.captured_at,
  };

  await env.PAYLOADS.put(objectKey, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      eventId: record.event_id,
      eventType: record.event_type,
      region: record.region,
      payloadSha256,
    },
  });
  try {
    await queue.send(pointer, { contentType: "json" });
  } catch (error) {
    await env.PAYLOADS.delete(objectKey).catch(() => undefined);
    throw error;
  }
  return pointer;
}

async function captureBestEffort(env: Env, record: InferenceLakehouseRecord): Promise<void> {
  // Local Wrangler cannot emulate Pipeline bindings. Hosted deployments require
  // both bindings in `withEnvContract`; local/test environments omit them and
  // deliberately skip lakehouse capture instead of creating R2 orphans.
  if (!env.INFERENCE_LAKEHOUSE || !env.INFERENCE_LAKEHOUSE_QUEUE) return;
  try {
    const pointer = await stageInferenceLakehouseRecord(env, record);
    logStructuredEvent(env, "info", "inference_lakehouse_staged", {
      event_id: record.event_id,
      event_type: record.event_type,
      inference_request_id: record.inference_request_id,
      workspace_id: record.workspace_id,
      workstream_id: record.workstream_id,
      substream_id: record.substream_id,
      source: record.source,
      object_key: pointer.objectKey,
      payload_bytes: pointer.payloadBytes,
      payload_sha256: pointer.payloadSha256,
    });
  } catch (error) {
    logStructuredEvent(env, "warn", "inference_lakehouse_stage_failed", {
      event_id: record.event_id,
      event_type: record.event_type,
      inference_request_id: record.inference_request_id,
      workspace_id: record.workspace_id,
      workstream_id: record.workstream_id,
      substream_id: record.substream_id,
      source: record.source,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function captureStreamingInferenceRequest(
  env: Env,
  context: InferenceLakehouseContext,
  request: InferenceRequestEvent,
  providerRequestIssuedAt = Date.now(),
): Promise<void> {
  return captureBestEffort(env, {
    ...commonRecord(
      env,
      context,
      `${request.inferenceRequestId}:request`,
      "request",
      "streaming",
      request.inferenceRequestId,
      providerRequestIssuedAt,
    ),
    turn_id: request.turnId,
    provider: request.provider,
    model: request.model,
    provider_model: request.providerInvocationModel,
    request: { ...request.payload },
    metadata: {
      cursor: request.cursor,
      messageCount: request.payload.messages.length,
      toolCount: request.payload.tools?.length ?? 0,
      ...(context.operationId ? { operationId: context.operationId } : {}),
      ...(context.journey ? { journey: context.journey } : {}),
      ...(context.requestReceivedAt !== undefined ? {
        requestReceivedAt: new Date(context.requestReceivedAt).toISOString(),
        ...(providerRequestIssuedAt >= context.requestReceivedAt
          ? { requestToInferenceStartMs: providerRequestIssuedAt - context.requestReceivedAt }
          : { requestClockSkewed: true }),
      } : {}),
      providerRequestIssuedAt: new Date(providerRequestIssuedAt).toISOString(),
    },
  });
}

export function captureStreamingInferenceAttempt(
  env: Env,
  context: InferenceLakehouseContext,
  attempt: InferenceAttemptEvent,
): Promise<void> {
  return captureBestEffort(env, {
    ...commonRecord(
      env,
      context,
      `${attempt.inferenceRequestId}:attempt`,
      "attempt",
      "streaming",
      attempt.inferenceRequestId,
    ),
    turn_id: attempt.turnId,
    provider: attempt.provider,
    model: attempt.model,
    provider_model: attempt.providerInvocationModel,
    success: attempt.success,
    ...(attempt.disposition ? { disposition: attempt.disposition } : {}),
    ...(attempt.failureKind ? { failure_kind: attempt.failureKind } : {}),
    latency_ms: attempt.latencyMs,
    ...(attempt.ttftMs !== undefined ? { ttft_ms: attempt.ttftMs } : {}),
    ...(attempt.inputTokens !== undefined ? { input_tokens: attempt.inputTokens } : {}),
    ...(attempt.outputTokens !== undefined ? { output_tokens: attempt.outputTokens } : {}),
    ...(attempt.reasoningTokens !== undefined ? { reasoning_tokens: attempt.reasoningTokens } : {}),
    ...(attempt.cachedInputTokens !== undefined ? { cached_input_tokens: attempt.cachedInputTokens } : {}),
    ...(attempt.costCents !== undefined
      ? { cost_microusd: Math.max(0, Math.round(attempt.costCents * 10_000)) }
      : {}),
    ...(attempt.responseBytes !== undefined ? { response_bytes: attempt.responseBytes } : {}),
    ...(attempt.response ? { response: { ...attempt.response } } : {}),
    ...(attempt.providerError ? { error: { providerError: attempt.providerError } } : {}),
    metadata: { cursor: attempt.cursor },
  });
}

/** Capture the request/terminal pair emitted by one structured provider call. */
export function captureStructuredInferenceDiagnostic(
  env: Env,
  context: InferenceLakehouseContext,
  diagnostic: StructuredModelDiagnostic,
): Promise<void> {
  if (!diagnostic.inferenceRequestId) return Promise.resolve();
  const traceContext = diagnostic.traceId
    ? { ...context, traceId: diagnostic.traceId }
    : context;
  if (diagnostic.stage === "model_request" && diagnostic.requestPayload) {
    return captureBestEffort(env, {
      ...commonRecord(
        env,
        traceContext,
        `${diagnostic.inferenceRequestId}:request`,
        "request",
        "structured",
        diagnostic.inferenceRequestId,
      ),
      schema_name: diagnostic.schemaName,
      provider: diagnostic.provider ?? "openrouter",
      model: diagnostic.model,
      provider_model: diagnostic.model,
      request: diagnostic.requestPayload,
      metadata: {
        attempt: diagnostic.attempt,
        fallbackAttempt: diagnostic.fallbackAttempt,
        repairAttempt: diagnostic.repairAttempt,
      },
    });
  }
  if (diagnostic.stage !== "complete") return Promise.resolve();
  return captureBestEffort(env, {
    ...commonRecord(
      env,
      traceContext,
      `${diagnostic.inferenceRequestId}:attempt`,
      "attempt",
      "structured",
      diagnostic.inferenceRequestId,
    ),
    schema_name: diagnostic.schemaName,
    provider: diagnostic.provider ?? "openrouter",
    model: diagnostic.model,
    provider_model: diagnostic.model,
    ...(diagnostic.success !== undefined ? { success: diagnostic.success } : {}),
    ...(diagnostic.failureKind ? { failure_kind: diagnostic.failureKind } : {}),
    ...(diagnostic.latencyMs !== undefined ? { latency_ms: diagnostic.latencyMs } : {}),
    ...(diagnostic.inputTokens !== undefined ? { input_tokens: diagnostic.inputTokens } : {}),
    ...(diagnostic.outputTokens !== undefined ? { output_tokens: diagnostic.outputTokens } : {}),
    ...(diagnostic.reasoningTokens !== undefined ? { reasoning_tokens: diagnostic.reasoningTokens } : {}),
    ...(diagnostic.cachedInputTokens !== undefined
      ? { cached_input_tokens: diagnostic.cachedInputTokens }
      : {}),
    ...(diagnostic.responseBytes !== undefined ? { response_bytes: diagnostic.responseBytes } : {}),
    ...(diagnostic.responsePayload ? { response: diagnostic.responsePayload } : {}),
    ...(diagnostic.providerError ? { error: { providerError: diagnostic.providerError } } : {}),
    metadata: {
      attempt: diagnostic.attempt,
      fallbackAttempt: diagnostic.fallbackAttempt,
      repairAttempt: diagnostic.repairAttempt,
      validationIssues: diagnostic.validationIssues ?? [],
    },
  });
}

export { InferenceLakehouseRecordSchema };
