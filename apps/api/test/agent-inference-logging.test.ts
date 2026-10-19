import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";
import type { InferenceRequestEvent } from "@rally/agent-harness";
import type { Env } from "../src/env";
import {
  createAgentInferenceLogger,
  createInferenceStartBreakdownReporter,
  logAgentInferencePrepared,
} from "../src/services/agent-inference-logging";
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
  it("records only the first eligible provider request with complete plugin timings", () => {
    const { env } = fixture();
    env.LOG_LEVEL = "info";
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const activationDurations = new Map(
        Array.from({ length: 60 }, (_, index) => [
          `plugin-${index}`,
          { authorize_ms: index, persist_ms: index + 1 },
        ] as const),
      );
      const report = createInferenceStartBreakdownReporter(env, true, (inferenceRequestId) => ({
        fields: {
          request_id: "run-1",
          inference_request_id: inferenceRequestId,
          operation_id: "operation-1",
          initial_activation_requested_count: 60,
          initial_activation_persisted_count: 60,
          scope_persist_ms: 42,
          bind_plugin_reauth_ms: 17,
        },
        activationAuthorizationChecks: 60,
        activationDurations,
      }));
      report("inference-1");
      report("inference-2");
      createInferenceStartBreakdownReporter(env, false, () => {
        throw new Error("ineligible attempt must not take a snapshot");
      })("inference-3");

      const rows = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter((entry) => entry.event === "agent_inference_start_breakdown");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        request_id: "run-1",
        inference_request_id: "inference-1",
        operation_id: "operation-1",
        initial_activation_auth_check_count: 60,
        initial_activation_requested_count: 60,
        initial_activation_persisted_count: 60,
        scope_persist_ms: 42,
        bind_plugin_reauth_ms: 17,
      });
      expect(Object.keys(rows[0]?.initial_activation_details as object)).toHaveLength(60);
      expect(rows[0]?.initial_activation_details).toMatchObject({
        plugin_59: { plugin_id: "plugin-59", authorize_ms: 59, persist_ms: 60 },
      });
    } finally {
      logged.mockRestore();
    }
  });

  it("records preparation phases only for a first attempt and marks clock skew", () => {
    const { env } = fixture();
    env.LOG_LEVEL = "info";
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const context = {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      substreamId: "substream-7",
      requestId: "run-1",
      operationId: "operation-1",
      journey: "message_send" as const,
      source: "workstream" as const,
      requestReceivedAt: 900,
    };

    logAgentInferencePrepared(env, context, {
      runStartedAtMs: 1_000,
      initialAuthorityReadyAtMs: 1_040,
      harnessInputsReadyAtMs: 1_100,
      preparationFinishedAtMs: 1_125,
      breakdown: {
        initialIdentityRunMs: 12,
        persistedOutcomeMs: 8,
        initialRunAuthorityMs: 28,
        sidekickAuthorityMs: 16,
        sidekickRecommendationsMs: 9,
        leaseHeartbeatMs: 7,
        runContextMs: 38,
        transcriptBootstrapMs: 22,
        toolInventoryMs: 14,
        toolConstructionMs: 30,
        attachmentReplayMs: 15,
        transcriptBootstrapRequired: true,
        sidekickSnapshotReused: false,
        sidekickRecommendationsRead: true,
      },
    });
    logAgentInferencePrepared(env, { ...context, inferenceStartEligible: false }, {
      runStartedAtMs: 2_000,
      initialAuthorityReadyAtMs: 2_010,
      harnessInputsReadyAtMs: 2_020,
      preparationFinishedAtMs: 2_030,
      breakdown: {
        initialIdentityRunMs: 1,
        persistedOutcomeMs: 1,
        initialRunAuthorityMs: 1,
        sidekickAuthorityMs: 1,
        sidekickRecommendationsMs: 0,
        leaseHeartbeatMs: 1,
        runContextMs: 1,
        transcriptBootstrapMs: 1,
        toolInventoryMs: 1,
        toolConstructionMs: 1,
        attachmentReplayMs: 1,
        transcriptBootstrapRequired: false,
        sidekickSnapshotReused: true,
        sidekickRecommendationsRead: false,
      },
    });
    logAgentInferencePrepared(env, { ...context, requestId: "run-skewed", requestReceivedAt: 1_200 }, {
      runStartedAtMs: 1_000,
      initialAuthorityReadyAtMs: 1_040,
      harnessInputsReadyAtMs: 1_100,
      preparationFinishedAtMs: 1_125,
      breakdown: {
        initialIdentityRunMs: 12,
        persistedOutcomeMs: 8,
        initialRunAuthorityMs: 28,
        sidekickAuthorityMs: 16,
        sidekickRecommendationsMs: 9,
        leaseHeartbeatMs: 7,
        runContextMs: 38,
        transcriptBootstrapMs: 22,
        toolInventoryMs: 14,
        toolConstructionMs: 30,
        attachmentReplayMs: 15,
        transcriptBootstrapRequired: true,
        sidekickSnapshotReused: false,
        sidekickRecommendationsRead: true,
      },
    });

    const rows = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "agent_inference_prepared");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      request_id: "run-1",
      operation_id: "operation-1",
      journey: "message_send",
      request_to_prepared_ms: 225,
      request_clock_skewed: false,
      initial_authority_ms: 40,
      context_tools_ms: 60,
      scope_activation_routing_ms: 25,
      total_ms: 125,
      initial_identity_run_ms: 12,
      persisted_outcome_ms: 8,
      initial_run_authority_ms: 28,
      sidekick_authority_ms: 16,
      sidekick_recommendations_ms: 9,
      lease_heartbeat_ms: 7,
      run_context_ms: 38,
      transcript_bootstrap_ms: 22,
      tool_inventory_ms: 14,
      tool_construction_ms: 30,
      attachment_replay_ms: 15,
      transcript_bootstrap_required: true,
      sidekick_snapshot_reused: false,
      sidekick_recommendations_read: true,
    });
    expect(rows[1]).toMatchObject({
      request_id: "run-skewed",
      request_clock_skewed: true,
    });
    expect(rows[1]?.request_to_prepared_ms).toBeUndefined();
    logged.mockRestore();
  });

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
      // Background archive writes may finish in a different order than requests.
      const records = put.mock.calls.map((call) => JSON.parse(String(call[1])) as {
        inference_request_id: string;
        metadata: Record<string, unknown>;
      });
      expect(records).toHaveLength(2);
      const first = records.find((record) => record.inference_request_id === request.inferenceRequestId);
      const second = records.find((record) => record.inference_request_id === "00000000-0000-7000-8000-000000000091");
      expect(first?.metadata).toMatchObject({
        journey: "message_send",
        requestToInferenceStartMs: 100,
      });
      expect(second).toBeDefined();
      expect(second!.metadata).not.toHaveProperty("requestToInferenceStartMs");
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

