import { describe, expect, it, vi } from "vitest";
import type { InferenceRequestEvent } from "@avalon/agent-harness";
import { createAgentInferenceLogger } from "../src/services/agent-inference-logging";
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function fixture(enabled: boolean) {
  const statements: RecordedStatement[] = [];
  const objects = new Map<string, string>();
  const db = createTestD1Database({
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first() {
          statements.push({ sql, values });
          return { log_agent_inference: enabled ? 1 : 0 };
        },
        async run() {
          statements.push({ sql, values });
          return { success: true, meta: { changes: 1 }, results: [] };
        },
      };
      return statement;
    },
  });
  const bucket = createCloudflareTestBinding<R2Bucket>({
    async put(key: string, value: string) {
      objects.set(key, value);
    },
    async delete(key: string) {
      objects.delete(key);
    },
  });
  const env = createTestEnv({
    DB: db,
    PAYLOADS: bucket,
    LOG_LEVEL: "error",
    AVALON_REGION: "global",
  });
  return { env, objects, statements };
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
  it("does nothing while the workspace preference is off", async () => {
    const { env, objects, statements } = fixture(false);
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
    });

    await logger.onRequest(request);

    expect(objects.size).toBe(0);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("SELECT log_agent_inference");
  });

  it("stores complete messages and tools in R2 and indexes actual OpenRouter usage", async () => {
    const { env, objects, statements } = fixture(true);
    const logger = createAgentInferenceLogger(env, {
      workspaceId: "workspace-1",
      requestId: "run-1",
      draftId: "00000000-0000-7000-8000-000000000091",
      source: "automation_compiler",
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T01:02:03.000Z"));

    await logger.onRequest(request);
    await logger.onAttempt({
      inferenceRequestId: request.inferenceRequestId,
      success: true,
      turnId: request.turnId,
      model: request.model,
      provider: request.provider,
      cursor: request.cursor,
      latencyMs: 1250,
      disposition: "success",
      inputTokens: 42_000,
      outputTokens: 800,
      reasoningTokens: 300,
      cachedInputTokens: 20_000,
      costCents: 1.25,
      responseBytes: 4096,
    });
    vi.useRealTimers();

    const storedObject = [...objects.entries()][0];
    expect(storedObject).toBeDefined();
    const [objectKey, serialized] = storedObject!;
    expect(objectKey).toBe(
      "agent-inference/workspace-1/2026-08-05/00000000-0000-7000-8000-000000000090.json",
    );
    expect(JSON.parse(serialized)).toMatchObject({
      metadata: {
        requestId: "run-1",
        draftId: "00000000-0000-7000-8000-000000000091",
        messageCount: 1,
        toolCount: 1,
      },
      request: {
        messages: [{ role: "user", content: "Inspect the latest deployment" }],
        tools: [{ function: { name: "github_read" } }],
      },
    });
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO agent_inference_payload_logs"));
    expect(insert?.values).toContain(objectKey);
    const update = statements.find((statement) => statement.sql.includes("UPDATE agent_inference_payload_logs"));
    expect(update?.values).toEqual(expect.arrayContaining([42_000, 800, 42_800, 300, 20_000, 12_500, 4096]));
  });

  it("records a provider rejection even while the payload ledger is off", async () => {
    const { env, objects, statements } = fixture(false);
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
      model: request.model,
      provider: request.provider,
      cursor: { ...request.cursor, endpointAttempt: 1 },
      latencyMs: 340,
      disposition: "fallback",
      failureKind: "api",
      providerError: { code: 400, message: "Provider returned error", providerName: "xAI" },
    });

    // The opt-in ledger stays off — no R2 object, no payload row.
    expect(objects.size).toBe(0);
    expect(statements.some((statement) => statement.sql.includes("UPDATE"))).toBe(false);
    // The rejection itself is operational and is always recorded; without this a
    // model call that OpenRouter refused left no trace in any channel.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toMatchObject({
      level: "warn",
      event: "agent_inference_attempt_failed",
      workspace_id: "workspace-1",
      model: "x-ai/grok-4.3",
      disposition: "fallback",
      failure_kind: "api",
      provider_error_code: 400,
      provider_error_provider: "xAI",
    });
    // The provider's free text is deliberately absent. Some upstreams quote the
    // request back inside it, and this line is written for every workspace into
    // Workers Logs and 90-day Logpush storage, where the key-based redactor has
    // no way to recognise it.
    const entry = logged.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty("provider_error_message");
    expect(JSON.stringify(entry)).not.toContain("Provider returned error");
    logged.mockRestore();
  });

  it("stays quiet when a run is cancelled", async () => {
    const { env } = fixture(false);
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
      cursor: request.cursor,
      latencyMs: 12,
      disposition: "cancelled",
    });

    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
