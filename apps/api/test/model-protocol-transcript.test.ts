import { runHarness } from "@avalon/agent-harness";
import type { Message } from "@avalon/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const PRIOR_RUN_ID = "00000000-0000-4000-8000-000000000004";

type ToolRow = {
  invocation_id?: string;
  message_id: string;
  harness_run_id: string;
  tool_call_id: string;
  tool_name: string;
  input_json: string;
  output_ref: string | null;
  output_summary: string | null;
  status: "pending" | "started" | "completed" | "failed" | "ambiguous";
  error_json: string | null;
  execution_plan_json?: string | null;
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
    return createTestD1Result<T>({
      success: true,
      results: this.rows.filter((row) => requested.has(row.message_id)) as T[],
    });
  }
}

function projectionEnv(
  rows: ToolRow[],
  outputs: Record<string, unknown>,
  stalledReplayStage?: "get" | "body",
): Env {
  return createTestEnv({
    DB: createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement(new ProjectionStatement(sql, rows)),
    }),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({
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
    }),
  });
}

function attachmentProjectionEnv(resources: Array<Record<string, unknown>>, objects: Record<string, Uint8Array>): Env {
  return createTestEnv({
    DB: createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement({
        bind() { return this; },
        async run() { return createTestD1Result({ success: true }); },
        async all<T>() {
          return createTestD1Result<T>({
            success: true,
            results: (sql.includes("FROM resources") ? resources : []) as T[],
          });
        },
      }),
    }),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({
      async get(key: string) {
        const bytes = objects[key];
        return bytes ? {
          async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          },
        } as R2ObjectBody : null;
      },
    }),
  });
}