describe("agent inference usage metering", () => {
  const attempt = (turnId: string, costCents?: number) => ({
    inferenceRequestId: `${turnId}-request`,
    success: true,
    turnId,
    model: request.model,
    provider: request.provider,
    providerInvocationModel: request.providerInvocationModel,
    cursor: request.cursor,
    latencyMs: 340,
    ...(costCents === undefined ? {} : { costCents }),
  });

  function meteredLogger(send: (body: unknown) => Promise<void>, usage: Parameters<typeof createAgentInferenceLogger>[1]["usage"]) {
    const env = createTestEnv({
      APP_ENV: "production",
      AVALON_REGION: "global",
      LOG_LEVEL: "warn",
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn() }),
      USAGE_QUEUE: createCloudflareTestBinding<Queue>({ send: vi.fn(send) }),
    });
    const deferred: Promise<unknown>[] = [];
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      userId: "user-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
      ...(usage ? { usage } : {}),
    }, (task) => deferred.push(task));
    return { logger, deferred };
  }

  it("sends one usage event per priced attempt, metering compaction separately", async () => {
    const sent: unknown[] = [];
    const { logger, deferred } = meteredLogger(async (body) => { sent.push(body); }, { activity: "sidekick_run", sidekickId: "sidekick-1" });

    await logger.onAttempt(attempt("run-1:turn:1", 1.25));
    await logger.onAttempt(attempt("run-1:compaction:0", 0.5));
    await Promise.all(deferred);

    expect(sent).toEqual([
      expect.objectContaining({
        v: 1, eventId: "inf:run-1:turn:1-request", workspaceId: "workspace-1", region: "global",
        activity: "sidekick_run", costMicrousd: 12_500, model: request.model,
        refs: { userId: "user-1", workstreamId: "workstream-1", substreamId: "0", sidekickId: "sidekick-1" },
      }),
      expect.objectContaining({ eventId: "inf:run-1:compaction:0-request", activity: "context_compaction", costMicrousd: 5_000 }),
    ]);
  });

  it("logs an unpriced attempt instead of recording it as free, and never fails on a lost send", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: unknown[] = [];
    const unpriced = meteredLogger(async (body) => { sent.push(body); }, { activity: "agent_run" });
    await unpriced.logger.onAttempt(attempt("run-1:turn:2"));
    await Promise.all(unpriced.deferred);
    expect(sent).toEqual([]);

    const failing = meteredLogger(async () => { throw new Error("queue_unavailable"); }, { activity: "agent_run" });
    await expect(failing.logger.onAttempt(attempt("run-1:turn:3", 1))).resolves.toBeUndefined();
    await Promise.all(failing.deferred);

    const events = warned.mock.calls.map(([entry]) => entry as { event?: string; event_id?: string });
    expect(events.filter((entry) => entry.event?.startsWith("usage_"))).toEqual([
      expect.objectContaining({ event: "usage_unpriced", event_id: "inf:run-1:turn:2-request" }),
      expect.objectContaining({ event: "usage_emit_failed", event_id: "inf:run-1:turn:3-request" }),
    ]);
    warned.mockRestore();
  });
});
