import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { BindLoopTransition } from "@rally/agent-harness";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_787_000_000_000;
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(options: { getCurrentBookmark?: () => Promise<string> } = {}): {
  transcript: WorkstreamTranscriptStorage;
  sql: SqlStorage;
  database: DatabaseSync;
} {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    getCurrentBookmark: options.getCurrentBookmark ?? (async () => "bookmark-before-backfill"),
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
  applyWorkstreamObjectSchema(binding, "test", 1);
  return { transcript: new WorkstreamTranscriptStorage(binding), sql, database };
}

const systemProjection = {
  revision: 1,
  rendererVersion: "workstream-system-v1",
  inputHash: "input-1",
  message: { role: "system", content: "System" },
};

function initialize(): BindLoopTransition {
  return {
    kind: "state_initialized",
    loopId: "run-1",
    generation: 1,
    stateRevision: 1,
    systemProjection,
    nonSystemMessages: [{ role: "user", content: "Question" }],
    nonSystemMessageOrigins: [{
      originKind: "derived",
      sourceKind: "participant_turn",
      sourceId: "message-1",
      sourceRevision: 1,
    }],
  };
}

function assistant(revision: number, turn: number, content: string, toolCount = 0): BindLoopTransition {
  return {
    kind: "assistant_accepted",
    loopId: "run-1",
    generation: 1,
    stateRevision: revision,
    turnId: `run-1:turn:${turn}`,
    modelTurnIndex: turn,
    message: {
      role: "assistant",
      content,
      ...(toolCount > 0 ? {
        tool_calls: Array.from({ length: toolCount }, (_, index) => ({
          id: `provider-${turn}-${index}`,
          type: "function",
          function: { name: `tool-${index}`, arguments: "{}" },
        })),
      } : {}),
    },
  };
}