function message(
  id: string,
  sequenceNumber: number,
  input: Partial<Pick<Message, "messageType" | "textContent" | "structuredContent" | "attachments">> & {
    author: "human" | "external" | "agent" | "system";
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
      : input.author === "external"
        ? {
            type: "external",
            actor: {
              provider: "slack",
              providerAccountId: "T123",
              providerUserId: "U456",
              displayName: "Taylor",
              avatarUrl: null,
            },
          }
      : { type: input.author },
    messageType: input.messageType ?? "text",
    textContent: input.textContent ?? "",
    structuredContent: input.structuredContent ?? null,
    mentions: [],
    attachments: input.attachments ?? [],
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
  it("projects the triggering image with a same-ID durable manifest entry", async () => {
    const resourceId = "00000000-0000-4000-8000-000000000041";
    const triggerId = "00000000-0000-4000-8000-000000000042";
    const projection = await __integrationTesting.projectModelProtocolTranscript(
      attachmentProjectionEnv([{
        id: resourceId,
        title: "diagram.png",
        mime_type: "image/png",
        content_ref: "images/diagram.png",
        metadata_json: '{"size":8}',
        model_content_ref: "images/diagram.png",
        model_mime_type: "image/png",
        model_content_sha256: null,
        model_metadata_json: null,
        model_content_status: "ready",
        model_content_error_code: null,
      }], { "images/diagram.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: triggerId },
      [message(triggerId, 1, {
        author: "human",
        attachments: [{
          id: resourceId,
          fileName: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 8,
          contentAvailable: true,
          createdAt: "2026-08-01T00:00:01.000Z",
        }],
      })],
    );

    const content = projection.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const manifest = (content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    expect(manifest).toContain(`"resourceId":"${resourceId}"`);
    expect(manifest).toContain('"inlined":true');
    expect((content as Array<{ type: string }>).filter((part) => part.type === "image_url")).toHaveLength(1);
  });

  it("keeps historical attachment identities without replaying their bytes", async () => {
    const resourceId = "00000000-0000-4000-8000-000000000043";
    const projection = await __integrationTesting.projectModelProtocolTranscript(
      attachmentProjectionEnv([{
        id: resourceId,
        title: "notes.md",
        mime_type: "text/markdown",
        content_ref: "notes.md",
        metadata_json: '{"size":123}',
        model_content_ref: "notes.model.md",
        model_mime_type: "text/markdown",
        model_content_sha256: "a".repeat(64),
        model_metadata_json: null,
        model_content_status: "ready",
        model_content_error_code: null,
      }], { "notes.md": new TextEncoder().encode("historical secret bytes") }),
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: null },
      [message("00000000-0000-4000-8000-000000000044", 1, {
        author: "human",
        textContent: "Earlier context",
        attachments: [{
          id: resourceId,
          fileName: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 123,
          contentAvailable: true,
          createdAt: "2026-08-01T00:00:01.000Z",
        }],
      })],
    );

    const serialized = JSON.stringify(projection.messages);
    expect(serialized).toContain(resourceId);
    expect(serialized).toContain(String.raw`\"attachmentKind\":\"markdown\"`);
    expect(serialized).not.toContain("historical secret bytes");
    expect(serialized).not.toContain("Binary content is not replayed");
  });

  it("omits historical attachment tool output after current visibility is revoked", async () => {
    const invocationId = "00000000-0000-4000-8000-000000000045";
    const call = `${PRIOR_RUN_ID}:turn:1:tool:0`;
    const get = vi.fn(async () => ({
      async text() {
        return JSON.stringify({ replayVersion: 1, output: { text: "private note contents" } });
      },
    } as R2ObjectBody));
    const prepare = vi.fn((sql: string) => {
      let values: unknown[] = [];
      return createTestD1PreparedStatement({
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async all<T>() {
          if (sql.includes("JOIN tool_invocations ti")) {
            return createTestD1Result<T>({
              success: true,
              results: [{
                invocation_id: invocationId,
                message_id: invocationId,
                harness_run_id: PRIOR_RUN_ID,
                tool_call_id: call,
                tool_name: "workstream_read_resource",
                input_json: JSON.stringify({ resourceId: "00000000-0000-4000-8000-000000000046" }),
                output_ref: "results/private-note.json",
                output_summary: "Read private note",
                status: "completed",
                error_json: null,
                execution_plan_json: JSON.stringify({
                  canonicalToolName: "read_resource",
                  capability: "workstream.resources.read",
                }),
              }] as T[],
            });
          }
          expect(values).toBeDefined();
          return createTestD1Result<T>({ success: true, results: [] });
        },
        async run() {
          return createTestD1Result({ success: true, meta: { changes: 1 } });
        },
      });
    });
    const database = createTestD1Database({
      prepare,
      async batch(statements: D1PreparedStatement[]) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    });
    const env = createTestEnv({
      DB: database,
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ get }),
    });

    const projection = await __integrationTesting.projectModelProtocolTranscript(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      triggerMessageId: null,
      executionPrincipal: { type: "user", userId: USER_ID },
    }, [message(invocationId, 1, {
      author: "agent",
      messageType: "tool",
      structuredContent: { invocation: {} },
    })]);

    expect(projection.messages).toEqual([]);
    expect(projection.issues).toContainEqual({
      kind: "unauthorized_attachment_tool_omitted",
      healed: true,
    });
    expect(get).not.toHaveBeenCalled();
  });
  it("launches a selected expanded suggested-work brief as the executable user turn", async () => {
    const messageId = "00000000-0000-4000-8000-000000000030";
    const projection = await __integrationTesting.projectModelProtocolTranscript(
      projectionEnv([], {}),
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: messageId },
      // Stored as the selecting member's own turn. The label, not the author, is
      // what routes it here — an ordinary human turn would be replayed as plain
      // instruction, dropping the caveat around the evidence quoted inside it.
      [message(messageId, 1, {
        author: "human",
        textContent: "Trace the failed release, identify the owner, and prepare the fix.",
        structuredContent: {
          kind: "suggested_work_expansion",
          label: "Expanded by Avalon from suggested work",
        },
      })],
    );

    expect(projection.messages).toEqual([{
      role: "user",
      content: expect.stringContaining("USER-SELECTED AVALON SUGGESTED-WORK BRIEF"),
    }]);
    expect(projection.messages[0]?.content).toContain("untrusted evidence");
    expect(projection.messages[0]?.content).toContain("Trace the failed release");
  });

  it("projects an external Slack actor as an attributed user request", async () => {
    const projection = await __integrationTesting.projectModelProtocolTranscript(
      projectionEnv([], {}),
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: null },
      [message("00000000-0000-4000-8000-000000000029", 1, {
        author: "external",
        textContent: "Investigate the failed deployment",
      })],
    );

    expect(projection.messages).toEqual([expect.objectContaining({
      role: "user",
      content: expect.stringContaining("EXTERNALLY ATTRIBUTED SLACK WORKSPACE MEMBER REQUEST"),
    })]);
    expect(projection.messages[0]?.content).toContain("Display name: Taylor");
    expect(projection.messages[0]?.content).toContain("Provider member ID: U456");
    expect(projection.messages[0]?.content).toContain("Investigate the failed deployment");
  });

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
      { DB: createTestD1Database({ prepare }) },
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

  it("extends the window to an explicit fence while keeping the trigger's identity", async () => {
    // What a `retry` asks for: replay the failed run's trigger, but see the
    // messages that arrived after it — a correction that started no run of its
    // own is exactly the thing the old fence hid.
    const trigger = message("00000000-0000-4000-8000-000000000041", 1, {
      author: "human",
      textContent: "Reconcile the July invoices",
    });
    const correction = message("00000000-0000-4000-8000-000000000042", 2, {
      author: "human",
      textContent: "You used the wrong account",
    });
    const allMessages = [trigger, correction];
    const sequences: Record<string, number> = {
      [trigger.id]: trigger.sequenceNumber,
      [correction.id]: correction.sequenceNumber,
    };
    const bound: string[] = [];
    const prepare = vi.fn(() => ({
      bind: (messageId: string) => {
        bound.push(messageId);
        return { first: async () => ({ sequence_number: sequences[messageId] }) };
      },
    }));
    const listMessages = vi.fn(async (
      _workspaceId: string,
      _workstreamId: string,
      limit: number,
      beforeSequence?: number,
    ) => allMessages.filter((entry) => entry.sequenceNumber < (beforeSequence ?? Infinity)).slice(-limit));

    const stored = await __integrationTesting.loadTriggerFencedTranscriptMessages(
      { DB: createTestD1Database({ prepare }) },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        triggerMessageId: trigger.id,
        transcriptFenceMessageId: correction.id,
      },
      listMessages,
    );

    expect(bound).toEqual([trigger.id, correction.id]);
    expect(listMessages).toHaveBeenCalledWith(WORKSPACE_ID, WORKSTREAM_ID, 250, 3);
    expect(stored.map((entry) => entry.id)).toEqual([trigger.id, correction.id]);
  });

  it("never lets a fence pull the window in behind the trigger", async () => {
    // A fence below the trigger would drop the trigger itself, which the window
    // check then reports as a missing trigger — a confusing way to fail for
    // what is really a caller asking for something incoherent.
    const earlier = message("00000000-0000-4000-8000-000000000043", 1, {
      author: "human",
      textContent: "Earlier",
    });
    const trigger = message("00000000-0000-4000-8000-000000000044", 2, {
      author: "human",
      textContent: "The trigger",
    });
    const sequences: Record<string, number> = {
      [earlier.id]: earlier.sequenceNumber,
      [trigger.id]: trigger.sequenceNumber,
    };
    const prepare = vi.fn(() => ({
      bind: (messageId: string) => ({ first: async () => ({ sequence_number: sequences[messageId] }) }),
    }));
    const listMessages = vi.fn(async (
      _workspaceId: string,
      _workstreamId: string,
      limit: number,
      beforeSequence?: number,
    ) => [earlier, trigger].filter((entry) => entry.sequenceNumber < (beforeSequence ?? Infinity)).slice(-limit));

    const stored = await __integrationTesting.loadTriggerFencedTranscriptMessages(
      { DB: createTestD1Database({ prepare }) },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        triggerMessageId: trigger.id,
        transcriptFenceMessageId: earlier.id,
      },
      listMessages,
    );

    expect(stored.map((entry) => entry.id)).toEqual([earlier.id, trigger.id]);
  });

  it("fails closed when the immutable trigger message cannot be resolved", async () => {
    const first = vi.fn(async () => null);
    const bind = vi.fn(() => ({ first }));
    const listMessages = vi.fn(async () => [] as Message[]);

    await expect(__integrationTesting.loadTriggerFencedTranscriptMessages(
      { DB: createTestD1Database({ prepare: vi.fn(() => ({ bind })) }) },
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
      { DB: createTestD1Database({}) },
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: null },
      listMessages,
    );

    expect(stored).toHaveLength(300);
    expect(stored[0]?.sequenceNumber).toBe(1);
    expect(stored.at(-1)?.sequenceNumber).toBe(300);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("fails before provider projection when an uncompacted transcript exceeds the replay byte ceiling", async () => {
    const oversized = message("00000000-0000-4000-8000-000000000098", 1, {
      author: "human",
      textContent: "x".repeat(4 * 1_024 * 1_024 + 1),
    });

    await expect(__integrationTesting.loadTriggerFencedTranscriptMessages(
      { DB: createTestD1Database({}) },
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: null },
      async () => [oversized],
    )).rejects.toMatchObject({ code: "context_limit_exceeded" });
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
