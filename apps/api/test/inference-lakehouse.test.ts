import "../../../tests/isolated-region";
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
    async head(key: string) {
      return objects.has(key) ? { key } : null;
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
      operationId: "00000000-0000-7000-8000-000000000099",
      journey: "workstream_create" as const,
      requestReceivedAt: Date.parse("2026-09-17T20:00:00.000Z"),
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
    }, Date.parse("2026-09-17T20:00:00.425Z"));
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
    const requestRecord = JSON.parse(objects.get(
      "inference-lakehouse/records/2026-09-17/stream-request-1:request.json",
    ) ?? "null") as InferenceLakehouseRecord;
    expect(requestRecord).toMatchObject({
      metadata: {
        operationId: context.operationId,
        journey: "workstream_create",
        requestReceivedAt: "2026-09-17T20:00:00.000Z",
        providerRequestIssuedAt: "2026-09-17T20:00:00.425Z",
        requestToInferenceStartMs: 425,
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
      traceId: "structured-trace-1",
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
      traceId: "structured-trace-1",
      success: true,
      latencyMs: 71,
      inputTokens: 8,
      outputTokens: 2,
      costCents: 0.0456,
      responseBytes: 11,
      responsePayload: { id: "structured-generation", choices: [] },
    });

    const archived = pointers.map((pointer) =>
      JSON.parse(objects.get((pointer as { objectKey: string }).objectKey)!) as InferenceLakehouseRecord);
    expect(archived).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_id: "stream-request-1:request",
        user_id: "workspace-1",
        context_user_id: "user-1",
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
        trace_id: "structured-trace-1",
        request: expect.objectContaining({ stream: false }),
      }),
      expect.objectContaining({
        event_id: "structured-request-1:attempt",
        trace_id: "structured-trace-1",
        latency_ms: 71,
        // A structured call carried no cost at all, so every classifier,
        // extraction and repair call was free as far as spend reporting knew.
        cost_microusd: 456,
        response: { id: "structured-generation", choices: [] },
      }),
    ]));
  });

  it("labels each request body by its API and counts what that body carries", async () => {
    const { env, objects } = fixture();
    const context = { source: "workstream", workspaceId: "workspace-1", requestId: "run-1" };
    const cursor = { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 };
    // A Responses body: one tool round trip is three input items, not one message.
    await captureStreamingInferenceRequest(env, context, {
      inferenceRequestId: "responses-request",
      turnId: "turn-1",
      model: "openai/gpt-6.1-sol",
      provider: "openrouter",
      providerInvocationModel: "openai/gpt-6.1-sol",
      cursor,
      payload: {
        model: "openai/gpt-6.1-sol",
        input: [
          { type: "message", role: "user", content: "weather?" },
          { type: "function_call", id: "fc_call-1", call_id: "call-1", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call-1", output: "18C" },
        ],
        stream: true,
        usage: { include: true },
        tools: [{ type: "function", name: "lookup", parameters: null }],
      },
    }, Date.parse("2026-10-09T20:00:00.000Z"));
    await captureStreamingInferenceRequest(env, context, {
      inferenceRequestId: "chat-request",
      turnId: "turn-1",
      model: "x-ai/grok-4.6",
      provider: "azure",
      providerInvocationModel: "grok-4.6",
      cursor,
      payload: {
        model: "grok-4.6",
        messages: [{ role: "user", content: "weather?" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    }, Date.parse("2026-10-09T20:00:00.000Z"));

    const record = (id: string) => JSON.parse(objects.get(
      `inference-lakehouse/records/2026-10-09/${id}:request.json`,
    ) ?? "null") as InferenceLakehouseRecord;
    expect(record("responses-request").metadata).toMatchObject({ api: "responses", messageCount: 3, toolCount: 1 });
    expect(record("chat-request").metadata).toMatchObject({ api: "chat_completions", messageCount: 1, toolCount: 0 });
  });

  it("archives the rejection body a classification code cannot describe", async () => {
    const { env, objects, pointers } = fixture();
    // The 2 September Sol failure. `invalid_function_parameters` reached every
    // surface production has; nothing anywhere said which tool schema earned it.
    const rejection = {
      error: {
        message: "Invalid schema for function 'table_query': unsupported keyword.",
        type: "invalid_request_error",
        param: "tools[13].parameters",
        code: "invalid_function_parameters",
      },
    };

    await captureStreamingInferenceAttempt(env, {
      source: "workstream",
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
    }, {
      inferenceRequestId: "azure-rejection",
      success: false,
      turnId: "run-1:turn:1",
      model: "openai/gpt-5.6-sol",
      provider: "azure",
      providerInvocationModel: "gpt-5.6-sol",
      cursor: { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 },
      latencyMs: 1386,
      disposition: "fallback",
      failureKind: "http",
      providerError: {
        code: "invalid_function_parameters",
        detail: JSON.stringify(rejection),
      },
    });

    const archived = JSON.parse(objects.get(
      (pointers[0] as { objectKey: string }).objectKey,
    )!) as InferenceLakehouseRecord;
    expect(archived.error).toEqual({
      providerError: {
        code: "invalid_function_parameters",
        detail: JSON.stringify(rejection),
      },
    });
  });

  it("archives the rejection body on the structured branch too", async () => {
    const { env, objects, pointers } = fixture();

    await captureStructuredInferenceDiagnostic(env, {
      source: "workstream_naming",
      workspaceId: "workspace-1",
    }, {
      stage: "complete",
      schemaName: "name",
      model: "structured/model",
      attempt: 0,
      fallbackAttempt: 0,
      repairAttempt: 0,
      inferenceRequestId: "structured-rejection",
      success: false,
      failureKind: "provider_error",
      providerError: {
        code: 400,
        providerName: "Google",
        detail: '{"error":{"code":400,"message":"response_format is not supported"}}',
      },
    });

    // The streaming and structured captures write `error` through separate call
    // sites; the test that used to cover this one asserted the old contract and
    // went with it, leaving the branch green under any change.
    const archived = JSON.parse(objects.get(
      (pointers[0] as { objectKey: string }).objectKey,
    )!) as InferenceLakehouseRecord;
    expect(archived.error).toEqual({
      providerError: {
        code: 400,
        providerName: "Google",
        detail: '{"error":{"code":400,"message":"response_format is not supported"}}',
      },
    });
  });

  it("archives an unclassifiable rejection body on its own", async () => {
    const { env, objects, pointers } = fixture();

    await captureStreamingInferenceAttempt(env, {
      source: "workstream",
      workspaceId: "workspace-1",
    }, {
      inferenceRequestId: "gateway-rejection",
      success: false,
      turnId: "run-1:turn:1",
      model: "openai/gpt-5.6-sol",
      provider: "azure",
      providerInvocationModel: "gpt-5.6-sol",
      cursor: { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 },
      latencyMs: 120,
      disposition: "failed",
      failureKind: "http",
      providerError: { detail: "<html>upstream gateway refused</html>" },
    });

    // No classification to pair it with is precisely when the body is the only
    // evidence there is, so it must not be dropped for arriving alone.
    const archived = JSON.parse(objects.get(
      (pointers[0] as { objectKey: string }).objectKey,
    )!) as InferenceLakehouseRecord;
    expect(archived.error).toEqual({
      providerError: { detail: "<html>upstream gateway refused</html>" },
    });
  });

  it("uses the canonical main substream for workstream inference without an explicit identity", async () => {
    const { env, objects, pointers } = fixture();

    await captureStructuredInferenceDiagnostic(env, {
      source: "workstream_naming",
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

  it("archives inference for another configured deployment", async () => {
    const { env, objects, pointers, delivered } = fixture();
    env.AVALON_REGION = "enterprise";

    await captureStreamingInferenceRequest(env, {
      source: "workstream",
      workspaceId: "workspace-enterprise",
      workstreamId: "workstream-enterprise",
      substreamId: "0",
    }, {
      inferenceRequestId: "enterprise-request-1",
      turnId: "turn-enterprise",
      model: "canonical/model",
      provider: "openrouter",
      providerInvocationModel: "provider/model",
      cursor: { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 },
      payload: {
        model: "provider/model",
        messages: [{ role: "user", content: "a synthetic inference request" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    });

    expect(objects.size).toBe(1);
    expect(pointers).toHaveLength(1);
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
          id: "enterprise",
          timestamp: new Date(),
          body: {
            schemaVersion: 1,
            eventId: "enterprise-event",
            region: "enterprise",
            objectKey: "inference-lakehouse/records/enterprise-event.json",
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
