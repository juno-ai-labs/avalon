import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";
import type { InferenceRequestEvent } from "@rally/agent-harness";
import type { Env } from "../src/env";
import { createAgentInferenceLogger } from "../src/services/agent-inference-logging";
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

function fixture(options: { beforePut?: () => Promise<void> } = {}) {
  const put = vi.fn(async (key: string, value: unknown) => {
    void key;
    void value;
    await options.beforePut?.();
  });
  const env = createTestEnv({
    DB: createTestD1Database({
      prepare() {
        throw new Error("legacy_inference_d1_path_used");
      },
    }),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put }),
    ...(options.beforePut
      ? {
          INFERENCE_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["INFERENCE_LAKEHOUSE"]>>({
            async send() {},
          }),
          INFERENCE_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
            async send() {},
          }),
        }
      : {}),
    LOG_LEVEL: "error",
    AVALON_REGION: "global",
    APP_ENV: "production",
  });
  return { env, put };
}

const request = {
  inferenceRequestId: "00000000-0000-7000-8000-000000000090",
  turnId: "run-1:turn:1",
  model: "x-ai/grok-4.3",
  providerInvocationModel: "x-ai/grok-4.3",
  provider: "openrouter",
  cursor: {
    structuredOutputAttempt: 0,
    stageIndex: 0,
    candidateIndex: 0,
    endpointAttempt: 0,
  },
  payload: {
    model: "x-ai/grok-4.3",
    messages: [{ role: "user" as const, content: "Inspect the latest deployment" }],
    stream: true as const,
    stream_options: { include_usage: true as const },
    tools: [{ type: "function", function: { name: "github_read", parameters: { type: "object" } } }],
    tool_choice: "auto" as const,
  },
} satisfies InferenceRequestEvent;

