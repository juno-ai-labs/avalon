import { runHarness } from "@avalon/agent-harness";
import type { Message } from "@avalon/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const PRIOR_RUN_ID = "00000000-0000-4000-8000-000000000004";

type ToolRow = {
  message_id: string;
  harness_run_id: string;
  tool_call_id: string;
  tool_name: string;
  input_json: string;
  output_ref: string | null;
  output_summary: string | null;
  status: "pending" | "started" | "completed" | "failed" | "ambiguous";
  error_json: string | null;
};

class ProjectionStatement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly rows: ToolRow[],
  ) {}

  bind(...values: unknown[]): ProjectionStatement {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    expect(this.sql).toContain("JOIN tool_invocations ti ON ti.id = m.id");
    expect(this.values.slice(0, 2)).toEqual([WORKSPACE_ID, WORKSTREAM_ID]);
    const requested = new Set(this.values.slice(2).map(String));
    return {
      success: true,
      results: this.rows.filter((row) => requested.has(row.message_id)) as T[],
    } as D1Result<T>;
  }
}

function projectionEnv(rows: ToolRow[], outputs: Record<string, unknown>): Env {
  return {
    DB: {
      prepare: (sql: string) => new ProjectionStatement(sql, rows) as unknown as D1PreparedStatement,
    } as D1Database,
    PAYLOADS: {
      get: vi.fn(async (key: string) => {
        if (!(key in outputs)) return null;
        const body = JSON.stringify({ replayVersion: 1, output: outputs[key] });
        return {
          size: new TextEncoder().encode(body).byteLength,
          text: async () => body,
        } as R2ObjectBody;
      }),
    } as unknown as R2Bucket,
  } as Env;
}

