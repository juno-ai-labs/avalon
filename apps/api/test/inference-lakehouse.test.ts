import { describe, expect, it, vi } from "vitest";

import {
  PIPELINE_INGEST_REQUEST_BYTES,
  consumeInferenceLakehouseQueue,
  deliverInferenceLakehousePointer,
} from "../src/queues/inference-lakehouse-consumer";
import {
  captureStreamingInferenceAttempt,
  captureStreamingInferenceRequest,
  captureStructuredInferenceDiagnostic,
  stageInferenceLakehouseRecord,
  type InferenceLakehouseRecord,
} from "../src/services/inference-lakehouse";
import {
  createCloudflareTestBinding,
  createTestEnv,
} from "./helpers/cloudflare-test";

function record(overrides: Partial<InferenceLakehouseRecord> = {}): InferenceLakehouseRecord {
  return {
    schema_version: 1,
    event_id: "00000000-0000-7000-8000-000000000101:request",
    event_type: "request",
    captured_at: "2026-08-24T12:00:00.000Z",
    region: "global",
    invocation_type: "streaming",
    source: "workstream",
    environment: "production",
    workspace_id: "00000000-0000-7000-8000-000000000102",
    workstream_id: "00000000-0000-7000-8000-000000000103",
    substream_id: "0",
    inference_request_id: "00000000-0000-7000-8000-000000000101",
    turn_id: "turn-1",
    provider: "openrouter",
    model: "x-ai/grok-4.3",
    provider_model: "x-ai/grok-4.3",
    request: {
      model: "x-ai/grok-4.3",
      messages: [{ role: "user", content: "Keep the complete request" }],
      stream: true,
    },
    metadata: { cursor: { stageIndex: 0 }, toolCount: 14 },
    ...overrides,
  };
}

function fixture() {
  const objects = new Map<string, string>();
  const pointers: unknown[] = [];
  const delivered: InferenceLakehouseRecord[][] = [];
  const bucket = createCloudflareTestBinding<R2Bucket>({
    async put(key: string, value: string) {
      objects.set(key, value);
    },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  });
  const queue = createCloudflareTestBinding<Queue>({
    async send(body: unknown) {
      pointers.push(body);
    },
  });
  const env = createTestEnv({
    APP_ENV: "production",
    AVALON_REGION: "global",
    LOG_LEVEL: "error",
    PAYLOADS: bucket,
    INFERENCE_LAKEHOUSE_QUEUE: queue,
    INFERENCE_LAKEHOUSE: {
      async send(records: InferenceLakehouseRecord[]) {
        delivered.push(records);
      },
    },
  });
  return { env, objects, pointers, delivered };
}