describe("canonical ordered work-stream transcript", () => {
  it("records and reconciles an empty legacy source without inventing history", async () => {
    const { transcript, sql } = open();
    const first = await transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000000",
      cutoverVersion: 27,
    });
    expect(first).toMatchObject({
      applied: true,
      verified: true,
      sourcePartCount: 0,
      sourceCheckpointCount: 0,
      participantTurnCount: 0,
      checkpointProjectionCount: 0,
    });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM bind_loop_heads`).one().count).toBe(0);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM legacy_transcript_backfills`).one().count).toBe(1);
  });

  it("refuses to renumber a participant transcript while a run can still write", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO runs
      (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
       next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
       idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
       input_tokens, output_tokens, cost_micros, output_bytes, created_at, updated_at)
      VALUES ('active-run', '0', 'running', '{}', 0, 0, '', 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`);

    await expect(transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000006",
      cutoverVersion: 27,
    })).rejects.toThrow("legacy_transcript_backfill_not_quiescent");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM legacy_transcript_backfills`).one().count).toBe(0);
  });

  it("backfills after a needs-input run has yielded execution", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO runs
      (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
       next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
       idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
       input_tokens, output_tokens, cost_micros, output_bytes, terminalized_at,
       created_at, updated_at)
      VALUES ('yielded-run', '0', 'needs_input', '{}', 0, 0, '', 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`);

    await expect(transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-00000000000a",
      cutoverVersion: 27,
    })).resolves.toMatchObject({ applied: true, verified: true });
  });

  it("refuses to backfill a mutable pending legacy tool card", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO parts
      (id, substream_id, sequence_number, role, kind, author_type, content,
       client_message_id, effect_intent_id, tool_name, tool_mode, tool_status,
       visibility, pinned, message_type, structured_content_json, created_at, updated_at)
      VALUES ('pending-tool', '0', 1, 'assistant', 'tool_call', 'agent', '',
              'tool:pending-tool', 'pending-tool', 'search', 'read', 'pending',
              'people', 0, 'tool', '{"invocation":{"status":"pending"}}', 0, 0)`);
    sql.exec(`INSERT INTO runs
      (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
       next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
       idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
       input_tokens, output_tokens, cost_micros, output_bytes, terminalized_at,
       created_at, updated_at)
      VALUES ('settling-run', '0', 'completed', '{}', 0, 0, '', 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0)`);
    sql.exec(`INSERT INTO tool_effects
      (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
       tool_name, mode, request_hash, authority_revision, status, tool_call_id, input_json)
      VALUES ('pending-tool', 'settling-run', 0, 0, 'pending-tool', 'search',
              'read', 'request', 'authority', 'admitted', 'provider-call', '{}')`);

    await expect(transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-00000000000b",
      cutoverVersion: 27,
    })).rejects.toThrow("legacy_transcript_backfill_not_quiescent");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM legacy_transcript_backfills`).one().count).toBe(0);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one().count).toBe(0);
  });

  it("backfills an immutable orphaned pending legacy tool card", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO parts
      (id, substream_id, sequence_number, role, kind, author_type, content,
       client_message_id, effect_intent_id, tool_name, tool_mode, tool_status,
       visibility, pinned, message_type, structured_content_json, created_at, updated_at)
      VALUES ('orphaned-tool', '0', 1, 'assistant', 'tool_call', 'agent', '',
              'tool:orphaned-tool', 'orphaned-tool', 'search', 'read', 'pending',
              'people', 0, 'tool', '{"invocation":{"status":"pending"}}', 0, 0)`);

    await expect(transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-00000000000c",
      cutoverVersion: 27,
    })).resolves.toMatchObject({ applied: true, verified: true, participantTurnCount: 1 });
    expect(transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null, now: NOW })
      .ranges[0]!.turns[0]!.blocks[0]).toMatchObject({ type: "tool", status: "started" });
  });

  it("backfills legacy participant order before post-cutover turns and replays idempotently", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO parts
      (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
       author_user_id, content, client_message_id, visibility, pinned, message_type,
       created_at, updated_at)
      VALUES
      ('legacy-human', '0', 4, 1, 'user', 'text', 'member', 'user-1', 'First',
       'legacy-human-client', 'both', 0, 'text', 0, 0),
      ('legacy-agent', '0', 9, 2, 'assistant', 'text', 'agent', NULL, 'Second',
       'legacy-agent-client', 'both', 0, 'text', 0, 0)`);
    await transcript.appendParticipantMessage({
      turnId: "post-cutover",
      actor: "human",
      authorUserId: "user-2",
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: 3,
    });

    const first = await transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000001",
      cutoverVersion: 27,
    });
    expect(first).toMatchObject({
      applied: true,
      verified: true,
      preBackfillBookmark: "bookmark-before-backfill",
      sourcePartCount: 2,
      participantTurnCount: 2,
      bindHistoryStatus: "not_reconstructable_from_legacy_aggregate_rows",
    });
    expect(transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null, now: NOW })
      .ranges[0]!.turns.map((turn) => [turn.transcriptSequence, turn.turnId])).toEqual([
      [1, "legacy-human"],
      [2, "legacy-agent"],
      [3, "post-cutover"],
    ]);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM bind_loop_heads`).one().count).toBe(0);

    const replay = await transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000002",
      cutoverVersion: 27,
    });
    expect(replay).toMatchObject({ applied: false, verified: true, operatorRunId:
      "00000000-0000-7000-8000-000000000001" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one().count).toBe(3);
  });

  it("hydrates an exact legacy tool card through its canonical source reference", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO parts
      (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
       content, client_message_id, effect_intent_id, tool_name, tool_mode, tool_status,
       visibility, pinned, message_type, structured_content_json, created_at, updated_at)
      VALUES ('legacy-tool', '0', 1, NULL, 'assistant', 'tool_call', 'agent', '',
       'tool:legacy-tool', 'legacy-tool', 'search', 'read', 'completed', 'people', 0,
       'tool', ?, 0, 1)`, JSON.stringify({ invocation: {
        id: "legacy-tool",
        toolCallId: "provider-call",
        toolName: "search",
        plugin: { pluginId: "plugin_search" },
        status: "completed",
        inputSummary: "query",
        outputSummary: "result",
        error: null,
      } }));

    await transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000003",
      cutoverVersion: 27,
    });
    expect(transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null, now: NOW })
      .ranges[0]!.turns[0]!.blocks[0]).toMatchObject({
      type: "tool",
      toolCallId: "legacy:legacy-tool",
      pluginId: "plugin_search",
      toolName: "search",
      status: "completed",
      participantSafeInput: "query",
      participantSafeResult: "result",
    });
    expect(sql.exec<{ payload_json: string } & Record<string, SqlStorageValue>>(
      `SELECT payload.payload_json FROM transcript_payloads payload
       JOIN transcript_facts fact ON fact.payload_id = payload.payload_id
       WHERE fact.fact_id = 'legacy-tool:legacy-tool'`,
    ).one().payload_json).not.toContain("result");
  });

  it("references exact legacy compaction messages without fabricating a Bind state", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO runs
      (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
       next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
       idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
       input_tokens, output_tokens, cost_micros, output_bytes, created_at, updated_at)
      VALUES ('legacy-run', '0', 'completed', '{}', 0, 0, '', 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`);
    const messages = [{ role: "user", content: "exact checkpoint" }];
    sql.exec(`INSERT INTO compaction_checkpoints
      (projection_key, execution_principal_key, resource_visibility_fingerprint,
       checkpoint_template_version, run_id, compacted_through_sequence,
       messages_json, summary, model, context_tokens_before_compaction,
       context_window_tokens, input_tokens, output_tokens, cost_micros,
       created_at, updated_at)
      VALUES ('projection', 'workspace:one', 'inventory:0', 1, 'legacy-run', 7,
              ?, 'summary', 'model', 100, 1000, 10, 2, 30, 0, 0)`, JSON.stringify(messages));

    const outcome = await transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000005",
      cutoverVersion: 27,
    });
    expect(outcome).toMatchObject({ sourceCheckpointCount: 1, checkpointProjectionCount: 1 });
    const checkpoint = transcript.compactionCheckpoint({ executionPrincipalKey: "workspace:one" });
    expect(JSON.parse(checkpoint!.messages_json)).toEqual(messages);
    expect(checkpoint!.summary).toBe("summary");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM bind_loop_heads`).one().count).toBe(0);
    expect(sql.exec<{ payload_json: string } & Record<string, SqlStorageValue>>(
      `SELECT payload.payload_json FROM transcript_payloads payload
       JOIN transcript_facts fact ON fact.payload_id = payload.payload_id
       WHERE fact.fact_kind = 'legacy_compaction_checkpoint_reference'`,
    ).one().payload_json).not.toContain("exact checkpoint");
  });

  it("aborts atomically if the legacy source moves while its hashes are prepared", async () => {
    let releaseBookmark!: () => void;
    const bookmark = new Promise<string>((resolve) => { releaseBookmark = () => resolve("bookmark"); });
    const { transcript, sql } = open({ getCurrentBookmark: () => bookmark });
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO parts
      (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
       author_user_id, content, client_message_id, visibility, pinned, message_type,
       created_at, updated_at)
      VALUES ('legacy', '0', 1, 1, 'user', 'text', 'member', 'user-1', 'Before',
       'legacy-client', 'both', 0, 'text', 0, 0)`);
    const pending = transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000004",
      cutoverVersion: 27,
    });
    await Promise.resolve();
    sql.exec(`UPDATE parts SET content = 'After', updated_at = 1 WHERE id = 'legacy'`);
    releaseBookmark();
    await expect(pending).rejects.toThrow("legacy_transcript_source_moved");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one().count).toBe(0);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM legacy_transcript_backfills`).one().count).toBe(0);
  });

  it("rejects a partial legacy participant projection instead of mixing states", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO parts
      (id, substream_id, sequence_number, role, kind, author_type, author_user_id,
       content, client_message_id, visibility, pinned, message_type, created_at, updated_at)
      VALUES ('partial', '0', 1, 'user', 'text', 'member', 'user-1', 'Legacy',
              'partial-client', 'both', 0, 'text', 0, 0)`);
    await transcript.appendParticipantMessage({
      turnId: "partial",
      actor: "human",
      authorUserId: "user-1",
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: null,
    });

    await expect(transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000007",
      cutoverVersion: 27,
    })).rejects.toThrow("legacy_transcript_partial_participant_projection");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM legacy_transcript_backfills`).one().count).toBe(0);
  });

  it("fails replay reconciliation if a referenced legacy owner changes", async () => {
    const { transcript, sql } = open();
    sql.exec(`INSERT INTO substreams
      (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
      VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 0)`);
    sql.exec(`INSERT INTO parts
      (id, substream_id, sequence_number, role, kind, author_type, author_user_id,
       content, client_message_id, visibility, pinned, message_type, created_at, updated_at)
      VALUES ('immutable-owner', '0', 1, 'user', 'text', 'member', 'user-1', 'Before',
              'immutable-owner-client', 'both', 0, 'text', 0, 0)`);
    await transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000008",
      cutoverVersion: 27,
    });
    sql.exec(`UPDATE parts SET content = 'After', updated_at = 1 WHERE id = 'immutable-owner'`);

    await expect(transcript.backfillLegacyTranscript({
      operatorRunId: "00000000-0000-7000-8000-000000000009",
      cutoverVersion: 27,
    })).rejects.toThrow("legacy_transcript_backfill_reconciliation_failed");
  });

  it("stores assistant text and tool plans once while both projections reference canonical facts", async () => {
    const { transcript, sql } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    await transcript.commitBindTransition(assistant(2, 1, "Before tools", 2), NOW + 1);

    const snapshot = transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null, now: NOW + 2 });
    const turn = snapshot.ranges[0]!.turns[0]!;
    expect(turn.blocks.map((block) => block.type)).toEqual(["text", "tool", "tool"]);
    expect(turn.blocks.filter((block) => block.type === "tool").map((block) => block.callIndex))
      .toEqual([0, 1]);

    const assistantFactId = String(sql.exec<{ fact_id: string } & Record<string, SqlStorageValue>>(
      `SELECT fact_id FROM bind_loop_state_messages
        WHERE loop_id = 'run-1' AND state_revision = 2 AND message_position = 2`,
    ).one().fact_id);
    expect(sql.exec<{ root_fact_id: string } & Record<string, SqlStorageValue>>(
      `SELECT root_fact_id FROM participant_transcript_turns WHERE turn_id = 'run-1:turn:1'`,
    ).one().root_fact_id).toBe(assistantFactId);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM transcript_payloads
      WHERE payload_json LIKE '%Before tools%'`).one().count).toBe(1);
  });

  it("stores typed provenance for exact model-facing derivatives without copying participant ownership", async () => {
    const { transcript, sql } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    await transcript.commitBindTransition(assistant(2, 1, "Answer"), NOW + 1);
    await transcript.commitBindTransition({
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      toolCallId: "run-1:turn:1:tool:0",
      callIndex: 0,
      message: { role: "tool", tool_call_id: "provider-1-0", content: "{\"ok\":true}" },
    }, NOW + 2);

    const rows = sql.exec<{
      fact_kind: string;
      origin_kind: string;
      source_kind: string | null;
      source_id: string | null;
      source_revision: number | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT fact.fact_kind, fact.origin_kind, fact.source_kind, fact.source_id,
              fact.source_revision
         FROM bind_loop_state_messages projected
         JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
        WHERE projected.loop_id = 'run-1' AND projected.state_revision = 3
        ORDER BY projected.message_position`,
    ).toArray();

    expect(rows).toEqual([
      expect.objectContaining({
        fact_kind: "system_projection",
        origin_kind: "system_projection",
        source_kind: "system_prompt_inputs",
        source_id: "input-1",
        source_revision: 1,
      }),
      expect.objectContaining({
        fact_kind: "model_message",
        origin_kind: "derived",
        source_kind: "participant_turn",
        source_id: "message-1",
        source_revision: 1,
      }),
      expect.objectContaining({
        fact_kind: "model_message",
        origin_kind: "canonical",
        source_kind: null,
        source_id: null,
        source_revision: null,
      }),
      expect.objectContaining({
        fact_kind: "model_message",
        origin_kind: "derived",
        source_kind: "tool_receipt",
        source_id: "run-1:turn:1:tool:0",
        source_revision: 0,
      }),
    ]);
  });

  it("rejects derivative facts without a durable source identity", () => {
    const { database } = open();
    database.prepare(
      `INSERT INTO transcript_payloads
         (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
       VALUES ('payload-test', 'model', 'application/json', '{}', 'hash', 2, ?)`,
    ).run(NOW);
    expect(() => database.prepare(
      `INSERT INTO transcript_facts
         (fact_id, fact_kind, payload_id, origin_kind, source_kind, source_id,
          source_revision, run_id, turn_id, tool_call_id, created_at)
       VALUES ('fact-test', 'model_message', 'payload-test', 'derived', NULL, NULL,
               NULL, 'run-1', NULL, NULL, ?)`,
    ).run(NOW)).toThrow(/CHECK constraint failed/u);
  });

  it("keeps parallel tool lifecycle updates in declared call order regardless of settle order", async () => {
    const { transcript } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    await transcript.commitBindTransition(assistant(2, 1, "Checking", 2), NOW + 1);
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:1",
      pluginId: "github",
      toolName: "tool-1",
      status: "completed",
      participantSafeResult: { value: "second settled first" },
      error: null,
      occurredAtUtc: new Date(NOW + 4).toISOString(),
    });
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "failed",
      error: "first settled second",
      occurredAtUtc: new Date(NOW + 5).toISOString(),
    });

    const turn = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 6,
    }).ranges[0]!.turns[0]!;
    const tools = turn.blocks.filter((block) => block.type === "tool");
    expect(tools.map((block) => [block.callIndex, block.status])).toEqual([
      [0, "failed"],
      [1, "completed"],
    ]);
  });

  it("retains participant-safe tool input when a terminal lifecycle fact replaces started", async () => {
    const { transcript } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    await transcript.commitBindTransition(assistant(2, 1, "Checking", 1), NOW + 1);
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "started",
      participantSafeInput: { query: "open pull requests" },
      occurredAtUtc: new Date(NOW + 2).toISOString(),
    });
    await transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "completed",
      participantSafeResult: "Found two",
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });

    const tool = transcript.participantTurn("run-1:turn:1")?.blocks
      .find((block) => block.type === "tool");
    expect(tool).toMatchObject({
      status: "completed",
      participantSafeInput: { query: "open pull requests" },
      participantSafeResult: "Found two",
    });
  });

  it("rejects an invalid tool lifecycle timestamp before writing a fact", async () => {
    const { transcript, sql } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    await transcript.commitBindTransition(assistant(2, 1, "Checking", 1), NOW + 1);

    await expect(transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "started",
      occurredAtUtc: "not-a-timestamp",
    })).rejects.toThrow("invalid_tool_lifecycle_timestamp");
    expect(sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM transcript_facts
        WHERE fact_id = 'run-1:turn:1:tool:0:participant:started'`,
    ).one().count).toBe(0);
  });

  it("rejects non-JSON array values instead of hashing them as null", async () => {
    const { transcript } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    await transcript.commitBindTransition(assistant(2, 1, "Checking", 1), NOW + 1);

    await expect(transcript.upsertToolLifecycle({
      toolCallId: "run-1:turn:1:tool:0",
      pluginId: "github",
      toolName: "tool-0",
      status: "started",
      participantSafeInput: [undefined],
      occurredAtUtc: new Date(NOW + 2).toISOString(),
    })).rejects.toThrow("transcript_non_json_value");
  });

  it("never exposes provider reasoning content in a participant thinking block", async () => {
    const { transcript } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    transcript.upsertActivity({
      activityId: "run-1:turn:1:activity",
      parentActivityId: null,
      scope: "assistant_turn",
      subjectId: "run-1:turn:1",
      callIndex: 0,
      label: "Working",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "run-1:turn:1:thinking",
      parentActivityId: "run-1:turn:1:activity",
      scope: "thinking",
      subjectId: "run-1:turn:1",
      callIndex: null,
      label: "Thinking",
      action: "complete",
      revision: 1,
      occurredAtUtc: new Date(NOW + 1).toISOString(),
    });
    const transition = assistant(2, 1, "Answer") as Extract<BindLoopTransition, { kind: "assistant_accepted" }>;
    transition.message = {
      ...transition.message,
      summary: "private provider reasoning",
    } as typeof transition.message;
    await transcript.commitBindTransition(transition, NOW + 2);

    const thinking = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 3,
    }).ranges[0]!.turns[0]!.blocks.find((block) => block.type === "thinking");
    expect(thinking).toMatchObject({ type: "thinking", summary: null });
    expect(JSON.stringify(thinking)).not.toContain("private provider reasoning");
  });

  it("hydrates only range-owned activities and active ancestry in one bounded snapshot", async () => {
    const { transcript } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    const rootId = "run-1:activity";
    const turnId = "run-1:turn:1";
    const assistantId = `${turnId}:activity`;
    const pluginId = `${turnId}:plugin:github`;
    const toolId = `${turnId}:tool:0:activity`;
    transcript.upsertActivity({
      activityId: rootId, parentActivityId: null, scope: "response", subjectId: "run-1",
      callIndex: null, label: "Working", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: assistantId, parentActivityId: rootId, scope: "assistant_turn", subjectId: turnId,
      callIndex: 1, label: "Assistant turn", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW + 1).toISOString(),
    });
    await transcript.commitBindTransition(assistant(2, 1, "Checking", 1), NOW + 2);
    transcript.upsertActivity({
      activityId: pluginId, parentActivityId: assistantId, scope: "plugin", subjectId: "github",
      callIndex: 0, label: "GitHub", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });
    await transcript.upsertToolLifecycle({
      toolCallId: `${turnId}:tool:0`, pluginId: "github", toolName: "tool-0", status: "started",
      participantSafeInput: { query: "one" }, occurredAtUtc: new Date(NOW + 3).toISOString(),
    });
    transcript.upsertActivity({
      activityId: toolId, parentActivityId: pluginId, scope: "tool_call", subjectId: `${turnId}:tool:0`,
      callIndex: 0, label: "Search", action: "start", revision: 1,
      occurredAtUtc: new Date(NOW + 3).toISOString(),
    });
    transcript.upsertActivity({
      activityId: toolId, parentActivityId: pluginId, scope: "tool_call", subjectId: `${turnId}:tool:0`,
      callIndex: 0, label: "Search", action: "complete", revision: 2,
      occurredAtUtc: new Date(NOW + 4).toISOString(),
    });
    for (const [activityId, parentActivityId, scope, subjectId] of [
      [pluginId, assistantId, "plugin", "github"],
      [assistantId, rootId, "assistant_turn", turnId],
      [rootId, null, "response", "run-1"],
    ] as const) {
      transcript.upsertActivity({
        activityId, parentActivityId, scope, subjectId, callIndex: null,
        label: subjectId, action: "complete", revision: 2,
        occurredAtUtc: new Date(NOW + 5).toISOString(),
      });
    }
    for (let index = 0; index < 25; index += 1) {
      transcript.upsertActivity({
        activityId: `historical:${index}`, parentActivityId: null, scope: "response",
        subjectId: `historical:${index}`, callIndex: null, label: "Historical",
        action: "complete", revision: 1, occurredAtUtc: new Date(NOW - index - 1).toISOString(),
      });
    }

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 6,
    });
    expect(snapshot.activities.map((activity) => activity.activityId)).toEqual([
      rootId,
      assistantId,
      pluginId,
      toolId,
    ]);
    const loaded = transcript.range(snapshot, { startInclusive: 1, endExclusive: 2 });
    expect(loaded.activities.map((activity) => activity.activityId)).toEqual([
      rootId,
      assistantId,
      pluginId,
      toolId,
    ]);
  });

  it("returns unread-centered and latest ranges from one immutable snapshot fence and exposes gaps", async () => {
    const { transcript } = open();
    for (let index = 1; index <= 30; index += 1) {
      await transcript.appendParticipantMessage({
        turnId: `message-${index}`,
        actor: "human",
        authorUserId: "user-1",
        createdAtUtc: new Date(NOW + index).toISOString(),
        attentionOrdinal: index,
      });
    }

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: 10,
      now: NOW + 100,
    });
    expect(snapshot.snapshotThrough).toBe(30);
    expect(snapshot.unreadAnchorSequence).toBe(10);
    expect(snapshot.unreadReason).toBeNull();
    expect(snapshot.ranges.map((range) => range.purpose)).toEqual(["unread", "latest"]);
    expect(snapshot.ranges).toHaveLength(2);
    expect(snapshot.ranges.map((range) => range.turns.map((turn) => turn.transcriptSequence)))
      .toEqual([
        [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [26, 27, 28, 29, 30],
      ]);

    const gap = transcript.range(snapshot, { startInclusive: 17, endExclusive: 26 });
    expect(gap.covered).toEqual({ startInclusive: 17, endExclusive: 26 });
    expect(gap.turns).toHaveLength(9);
    await transcript.appendParticipantMessage({
      turnId: "message-after-fence",
      actor: "human",
      authorUserId: "user-1",
      createdAtUtc: new Date(NOW + 101).toISOString(),
      attentionOrdinal: 31,
    });
    expect(transcript.range(snapshot, { startInclusive: 30, endExclusive: 40 }).covered)
      .toEqual({ startInclusive: 30, endExclusive: 31 });
  });

  it("hydrates reconnect-safe nested activity intervals from server UTC and snapshot baselines", () => {
    const { transcript } = open();
    transcript.upsertActivity({
      activityId: "run-1:activity",
      parentActivityId: null,
      scope: "response",
      subjectId: "run-1",
      callIndex: null,
      label: "Working",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "plugin:github",
      parentActivityId: "run-1:activity",
      scope: "plugin",
      subjectId: "github",
      callIndex: 0,
      label: "GitHub working",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW + 1_000).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "tool:1",
      parentActivityId: "plugin:github",
      scope: "tool_call",
      subjectId: "tool:1",
      callIndex: 0,
      label: "Search",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW + 2_000).toISOString(),
    });

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 7_000,
    });
    expect(snapshot.activeActivities.map((activity) => activity.activityId))
      .toEqual(["run-1:activity", "plugin:github", "tool:1"]);
    expect(snapshot.activeActivities.map((activity) => activity.intervals[0]!.elapsedMsAtSnapshot))
      .toEqual([7_000, 6_000, 5_000]);

    const completed = transcript.upsertActivity({
      activityId: "tool:1",
      parentActivityId: "plugin:github",
      scope: "tool_call",
      subjectId: "tool:1",
      callIndex: 0,
      label: "Search",
      action: "complete",
      revision: 2,
      occurredAtUtc: new Date(NOW + 8_000).toISOString(),
    });
    expect(completed.state).toBe("completed");
    expect(completed.intervals[0]).toMatchObject({ durationMs: 6_000, elapsedMsAtSnapshot: null });
  });

  it("pauses and resumes one response as separate intervals without counting the gap", () => {
    const { transcript } = open();
    const edge = {
      activityId: "run-paused",
      parentActivityId: null,
      scope: "response" as const,
      subjectId: "run-paused",
      callIndex: null,
      label: "Working",
    };
    transcript.upsertActivity({
      ...edge, action: "start", revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      ...edge, action: "complete", revision: 2,
      occurredAtUtc: new Date(NOW + 2_000).toISOString(),
    });
    transcript.upsertActivity({
      ...edge, action: "start", revision: 3,
      occurredAtUtc: new Date(NOW + 10_000).toISOString(),
    });
    const activity = transcript.upsertActivity({
      ...edge, action: "complete", revision: 4,
      occurredAtUtc: new Date(NOW + 13_000).toISOString(),
    });
    expect(activity.state).toBe("completed");
    expect(activity.intervals.map((interval) => interval.durationMs)).toEqual([2_000, 3_000]);
  });

  it("atomically records two compaction replacements and reconstructs only the latest Bind generation", async () => {
    const { transcript, sql } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    for (let index = 1; index <= 2; index += 1) {
      const current = transcript.readBindProjection("run-1")!;
      const compactionEventId = `run-1:compaction:${index}`;
      await transcript.reserveCompactionStatus({
        compactionEventId,
        runId: "run-1",
        trigger: "auto",
        occurredAtUtc: new Date(NOW + index * 10).toISOString(),
      });
      transcript.upsertActivity({
        activityId: compactionEventId,
        parentActivityId: null,
        scope: "compaction",
        subjectId: String(index),
        callIndex: index - 1,
        label: "Context automatically compacting",
        action: "start",
        revision: 1,
        occurredAtUtc: new Date(NOW + index * 10).toISOString(),
      });
      await transcript.commitBindCompaction({
        commit: {
          checkpoint: {
            trigger: "auto",
            summary: `Summary ${index}`,
            messages: [{ role: "user", content: `Summary ${index}` }],
            model: "openai/test",
            contextTokensBeforeCompaction: 90,
            contextWindowTokens: 100,
            inputTokens: 10,
            outputTokens: 2,
            costCents: 0.01,
          },
          transition: {
            kind: "state_replaced",
            loopId: "run-1",
            generation: current.generation,
            nextGeneration: current.generation + 1,
            stateRevision: current.stateRevision + 1,
            systemProjection,
            nonSystemMessages: [{ role: "user", content: `Summary ${index}` }],
            compactionEventId,
          },
        },
        continuation: {
          executionPrincipalKey: "user:user-1",
          resourceVisibilityFingerprint: "inventory:0",
          checkpointTemplateVersion: 1,
          compactedThroughSequence: index,
          expectedInventoryRevision: 0,
        },
        now: NOW + index * 10 + 5,
      });
    }

    expect(transcript.readBindProjection("run-1")).toMatchObject({
      generation: 3,
      stateRevision: 3,
      nonSystemMessages: [{ role: "user", content: "Summary 2" }],
    });
    expect(transcript.compactionCheckpoint({ executionPrincipalKey: "user:user-1" }))
      .toMatchObject({ run_id: "run-1", compacted_through_sequence: 2, summary: "Summary 2" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns
      WHERE entry_kind = 'status'`).one().count).toBe(2);
    expect(transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 100,
    }).activities.filter((activity) => activity.scope === "compaction")).toEqual([
      expect.objectContaining({ activityId: "run-1:compaction:1", state: "completed" }),
      expect.objectContaining({ activityId: "run-1:compaction:2", state: "completed" }),
    ]);
    await transcript.commitBindCompaction({
      commit: {
        checkpoint: {
          trigger: "auto",
          summary: "Summary 1",
          messages: [{ role: "user", content: "Summary 1" }],
          model: "openai/test",
          contextTokensBeforeCompaction: 90,
          contextWindowTokens: 100,
          inputTokens: 10,
          outputTokens: 2,
          costCents: 0.01,
        },
        transition: {
          kind: "state_replaced",
          loopId: "run-1",
          generation: 1,
          nextGeneration: 2,
          stateRevision: 2,
          systemProjection,
          nonSystemMessages: [{ role: "user", content: "Summary 1" }],
          compactionEventId: "run-1:compaction:1",
        },
      },
      continuation: {
        executionPrincipalKey: "user:user-1",
        resourceVisibilityFingerprint: "inventory:0",
        checkpointTemplateVersion: 1,
        compactedThroughSequence: 1,
        expectedInventoryRevision: 0,
      },
    });
    expect(transcript.readBindProjection("run-1")?.generation).toBe(3);
  });

  it("retains an in-progress compaction status entry with reconnect timing before replacement", async () => {
    const { transcript } = open();
    await transcript.reserveCompactionStatus({
      compactionEventId: "run-1:compaction:1",
      runId: "run-1",
      trigger: "auto",
      occurredAtUtc: new Date(NOW).toISOString(),
    });
    transcript.upsertActivity({
      activityId: "run-1:compaction:1",
      parentActivityId: null,
      scope: "compaction",
      subjectId: "1",
      callIndex: 0,
      label: "Context automatically compacting",
      action: "start",
      revision: 1,
      occurredAtUtc: new Date(NOW).toISOString(),
    });

    const snapshot = transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: null,
      now: NOW + 154_000,
    });
    expect(snapshot.ranges[0]!.turns[0]).toMatchObject({
      turnId: "run-1:compaction:1",
      entryKind: "status",
    });
    expect(snapshot.activeActivities[0]).toMatchObject({
      activityId: "run-1:compaction:1",
      state: "active",
      intervals: [{ elapsedMsAtSnapshot: 154_000 }],
    });
  });

  it("rolls back loop and participant projections together when an assistant projection fails", async () => {
    const { transcript, database, sql } = open();
    await transcript.commitBindTransition(initialize(), NOW);
    database.exec(`CREATE TRIGGER fail_assistant_projection BEFORE INSERT ON participant_transcript_turns
      WHEN NEW.actor = 'assistant' BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END`);

    await expect(transcript.commitBindTransition(assistant(2, 1, "Must roll back"), NOW + 1))
      .rejects.toThrow("forced projection failure");
    expect(transcript.readBindProjection("run-1")!.stateRevision).toBe(1);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM transcript_payloads
      WHERE payload_json LIKE '%Must roll back%'`).one().count).toBe(0);
  });

  it("uses the required indexes for unread, latest, and range queries", async () => {
    const { transcript, database } = open();
    await transcript.appendParticipantMessage({
      turnId: "message-1",
      actor: "human",
      authorUserId: "user-1",
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: 1,
    });
    const plans = [
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_latest_conversation_idx
        WHERE entry_kind = 'conversation'
        ORDER BY transcript_sequence DESC LIMIT 5`).all(),
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_status_idx
        WHERE entry_kind = 'status'
        ORDER BY transcript_sequence DESC LIMIT 5`).all(),
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_attention_idx
        WHERE entry_kind = 'conversation' AND attention_ordinal >= 1
        ORDER BY attention_ordinal, transcript_sequence LIMIT 1`).all(),
      database.prepare(`EXPLAIN QUERY PLAN SELECT transcript_sequence
        FROM participant_transcript_turns INDEXED BY participant_transcript_sequence_idx
        WHERE transcript_sequence >= 1 AND transcript_sequence < 10
        ORDER BY transcript_sequence`).all(),
    ].flat().map((row) => String((row as { detail: string }).detail));
    expect(plans.some((detail) => detail.includes("participant_transcript_latest_conversation_idx"))).toBe(true);
    expect(plans.some((detail) => detail.includes("participant_transcript_status_idx"))).toBe(true);
    expect(plans.some((detail) => detail.includes("participant_transcript_attention_idx"))).toBe(true);
    expect(plans.some((detail) =>
      detail.includes("INTEGER PRIMARY KEY")
      || detail.includes("participant_transcript_sequence_idx"))).toBe(true);
  });
});