function message(
  id: string,
  sequenceNumber: number,
  input: Partial<Pick<Message, "messageType" | "textContent" | "structuredContent">> & {
    author: "human" | "agent" | "system";
  },
): Message {
  return {
    id,
    clientMessageId: null,
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    author: input.author === "human"
      ? {
          type: "human",
          user: {
            id: USER_ID,
            email: "person@example.com",
            name: "Person",
            avatarUrl: null,
            timezone: "America/Los_Angeles",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        }
      : { type: input.author },
    messageType: input.messageType ?? "text",
    textContent: input.textContent ?? "",
    structuredContent: input.structuredContent ?? null,
    mentions: [],
    sequenceNumber,
    createdAt: `2026-08-01T00:00:0${sequenceNumber}.000Z`,
    editedAt: null,
  };
}

function streamResponse(content: string): Response {
  const chunk = JSON.stringify({
    id: "generation-second-run",
    model: "google/gemini-2.5-flash-lite",
    choices: [{ delta: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 4 },
  });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("durable UI-to-model transcript projection", () => {
  it("never splits a matched tool-call/result unit while bounding context", () => {
    const assistant = {
      role: "assistant" as const,
      content: null,
      tool_calls: [{
        id: "run:turn:1:tool:0",
        type: "function" as const,
        function: { name: "search", arguments: '{"query":"large"}' },
      }],
    };
    const tool = {
      role: "tool" as const,
      tool_call_id: "run:turn:1:tool:0",
      content: JSON.stringify({ success: true, data: { body: "x".repeat(2_000) } }),
    };
    const newest = { role: "user" as const, content: "Continue" };
    const systemPrompt = "Stable policy";
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const maxBytes = new TextEncoder().encode(systemPrompt).byteLength
      + bytes([newest])
      + bytes([assistant, tool])
      - 1;

    const bounded = __integrationTesting.boundModelContext(
      systemPrompt,
      [assistant, tool, newest],
      maxBytes,
    );

    expect(bounded.messages).toEqual([newest]);
  });

  it("reconstructs matched parallel tool protocol for a second run and omits dangling UI rows", async () => {
    const completedOne = "00000000-0000-4000-8000-000000000011";
    const completedTwo = "00000000-0000-4000-8000-000000000012";
    const dangling = "00000000-0000-4000-8000-000000000013";
    const missing = "00000000-0000-4000-8000-000000000014";
    const callOne = `${PRIOR_RUN_ID}:turn:1:tool:0`;
    const callTwo = `${PRIOR_RUN_ID}:turn:1:tool:1`;
    const danglingCall = `${PRIOR_RUN_ID}:turn:2:tool:0`;
    const storedMessages = [
      message("00000000-0000-4000-8000-000000000010", 1, { author: "human", textContent: "Find both records" }),
      message(completedOne, 2, { author: "agent", messageType: "tool", structuredContent: { invocation: {} } }),
      message(completedTwo, 3, { author: "agent", messageType: "tool", structuredContent: { invocation: {} } }),
      message("00000000-0000-4000-8000-000000000015", 4, { author: "agent", textContent: "I found both records." }),
      message(dangling, 5, { author: "agent", messageType: "tool", structuredContent: { invocation: {} } }),
      message(missing, 6, { author: "agent", messageType: "tool", structuredContent: { invocation: {} } }),
      message("00000000-0000-4000-8000-000000000016", 7, { author: "agent", textContent: "" }),
      message("00000000-0000-4000-8000-000000000017", 8, { author: "human", textContent: "Continue with those results" }),
    ];
    const env = projectionEnv([
      {
        message_id: completedOne,
        harness_run_id: PRIOR_RUN_ID,
        tool_call_id: callOne,
        tool_name: "connection_a_search",
        input_json: '{"query":"first"}',
        output_ref: "results/one.json",
        output_summary: "First record",
        status: "completed",
        error_json: null,
      },
      {
        message_id: completedTwo,
        harness_run_id: PRIOR_RUN_ID,
        tool_call_id: callTwo,
        tool_name: "connection_b_search",
        input_json: '{"query":"second"}',
        output_ref: "results/two.json",
        output_summary: "Second record",
        status: "completed",
        error_json: null,
      },
      {
        message_id: dangling,
        harness_run_id: PRIOR_RUN_ID,
        tool_call_id: danglingCall,
        tool_name: "connection_a_search",
        input_json: '{"query":"unfinished"}',
        output_ref: null,
        output_summary: null,
        status: "started",
        error_json: null,
      },
    ], {
      "results/one.json": { records: [{ id: "one" }] },
      "results/two.json": { records: [{ id: "two" }] },
    });

    const projection = await __integrationTesting.projectModelProtocolTranscript(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      triggerMessageId: null,
    }, storedMessages);

    expect(projection.messages.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "user",
    ]);
    expect(projection.messages[1]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: callOne, function: { name: "connection_a_search", arguments: '{"query":"first"}' } },
        { id: callTwo, function: { name: "connection_b_search", arguments: '{"query":"second"}' } },
      ],
    });
    expect(projection.messages[2]).toEqual({
      role: "tool",
      tool_call_id: callOne,
      content: JSON.stringify({ success: true, data: { records: [{ id: "one" }] } }),
    });
    expect(projection.messages[3]).toEqual({
      role: "tool",
      tool_call_id: callTwo,
      content: JSON.stringify({ success: true, data: { records: [{ id: "two" }] } }),
    });
    expect(projection.issues).toEqual(expect.arrayContaining([
      { kind: "dangling_tool_invocation", healed: true },
      { kind: "tool_message_without_invocation", healed: true },
      { kind: "empty_ui_message_omitted", healed: true },
    ]));
    expect(JSON.stringify(projection.messages)).not.toContain(danglingCall);

    const requestBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetcher = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as typeof requestBodies[number]);
      return streamResponse("Continued safely");
    }) as typeof fetch;
    const outcome = await runHarness({
      config: {
        apiKey: "test-key",
        primaryModel: "google/gemini-2.5-flash-lite",
        fetch: fetcher,
        maxIterations: 2,
        maxToolCalls: 4,
        maxWallClockMs: 1_000,
        maxContextBytes: 200_000,
        toolTimeoutMs: 100,
        maxWebResults: 4,
      },
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: "00000000-0000-4000-8000-000000000020",
      executionPrincipal: { type: "user", userId: USER_ID },
      systemPrompt: "Continue from durable, matched protocol history.",
      messages: projection.messages,
      tools: [],
      onEvent: () => {},
    });

    expect(outcome).toMatchObject({ status: "completed", content: "Continued safely" });
    expect(requestBodies).toHaveLength(1);
    const providerMessages = requestBodies[0]!.messages;
    expect(providerMessages.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(providerMessages)).toContain(callOne);
    expect(JSON.stringify(providerMessages)).toContain(callTwo);
    expect(JSON.stringify(providerMessages)).not.toContain(danglingCall);
  });
});
