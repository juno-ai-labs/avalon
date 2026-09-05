import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  SubstreamAddressSchema,
  SubstreamInitialContextSchema,
} from "@rally/contracts/substream-creation";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_788_000_000_000;
const source = SubstreamAddressSchema.parse({
  workspaceId: "00000000-0000-7000-8000-000000000001",
  workstreamId: "00000000-0000-7000-8000-000000000002",
  substreamId: "0",
});
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(): {
  transcript: WorkstreamTranscriptStorage;
  database: DatabaseSync;
  storage: DurableObjectStorage;
} {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    getCurrentBookmark: async () => "bookmark",
    setAlarm: async () => undefined,
    transactionSync: <T,>(body: () => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    sql,
  });
  applyWorkstreamObjectSchema(storage, "test", 1);
  sql.exec(`INSERT INTO workstream (
    id, workstream_key, parent_workspace_key, region, authority_mode, authority_generation,
    title, description, scope, exact_state, state_reason_code, next_sequence_number,
    next_attention_ordinal, authority_epoch, scope_epoch, source_authorization_floor,
    listing_epoch, deletion_epoch, run_revision, created_at, last_people_activity_at,
    state_changed_at, updated_at
  ) VALUES (1, 'workstream', 'workspace', 'global', 'authoritative', 1, '', '',
    'workspace', 'running', 'test', 1, 1, 1, 0, 0, 1, 0, 1, ?, ?, ?, ?)`,
  NOW, NOW, NOW, NOW);
  sql.exec(
    `INSERT INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)`,
    NOW,
  );
  return { transcript: new WorkstreamTranscriptStorage(storage), database, storage };
}

async function seedText(
  transcript: WorkstreamTranscriptStorage,
  sequence: number,
  text: string,
  actor: "human" | "assistant" = "human",
): Promise<void> {
  await transcript.seedDevelopmentConversationTurn({
    turnId: `turn-${sequence}`,
    expectedTranscriptSequence: sequence,
    actor,
    authorUserId: actor === "human" ? "00000000-0000-7000-8000-000000000003" : null,
    authorSnapshot: actor === "human"
      ? { displayName: "Ada", avatarUrl: null }
      : null,
    clientMessageId: `client-${sequence}`,
    externalActorJson: null,
    messageType: "text",
    text,
    structuredContentJson: null,
    producedByRunId: null,
    createdAtUtc: new Date(NOW + sequence).toISOString(),
  });
}

async function seedTool(
  transcript: WorkstreamTranscriptStorage,
  sequence: number,
): Promise<void> {
  await transcript.seedDevelopmentConversationTurn({
    turnId: `turn-${sequence}`,
    expectedTranscriptSequence: sequence,
    actor: "assistant",
    authorUserId: null,
    authorSnapshot: null,
    clientMessageId: `client-${sequence}`,
    externalActorJson: null,
    messageType: "tool",
    text: "private tool protocol payload",
    structuredContentJson: JSON.stringify({
      invocation: { toolCallId: "call-1", toolName: "private-tool", status: "completed" },
    }),
    producedByRunId: null,
    createdAtUtc: new Date(NOW + sequence).toISOString(),
  });
}

