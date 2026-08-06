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

function projectionEnv(
  rows: ToolRow[],
  outputs: Record<string, unknown>,
  stalledReplayStage?: "get" | "body",
): Env {
  return {
    DB: {
      prepare: (sql: string) => new ProjectionStatement(sql, rows) as unknown as D1PreparedStatement,
    } as D1Database,
    PAYLOADS: {
      get: vi.fn(async (key: string) => {
        if (stalledReplayStage === "get") return new Promise<R2ObjectBody | null>(() => {});
        if (!(key in outputs)) return null;
        const body = JSON.stringify({ replayVersion: 1, output: outputs[key] });
        return {
          size: new TextEncoder().encode(body).byteLength,
          text: stalledReplayStage === "body"
            ? () => new Promise<string>(() => {})
            : async () => body,
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
    attachments: [],
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
  it("renders selected labels, custom text, and skips into the continuation turn", () => {
    const selected = __integrationTesting.renderElicitationResponseMessage({
      prompt: "What should I review?",
      response_type: "multi_select",
      options_json: JSON.stringify([
        { value: "offer", label: "Draft offer", description: "Review the offer on its own terms." },
      ]),
      answer_json: JSON.stringify(["offer", "Also check the cap table"]),
    });
    const skipped = __integrationTesting.renderElicitationResponseMessage({
      prompt: "Which environment?",
      response_type: "single_select",
      options_json: JSON.stringify([{ value: "staging", label: "Staging", description: null }]),
      answer_json: null,
    });

    expect(selected.role).toBe("user");
    expect(selected.content).toContain('"label":"Draft offer"');
    expect(selected.content).toContain('"customResponse":"Also check the cap table"');
    expect(skipped.content).toContain('"skipped":true');

    const persisted = __integrationTesting.projectElicitationResponseMessage({
      kind: "elicitation_response",
      elicitation: {
        id: "00000000-0000-4000-8000-000000000031",
        workstreamId: WORKSTREAM_ID,
        harnessRunId: PRIOR_RUN_ID,
        prompt: "What should I review?",
        responseType: "multi_select",
        options: [{ value: "offer", label: "Draft offer", description: null }],
        minimumSelections: 1,
        maximumSelections: 2,
        targetUserId: null,
        status: "answered",
        answer: ["offer", "Also check the cap table"],
        answeredByUserId: USER_ID,
        createdAt: "2026-08-01T00:00:00.000Z",
        answeredAt: "2026-08-01T00:01:00.000Z",
      },
    });
    expect(persisted?.content).toContain('"customResponse":"Also check the cap table"');
  });

  it("keeps the durable elicitation response in chronological model history", async () => {
    const response = message("00000000-0000-4000-8000-000000000032", 2, {
      author: "human",
      messageType: "elicitation",
      structuredContent: {
        kind: "elicitation_response",
        elicitation: {
          id: "00000000-0000-4000-8000-000000000031",
          workstreamId: WORKSTREAM_ID,
          harnessRunId: PRIOR_RUN_ID,
          prompt: "Which environment?",
          responseType: "single_select",
          options: [{ value: "staging", label: "Staging", description: null }],
          minimumSelections: 1,
          maximumSelections: 1,
          targetUserId: null,
          status: "answered",
          answer: "staging",
          answeredByUserId: USER_ID,
          createdAt: "2026-08-01T00:00:00.000Z",
          answeredAt: "2026-08-01T00:01:00.000Z",
        },
      },
    });
    const projection = await __integrationTesting.projectModelProtocolTranscript(
      projectionEnv([], {}),
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: null },
      [
        message("00000000-0000-4000-8000-000000000030", 1, { author: "human", textContent: "Deploy the app" }),
        response,
        message("00000000-0000-4000-8000-000000000033", 3, { author: "agent", textContent: "Deploying to staging." }),
      ],
    );

    expect(projection.messages.map((entry) => entry.role)).toEqual(["user", "user", "assistant"]);
    expect(projection.messages[1]?.content).toContain('"label":"Staging"');
  });

  it("fences an earlier attempt at its trigger while a later message is already queued", async () => {
    const prior = message("00000000-0000-4000-8000-000000000021", 1, {
      author: "human",
      textContent: "First question",
    });
    const trigger = message("00000000-0000-4000-8000-000000000022", 2, {
      author: "human",
      textContent: "Question for run A",
    });
    const queued = message("00000000-0000-4000-8000-000000000023", 3, {
      author: "human",
      textContent: "Question for queued run B",
    });
    const allMessages = [prior, trigger, queued];
    const first = vi.fn(async () => ({ sequence_number: trigger.sequenceNumber }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const listMessages = vi.fn(async (
      _workspaceId: string,
      _workstreamId: string,
      limit: number,
      beforeSequence?: number,
    ) => allMessages.filter((entry) => entry.sequenceNumber < (beforeSequence ?? Infinity)).slice(-limit));

    const stored = await __integrationTesting.loadTriggerFencedTranscriptMessages(
      { DB: { prepare } as unknown as D1Database },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        triggerMessageId: trigger.id,
      },
      listMessages,
    );

    expect(bind).toHaveBeenCalledWith(trigger.id, WORKSPACE_ID, WORKSTREAM_ID);
    expect(listMessages).toHaveBeenCalledWith(WORKSPACE_ID, WORKSTREAM_ID, 250, 3);
    expect(stored.map((entry) => entry.id)).toEqual([prior.id, trigger.id]);
    expect(stored.map((entry) => entry.textContent)).not.toContain(queued.textContent);
  });

  it("fails closed when the immutable trigger message cannot be resolved", async () => {
    const first = vi.fn(async () => null);
    const bind = vi.fn(() => ({ first }));
    const listMessages = vi.fn(async () => [] as Message[]);

    await expect(__integrationTesting.loadTriggerFencedTranscriptMessages(
      { DB: { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        triggerMessageId: "00000000-0000-4000-8000-000000000099",
      },
      listMessages,
    )).rejects.toMatchObject({ code: "trigger_message_not_found" });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("paginates the complete durable transcript instead of silently keeping a fixed tail", async () => {
    const allMessages = Array.from({ length: 300 }, (_, index) => message(
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      index + 1,
      { author: "human", textContent: `Message ${index + 1}` },
    ));
    const listMessages = vi.fn(async (
      _workspaceId: string,
      _workstreamId: string,
      limit: number,
      beforeSequence?: number,
    ) => allMessages
      .filter((entry) => entry.sequenceNumber < (beforeSequence ?? Infinity))
      .slice(-limit));

    const stored = await __integrationTesting.loadTriggerFencedTranscriptMessages(
      { DB: {} as D1Database },
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: null },
      listMessages,
    );

    expect(stored).toHaveLength(300);
    expect(stored[0]?.sequenceNumber).toBe(1);
    expect(stored.at(-1)?.sequenceNumber).toBe(300);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it.each(["get", "body"] as const)(
    "falls back to the durable summary when the R2 replay %s never settles",
    async (stalledReplayStage) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const completed = "00000000-0000-4000-8000-000000000041";
        const call = `${PRIOR_RUN_ID}:turn:1:tool:0`;
        const env = projectionEnv([{
          message_id: completed,
          harness_run_id: PRIOR_RUN_ID,
          tool_call_id: call,
          tool_name: "connection_a_search",
          input_json: '{"query":"first"}',
          output_ref: "results/stalled.json",
          output_summary: "Stored summary",
          status: "completed",
          error_json: null,
        }], {
          "results/stalled.json": { records: [{ id: "one" }] },
        }, stalledReplayStage);
        const projectionPromise = __integrationTesting.projectModelProtocolTranscript(env, {
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          triggerMessageId: null,
        }, [
          message("00000000-0000-4000-8000-000000000040", 1, {
            author: "human",
            textContent: "Find the record",
          }),
          message(completed, 2, {
            author: "agent",
            messageType: "tool",
            structuredContent: { invocation: {} },
          }),
          message("00000000-0000-4000-8000-000000000042", 3, {
            author: "human",
            textContent: "Continue",
          }),
        ]);

        await vi.advanceTimersByTimeAsync(2_000);
        const projection = await projectionPromise;

        expect(projection.messages).toContainEqual({
          role: "tool",
          tool_call_id: call,
          content: JSON.stringify({
            success: true,
            data: {
              summary: "Stored summary",
              resultAvailability: "summary_only",
            },
          }),
        });
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({
          event: "tool_replay_payload_timeout",
          output_ref: "results/stalled.json",
          stage: stalledReplayStage,
          timeout_ms: 2_000,
        }));
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

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
        toolTimeoutMs: 100,
        maxWebResults: 4,
      },
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: "00000000-0000-4000-8000-000000000020",
      executionPrincipal: { type: "user", userId: USER_ID },
      systemPrompt: "Continue from durable, matched protocol history.",
      messages: projection.messages,
      corePlugins: [],
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
