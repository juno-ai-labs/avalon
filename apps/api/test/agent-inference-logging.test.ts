import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createAgentInferenceLogger } from "../src/services/agent-inference-logging";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function fixture(enabled: boolean) {
  const statements: RecordedStatement[] = [];
  const objects = new Map<string, string>();
  const db = {
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
  } as unknown as D1Database;
  const bucket = {
    async put(key: string, value: string) {
      objects.set(key, value);
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  const env = {
    DB: db,
    PAYLOADS: bucket,
    LOG_LEVEL: "error",
    AVALON_REGION: "global",
  } as unknown as Env;
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
};

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
      workstreamId: "workstream-1",
      requestId: "run-1",
      source: "workstream",
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
});
