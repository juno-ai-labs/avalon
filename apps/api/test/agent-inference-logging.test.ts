import { describe, expect, it, vi } from "vitest";
import type { InferenceRequestEvent } from "@avalon/agent-harness";
import { createAgentInferenceLogger } from "../src/services/agent-inference-logging";
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

function fixture() {
  const put = vi.fn();
  const env = createTestEnv({
    DB: createTestD1Database({
      prepare() {
        throw new Error("legacy_inference_d1_path_used");
      },
    }),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put }),
    LOG_LEVEL: "error",
    AVALON_REGION: "global",
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

  it("records a provider rejection without provider-controlled prose", async () => {
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
      providerError: { code: 400, message: "Provider returned error", providerName: "xAI" },
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
    });
    const entry = logged.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty("provider_error_message");
    expect(JSON.stringify(entry)).not.toContain("Provider returned error");
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

    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