describe("agent inference logging", () => {
  it("defers lakehouse staging so provider dispatch does not wait on R2", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const env = createTestEnv({
      APP_ENV: "production",
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn(() => blocked) }),
      INFERENCE_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({ send: vi.fn() }),
      INFERENCE_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["INFERENCE_LAKEHOUSE"]>>({ send: vi.fn() }),
    });
    const deferred: Promise<unknown>[] = [];
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
      requestReceivedAt: Date.now() - 100,
      journey: "message_send",
    }, (task) => deferred.push(task));

    await expect(logger.onRequest(request)).resolves.toBeUndefined();
    expect(deferred).toHaveLength(1);
    release();
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("defers terminal attempt staging so the next run step does not wait on R2", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const env = createTestEnv({
      APP_ENV: "production",
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn(() => blocked) }),
      INFERENCE_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({ send: vi.fn() }),
      INFERENCE_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["INFERENCE_LAKEHOUSE"]>>({ send: vi.fn() }),
    });
    const deferred: Promise<unknown>[] = [];
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
    }, (task) => deferred.push(task));

    await expect(logger.onAttempt({
      inferenceRequestId: request.inferenceRequestId,
      success: true,
      turnId: request.turnId,
      model: request.model,
      provider: request.provider,
      providerInvocationModel: request.providerInvocationModel,
      cursor: request.cursor,
      latencyMs: 340,
    })).resolves.toBeUndefined();
    expect(deferred).toHaveLength(1);
    release();
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("has no legacy D1 or agent-inference R2 path", async () => {
    const { env, put } = fixture();
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      substreamId: "substream-7",
      requestId: "run-1",
      source: "workstream",
    });

    await expect(logger.onRequest(request)).resolves.toBeUndefined();

    // Hosted environments use the always-on lakehouse. With that binding absent
    // locally, capture is a no-op: there is no workspace flag lookup, D1 index,
    // or legacy agent-inference/ object write to fall back to.
    expect(put).not.toHaveBeenCalled();
  });

  it("records what the provider said about a rejection, not only that it refused", async () => {
    const { env } = fixture();
    env.LOG_LEVEL = "info";
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      substreamId: "substream-7",
      requestId: "run-1",
      source: "workstream",
    });

    await logger.onAttempt({
      inferenceRequestId: request.inferenceRequestId,
      success: false,
      turnId: request.turnId,
      model: request.model,
      provider: request.provider,
      providerInvocationModel: request.providerInvocationModel,
      cursor: { ...request.cursor, endpointAttempt: 1 },
      latencyMs: 340,
      disposition: "fallback",
      failureKind: "api",
      providerError: {
        code: 400,
        providerName: "xAI",
        detail: '{"error":{"code":400,"message":"tool parameter root must be an object type"}}',
      },
    });

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toMatchObject({
      level: "warn",
      event: "agent_inference_attempt_failed",
      workspace_id: "workspace-1",
      substream_id: "substream-7",
      model: "x-ai/grok-4.3",
      disposition: "fallback",
      failure_kind: "api",
      provider_error_code: 400,
      provider_error_provider: "xAI",
      provider_error_detail: '{"error":{"code":400,"message":"tool parameter root must be an object type"}}',
    });
    // `message` stays the logger's own row summary; the provider's string is a
    // field beside it, which is what the saved views filter on.
    const entry = logged.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry.message).toBe("agent_inference_attempt_failed");
    logged.mockRestore();
  });

  it("gives enterprise the same reason it gives Global, which archives nothing", async () => {
    const { env, put } = fixture();
    env.AVALON_REGION = "enterprise";
    env.LOG_LEVEL = "info";
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
    });

    await logger.onAttempt({
      inferenceRequestId: request.inferenceRequestId,
      success: false,
      turnId: request.turnId,
      model: "openai/gpt-5.6-sol",
      provider: "azure",
      providerInvocationModel: "gpt-5.6-sol",
      cursor: { ...request.cursor, endpointAttempt: 1 },
      latencyMs: 1386,
      disposition: "fallback",
      failureKind: "http",
      providerError: {
        code: "invalid_function_parameters",
        detail: '{"error":{"message":"Invalid schema for function \'table_query\'."}}',
      },
    });

    // enterprise inference is deliberately never archived, so the regional log row is
    // the only account of the refusal there will ever be. It carries the same
    // string Global's does.
    expect(put).not.toHaveBeenCalled();
    expect(logged.mock.calls[0]![0]).toMatchObject({
      event: "agent_inference_attempt_failed",
      region: "enterprise",
      provider_error_code: "invalid_function_parameters",
      provider_error_detail: '{"error":{"message":"Invalid schema for function \'table_query\'."}}',
    });
    logged.mockRestore();
  });

  it("stays quiet when a run is cancelled", async () => {
    const { env } = fixture();
    env.LOG_LEVEL = "info";
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      requestId: "run-1",
      source: "workstream",
    });

    await logger.onAttempt({
      inferenceRequestId: request.inferenceRequestId,
      success: false,
      turnId: request.turnId,
      model: request.model,
      provider: request.provider,
      providerInvocationModel: request.providerInvocationModel,
      cursor: request.cursor,
      latencyMs: 12,
      disposition: "cancelled",
    });

    expect(logged.mock.calls.some(([entry]) => (
      entry as { event?: string }
    ).event === "agent_inference_started")).toBe(false);
    logged.mockRestore();
  });

  it("does not make provider dispatch wait for exact request archival", async () => {
    let releasePut!: () => void;
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const { env, put } = fixture({ beforePut: async () => { await putReleased; } });
    env.LOG_LEVEL = "info";
    const deferred: Promise<unknown>[] = [];
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
    }, (promise) => deferred.push(promise));

    const callback = logger.onRequest(request);
    let callbackSettled = false;
    void callback.then(() => { callbackSettled = true; });
    try {
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(callbackSettled).toBe(true);

      let archiveSettled = false;
      void deferred[0]!.then(() => { archiveSettled = true; });
      await Promise.resolve();
      expect(archiveSettled).toBe(false);
    } finally {
      releasePut();
      await callback;
      await Promise.all(deferred);
    }
  });

  it("records request-to-dispatch timing only for the first provider request", async () => {
    const { env, put } = fixture({ beforePut: async () => {} });
    env.LOG_LEVEL = "info";
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const requestReceivedAt = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(requestReceivedAt + 100);
    const deferred: Promise<unknown>[] = [];
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
      requestReceivedAt,
      journey: "message_send",
    }, (promise) => deferred.push(promise));

    try {
      await logger.onRequest(request);
      await logger.onRequest({
        ...request,
        inferenceRequestId: "00000000-0000-7000-8000-000000000091",
        turnId: "run-1:turn:2",
      });
      await Promise.all(deferred);

      expect(logged.mock.calls.filter(([entry]) => (
        entry as { event?: string }
      ).event === "agent_inference_started")).toHaveLength(1);
      const records = put.mock.calls.map((call) => JSON.parse(String(call[1])) as {
        metadata: Record<string, unknown>;
      });
      expect(records[0]?.metadata).toMatchObject({
        journey: "message_send",
        requestToInferenceStartMs: 100,
      });
      expect(records[1]?.metadata).not.toHaveProperty("requestToInferenceStartMs");
    } finally {
      now.mockRestore();
      logged.mockRestore();
    }
  });

  it("does not emit a new inference-start SLO row for a recovered attempt", async () => {
    const { env } = fixture({ beforePut: async () => {} });
    env.LOG_LEVEL = "info";
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const deferred: Promise<unknown>[] = [];
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
      requestReceivedAt: Date.now() - 100,
      journey: "message_send",
      inferenceStartEligible: false,
    }, (promise) => deferred.push(promise));

    await logger.onRequest(request);
    await Promise.all(deferred);
    expect(logged.mock.calls.some(([entry]) => (
      entry as { event?: string }
    ).event === "agent_inference_started")).toBe(false);
    logged.mockRestore();
  });
});