describe("inference lakehouse", () => {
  it("maps complete streaming and structured inference metadata into joined rows", async () => {
    const { env, objects, pointers } = fixture();
    const context = {
      source: "workstream",
      workspaceId: "workspace-1",
      userId: "user-1",
      workstreamId: "workstream-1",
      substreamId: "substream-7",
      requestId: "run-1",
      parentRequestId: "parent-1",
      draftId: "draft-1",
    };
    await captureStreamingInferenceRequest(env, context, {
      inferenceRequestId: "stream-request-1",
      turnId: "turn-1",
      model: "canonical/model",
      provider: "openrouter",
      providerInvocationModel: "provider/model",
      cursor: { structuredOutputAttempt: 0, stageIndex: 1, candidateIndex: 0, endpointAttempt: 2 },
      payload: {
        model: "provider/model",
        messages: [{ role: "user", content: "exact request" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    });
    await captureStreamingInferenceAttempt(env, context, {
      inferenceRequestId: "stream-request-1",
      turnId: "turn-1",
      model: "canonical/model",
      provider: "openrouter",
      providerInvocationModel: "provider/model",
      cursor: { structuredOutputAttempt: 0, stageIndex: 1, candidateIndex: 0, endpointAttempt: 2 },
      success: true,
      disposition: "success",
      latencyMs: 123,
      ttftMs: 17,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 2,
      cachedInputTokens: 3,
      costCents: 0.0123,
      responseBytes: 44,
      response: {
        content: "complete response",
        toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
        finishReason: "stop",
        generationId: "generation-1",
      },
    });
    await captureStructuredInferenceDiagnostic(env, {
      source: "meeting_notes",
      workspaceId: "workspace-1",
      userId: "user-1",
    }, {
      stage: "model_request",
      schemaName: "briefing",
      model: "structured/model",
      attempt: 0,
      fallbackAttempt: 0,
      repairAttempt: 0,
      inferenceRequestId: "structured-request-1",
      requestPayload: { model: "structured/model", stream: false, messages: [] },
    });
    await captureStructuredInferenceDiagnostic(env, {
      source: "meeting_notes",
      workspaceId: "workspace-1",
      userId: "user-1",
    }, {
      stage: "complete",
      schemaName: "briefing",
      model: "structured/model",
      attempt: 0,
      fallbackAttempt: 0,
      repairAttempt: 0,
      inferenceRequestId: "structured-request-1",
      success: true,
      latencyMs: 71,
      inputTokens: 8,
      outputTokens: 2,
      responseBytes: 11,
      responsePayload: { id: "structured-generation", choices: [] },
    });

    const archived = pointers.map((pointer) =>
      JSON.parse(objects.get((pointer as { objectKey: string }).objectKey)!) as InferenceLakehouseRecord);
    expect(archived).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_id: "stream-request-1:request",
        user_id: "user-1",
        request_id: "run-1",
        parent_request_id: "parent-1",
        draft_id: "draft-1",
        substream_id: "substream-7",
        provider_model: "provider/model",
        request: expect.objectContaining({ messages: [{ role: "user", content: "exact request" }] }),
      }),
      expect.objectContaining({
        event_id: "stream-request-1:attempt",
        success: true,
        substream_id: "substream-7",
        ttft_ms: 17,
        cost_microusd: 123,
        response: expect.objectContaining({ generationId: "generation-1" }),
      }),
      expect.objectContaining({
        event_id: "structured-request-1:request",
        invocation_type: "structured",
        schema_name: "briefing",
        request: expect.objectContaining({ stream: false }),
      }),
      expect.objectContaining({
        event_id: "structured-request-1:attempt",
        latency_ms: 71,
        response: { id: "structured-generation", choices: [] },
      }),
    ]));
  });

  it("uses the canonical main substream for workstream inference without an explicit identity", async () => {
    const { env, objects, pointers } = fixture();

    await captureStructuredInferenceDiagnostic(env, {
      source: "workstream_description",
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
    }, {
      stage: "model_request",
      schemaName: "description",
      model: "structured/model",
      attempt: 0,
      fallbackAttempt: 0,
      repairAttempt: 0,
      inferenceRequestId: "main-substream-request",
      requestPayload: { model: "structured/model", stream: false, messages: [] },
    });

    const archived = JSON.parse(objects.get(
      (pointers[0] as { objectKey: string }).objectKey,
    )!) as InferenceLakehouseRecord;
    expect(archived).toMatchObject({
      workstream_id: "workstream-1",
      substream_id: "0",
    });
  });

  it("does not archive EU inference while EU analytics export is deferred", async () => {
    const { env, objects, pointers, delivered } = fixture();
    env.AVALON_REGION = "eu";

    await captureStreamingInferenceRequest(env, {
      source: "workstream",
      workspaceId: "workspace-eu",
      workstreamId: "workstream-eu",
      substreamId: "0",
    }, {
      inferenceRequestId: "eu-request-1",
      turnId: "turn-eu",
      model: "canonical/model",
      provider: "openrouter",
      providerInvocationModel: "provider/model",
      cursor: { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 },
      payload: {
        model: "provider/model",
        messages: [{ role: "user", content: "must stay out of analytics storage" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    });

    expect(objects.size).toBe(0);
    expect(pointers).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("archives the exact regional record, queues only a verified pointer, and delivers it", async () => {
    const { env, objects, pointers, delivered } = fixture();
    const expected = record();

    const pointer = await stageInferenceLakehouseRecord(env, expected);

    expect(pointers).toEqual([pointer]);
    expect(pointer).toMatchObject({
      eventId: expected.event_id,
      region: "global",
      payloadBytes: expect.any(Number),
      payloadSha256: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(JSON.parse(objects.get(pointer.objectKey)!)).toEqual(expected);

    await expect(deliverInferenceLakehousePointer(env, pointer)).resolves.toMatchObject({
      overflow: false,
      record: expected,
    });
    expect(delivered).toEqual([[expected]]);
    expect(objects.has(pointer.objectKey)).toBe(true);
  });

  it("keeps an oversized exact record in regional R2 and sends a queryable pointer row", async () => {
    const { env, objects, delivered } = fixture();
    const expected = record({ request: { body: "x".repeat(PIPELINE_INGEST_REQUEST_BYTES) } });
    const pointer = await stageInferenceLakehouseRecord(env, expected);

    const result = await deliverInferenceLakehousePointer(env, pointer);

    expect(result.overflow).toBe(true);
    expect(delivered[0]?.[0]).toMatchObject({
      event_id: expected.event_id,
      payload_object_key: pointer.objectKey,
      payload_sha256: pointer.payloadSha256,
      payload_bytes: pointer.payloadBytes,
      metadata: {
        overflow: {
          reason: "pipeline_ingest_request_limit",
          maximumBytes: PIPELINE_INGEST_REQUEST_BYTES,
          fullRecordAvailableInRegionalR2: true,
        },
      },
    });
    expect(delivered[0]?.[0]?.request).toBeUndefined();
    expect(objects.has(pointer.objectKey)).toBe(true);
  });

  it("acknowledges poison and cross-region pointers without touching storage", async () => {
    const { env } = fixture();
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      queue: "avalon-global-inference-lakehouse",
      messages: [
        { id: "bad", timestamp: new Date(), body: { nope: true }, attempts: 1, ack, retry },
        {
          id: "eu",
          timestamp: new Date(),
          body: {
            schemaVersion: 1,
            eventId: "eu-event",
            region: "eu",
            objectKey: "inference-lakehouse/records/eu-event.json",
            payloadSha256: "a".repeat(43),
            payloadBytes: 12,
            capturedAt: "2026-08-24T12:00:00.000Z",
          },
          attempts: 1,
          ack,
          retry,
        },
      ],
      metadata: { metrics: { backlogCount: 2, backlogBytes: 2 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<unknown>;

    await consumeInferenceLakehouseQueue(batch, env);

    expect(ack).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
  });
});