describe("substream context storage", () => {
  it("freezes a completed prefix and replays it without rereading the moving transcript", async () => {
    const { transcript } = open();
    await seedText(transcript, 1, "first");
    await seedText(transcript, 2, "second", "assistant");

    const first = transcript.captureSubstreamContext({
      operationId: "capture-1",
      source,
      throughTurnId: "turn-2",
    });
    await seedText(transcript, 3, "later");

    expect(transcript.captureSubstreamContext({
      operationId: "capture-1",
      source,
      throughTurnId: "turn-2",
    })).toEqual(first);
    expect(first).toMatchObject({
      throughTurnId: "turn-2",
      throughSequence: 2,
      sourceRevision: 2,
      messages: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
    });
    expect(() => transcript.captureSubstreamContext({
      operationId: "capture-1",
      source,
      throughTurnId: "turn-1",
    })).toThrow("substream_capture_operation_conflict");
  });

  it("stops before an active turn and rejects that turn as an explicit cutoff", async () => {
    const { transcript, storage } = open();
    await seedText(transcript, 1, "complete");
    await seedText(transcript, 2, "still generating", "assistant");
    storage.sql.exec(
      `INSERT INTO transcript_activities
         (activity_id, parent_activity_id, scope, subject_id, lifecycle_state,
          label, revision, created_at, updated_at)
       VALUES ('active-2', NULL, 'assistant_turn', 'turn-2', 'active', 'Generating', 1, ?, ?)`,
      NOW,
      NOW,
    );
    storage.sql.exec(
      `UPDATE participant_transcript_turns SET activity_id = 'active-2' WHERE turn_id = 'turn-2'`,
    );

    expect(transcript.captureSubstreamContext({
      operationId: "capture-prefix",
      source,
      throughTurnId: null,
    })).toMatchObject({
      throughTurnId: "turn-1",
      throughSequence: 1,
      sourceRevision: 2,
      messages: [{ turnId: "turn-1" }],
    });
    expect(() => transcript.captureSubstreamContext({
      operationId: "capture-active-cutoff",
      source,
      throughTurnId: "turn-2",
    })).toThrow("substream_source_turn_not_completed");
  });

  it("exports participant text but never tool protocol or reasoning blocks", async () => {
    const { transcript, storage } = open();
    await seedText(transcript, 1, "answer", "assistant");
    storage.sql.exec(
      `INSERT INTO participant_transcript_blocks
         (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
       SELECT turn_id, 'turn-1:thinking', 1, 'thinking', root_fact_id, 1, ?
         FROM participant_transcript_turns WHERE turn_id = 'turn-1'`,
      NOW,
    );
    await seedTool(transcript, 2);
    await seedText(transcript, 3, "after tool");

    const capture = transcript.captureSubstreamContext({
      operationId: "capture-safe-only",
      source,
      throughTurnId: "turn-3",
    });

    expect(capture.messages.map((message) => message.turnId)).toEqual(["turn-1", "turn-3"]);
    expect(capture.messages.flatMap((message) => message.blocks)).toEqual([
      { text: "answer", mentions: [], attachments: [] },
      { text: "after tool", mentions: [], attachments: [] },
    ]);
    expect(JSON.stringify(capture)).not.toContain("private tool protocol payload");
  });

  it("installs an immutable idle seed without creating transcript input", () => {
    const { transcript, storage } = open();
    const context = SubstreamInitialContextSchema.parse({
      source,
      throughTurnId: "turn-2",
      policyRevision: "policy-1",
      contentHash: "a".repeat(64),
      parts: [{ kind: "summary", text: "Frozen summary", requestedModel: "google/gemini-2.5-flash-lite", resolvedModel: "google/gemini-2.5-flash-lite", inputTokens: 10, outputTokens: 4 }],
    });

    transcript.installInitialContext({ operationId: "install-1", context });
    transcript.installInitialContext({ operationId: "install-1", context });
    const reloaded = new WorkstreamTranscriptStorage(storage);

    expect(reloaded.initialContext()).toEqual(context);
    expect(transcript.transcriptThrough()).toBe(0);
    expect(transcript.pendingTranscriptInputs()).toEqual([]);
    expect(storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
    ).one().count).toBe(0);
    expect(() => reloaded.installInitialContext({
      operationId: "install-2",
      context,
    })).toThrow("substream_initial_context_conflict");
    expect(() => reloaded.installInitialContext({
      operationId: "install-1",
      context: { ...context, contentHash: "b".repeat(64) },
    })).toThrow("substream_initial_context_conflict");
  });

  it("refuses to install a seed after live transcript state exists", async () => {
    const { transcript } = open();
    await seedText(transcript, 1, "already live");
    const context = SubstreamInitialContextSchema.parse({
      source,
      throughTurnId: null,
      policyRevision: "policy-1",
      contentHash: "c".repeat(64),
      parts: [],
    });

    expect(() => transcript.installInitialContext({ operationId: "late", context }))
      .toThrow("substream_context_target_not_empty");
    expect(transcript.initialContext()).toBeNull();
  });
});
