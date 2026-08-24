import { asUserId, asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { runHarness } from "@avalon/agent-harness";
import type { Message } from "@avalon/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import type { MessageObjectPort } from "../src/durable-objects/workstream-message-protocol";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import type { DatabaseSync } from "node:sqlite";
import { seedWorkstreamObjectRoot, testSubstreamAgentsBinding, testWorkstreamObjectStore } from "./helpers/durable-authority";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const USER_ID = asUserId("00000000-0000-4000-8000-000000000003");
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

/**
 * Seed the fixtures as real receipts in a real object store.
 *
 * The projection used to read `messages JOIN tool_invocations` through a
 * compatibility view, so a mocked `prepare` could hand it rows. It now asks the
 * work-stream object for receipts by id — the join was `ti.id = m.id` on ids the
 * caller already held — so the fixtures have to become rows the object actually
 * holds. Statuses are written in the object's own vocabulary, which is the
 * substance of the change: `pending`/`started` were the view's spellings.
 */
function seedReceipts(objectStore: DatabaseSync, rows: ToolRow[]): void {
  seedWorkstreamObjectRoot(objectStore, {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
  });
  for (const runId of new Set(rows.map((row) => row.harness_run_id))) {
    objectStore.prepare(
      `INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
         model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
         active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
         tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
         created_at, updated_at, legacy_attempt_id)
       VALUES (?,'0','running','{}',0,0,'',0,0,1,0,0,0,0,0,0,0,0,0,0,1,1,'attempt-1')
       ON CONFLICT(run_id) DO NOTHING`,
    ).run(runId);
  }
  rows.forEach((row, position) => {
    objectStore.prepare(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name,
          mode, request_hash, authority_revision, status, tool_call_id, input_json,
          output_ref, output_summary, error_json, execution_plan_json)
       VALUES (?,?,0,?,?,?,?,'request-hash','runtime',?,?,?,?,?,?,?)`,
    ).run(
      row.invocation_id ?? row.message_id,
      row.harness_run_id,
      position,
      `runtime:${row.invocation_id ?? row.message_id}`,
      row.tool_name,
      "read",
      row.status === "pending" ? "admitted" : row.status === "started" ? "executing" : row.status,
      row.tool_call_id,
      row.input_json,
      row.output_ref,
      row.output_summary,
      row.error_json,
      row.execution_plan_json ?? null,
    );
  });
}

function projectionEnv(
  rows: ToolRow[],
  outputs: Record<string, unknown>,
  stalledReplayStage?: "get" | "body",
): Env {
  const objectStore = testWorkstreamObjectStore();
  seedReceipts(objectStore, rows);
  return createTestEnv({
    DB: createTestD1Database({
      prepare: () => createTestD1PreparedStatement({
        bind() { return this; },
        async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
        async run() { return createTestD1Result({ success: true }); },
      }),
    }),
    AVALON_REGION: "global",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
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

/**
 * The transcript port's one read this walk makes: a message's sequence number.
 *
 * A typed stub rather than a fake `prepare`/`bind`/`first` chain, because the
 * walk's contract with the object is an operation now rather than a statement.
 * What is under test here is the walk — which sequence it starts from, how far
 * back it pages, when it refuses — so the object behind it is stood in for; the
 * operation itself is proved against real SQLite in
 * `workstream-message-storage.test.ts`.
 */
function transcriptPort(
  sequences: Record<string, number | undefined>,
  asked: string[] = [],
): MessageObjectPort {
  return {
    message: async ({ messageId }: { messageId: string }) => {
      asked.push(messageId);
      const sequence = sequences[messageId];
      return sequence === undefined
        ? undefined
        : { sequence_number: sequence } as Awaited<ReturnType<MessageObjectPort["message"]>>;
    },
  } as MessageObjectPort;
}

describe("durable UI-to-model transcript projection", () => {
  it("reconstructs sanitized failed-tool recovery data after a resume", async () => {
    const invocationId = "00000000-0000-4000-8000-000000000050";
    const call = `${PRIOR_RUN_ID}:turn:1:tool:0`;
    const projection = await __integrationTesting.projectModelProtocolTranscript(
      projectionEnv([{
        message_id: invocationId,
        harness_run_id: PRIOR_RUN_ID,
        tool_call_id: call,
        tool_name: "memory_update",
        input_json: '{"memoryItemId":"00000000-0000-4000-8000-000000000051"}',
        output_ref: null,
        output_summary: null,
        status: "failed",
        error_json: JSON.stringify({
          code: "tool_failed",
          message: "The memory changed. Read it again by ID.",
          data: {
            code: "memory_revision_conflict",
            details: { reason: "Call memory_search with memoryItemId before retrying." },
          },
        }),
      }], {}),
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerMessageId: null },
      [
        message("00000000-0000-4000-8000-000000000052", 1, { author: "human", textContent: "Update it" }),
        message(invocationId, 2, { author: "agent", messageType: "tool", structuredContent: { invocation: {} } }),
        message("00000000-0000-4000-8000-000000000053", 3, { author: "agent", textContent: "I need to reread it." }),
      ],
    );

    expect(projection.messages.find((entry) => entry.role === "tool")).toEqual({
      role: "tool",
      tool_call_id: call,
      content: JSON.stringify({
        success: false,
        kind: "external",
        error: "The memory changed. Read it again by ID.",
        data: {
          code: "memory_revision_conflict",
          details: { reason: "Call memory_search with memoryItemId before retrying." },
        },
      }),
    });
  });

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
    // A completed attachment receipt the object really holds, with no recorded
    // dependency — which is what "cannot prove current visibility" is. The
    // dependency rows and the receipt now live in the same object, so this is
    // one store rather than a mocked query and a mocked default.
    const objectStore = testWorkstreamObjectStore();
    seedReceipts(objectStore, [{
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
    }]);
    const env = createTestEnv({
      DB: createTestD1Database({
        prepare: () => createTestD1PreparedStatement({
          bind() { return this; },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
          async run() { return createTestD1Result({ success: true, meta: { changes: 1 } }); },
        }),
        async batch(statements: D1PreparedStatement[]) {
          return Promise.all(statements.map((statement) => statement.run()));
        },
      }),
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ get }),
      AVALON_REGION: "global",
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
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
    const asked: string[] = [];
    const listMessages = vi.fn(async (
      _workspaceId: string,
      _workstreamId: string,
      limit: number,
      beforeSequence?: number,
    ) => allMessages.filter((entry) => entry.sequenceNumber < (beforeSequence ?? Infinity)).slice(-limit));

    const stored = await __integrationTesting.loadTriggerFencedTranscriptMessages(
      transcriptPort({ [trigger.id]: trigger.sequenceNumber }, asked),
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        triggerMessageId: trigger.id,
      },
      listMessages,
    );

    expect(asked).toEqual([trigger.id]);
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
    const listMessages = vi.fn(async (
      _workspaceId: string,
      _workstreamId: string,
      limit: number,
      beforeSequence?: number,
    ) => allMessages.filter((entry) => entry.sequenceNumber < (beforeSequence ?? Infinity)).slice(-limit));

    const stored = await __integrationTesting.loadTriggerFencedTranscriptMessages(
      transcriptPort(sequences, bound),
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
    const listMessages = vi.fn(async (
      _workspaceId: string,
      _workstreamId: string,
      limit: number,
      beforeSequence?: number,
    ) => [earlier, trigger].filter((entry) => entry.sequenceNumber < (beforeSequence ?? Infinity)).slice(-limit));

    const stored = await __integrationTesting.loadTriggerFencedTranscriptMessages(
      transcriptPort(sequences),
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
    const listMessages = vi.fn(async () => [] as Message[]);

    await expect(__integrationTesting.loadTriggerFencedTranscriptMessages(
      transcriptPort({}),
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
      transcriptPort({}),
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
      transcriptPort({}),
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
