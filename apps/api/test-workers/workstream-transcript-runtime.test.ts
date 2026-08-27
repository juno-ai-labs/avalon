/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { seedWorkstreamRoot } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000701");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000702");

beforeEach(async () => reset());

describe("work-stream transcript on workerd SQLite", () => {
  it("repairs a terminal run's open tool receipt before the first backfill", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const cutover = Number(state.storage.sql.exec<{ applied_at: number }>(
        `SELECT applied_at FROM _sql_schema_migrations WHERE version = 27`,
      ).one().applied_at);
      state.storage.sql.exec(`INSERT INTO parts
        (id, substream_id, sequence_number, role, kind, author_type, content,
         client_message_id, effect_intent_id, tool_name, tool_mode, tool_status,
         visibility, pinned, message_type, structured_content_json, created_at, updated_at)
        VALUES ('residual-tool', '0', 1, 'assistant', 'tool_call', 'agent', '',
                'tool:residual-tool', 'residual-tool', 'search', 'read', 'pending',
                'people', 0, 'tool', '{"invocation":{"status":"pending"}}', ?, ?)`,
      cutover - 1, cutover - 1);
      state.storage.sql.exec(`INSERT INTO runs
        (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
         next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
         idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
         input_tokens, output_tokens, cost_micros, output_bytes, legacy_attempt_id,
         terminalized_at, created_at, updated_at)
        VALUES ('terminal-run', '0', 'completed', '{}', 0, 0, '', 0, 0, 1,
                0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 'terminal-attempt', 5, 1, 5)`);
      state.storage.sql.exec(`INSERT INTO tool_effects
        (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
         tool_name, mode, request_hash, authority_revision, status, tool_call_id, input_json)
        VALUES ('residual-tool', 'terminal-run', 0, 0, 'residual-tool', 'search',
                'read', 'request', 'authority', 'admitted', 'provider-call', '{}')`);
    });

    const outcome = await stub.backfillLegacyTranscript({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000713",
      cutoverVersion: 27,
    });
    expect(outcome).toMatchObject({ applied: true, verified: true, participantTurnCount: 1 });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ tool_status: string }>(
        `SELECT tool_status FROM parts WHERE id = 'residual-tool'`,
      ).one().tool_status).toBe("failed");
      expect(state.storage.sql.exec<{ lifecycle_state: string }>(
        `SELECT lifecycle_state FROM participant_transcript_blocks WHERE turn_id = 'residual-tool'`,
      ).one().lifecycle_state).toBe("failed");
      state.storage.sql.exec(`INSERT INTO runs
        (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
         next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
         idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
         input_tokens, output_tokens, cost_micros, output_bytes, legacy_attempt_id,
         terminalized_at, created_at, updated_at)
        VALUES ('post-backfill-terminal-run', '0', 'completed', '{}', 0, 0, '', 0, 0, 6,
                0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 'post-backfill-attempt', 10, 6, 10)`);
      state.storage.sql.exec(`INSERT INTO tool_effects
        (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
         tool_name, mode, request_hash, authority_revision, status, tool_call_id, input_json)
        VALUES ('post-backfill-tool', 'post-backfill-terminal-run', 0, 0,
                'post-backfill-tool', 'search', 'read', 'request', 'authority',
                'admitted', 'post-backfill-provider-call', '{}')`);
    });

    const replay = await stub.backfillLegacyTranscript({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000714",
      cutoverVersion: 27,
    });
    expect(replay).toMatchObject({ applied: false, verified: true });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM tool_effects WHERE effect_intent_id = 'post-backfill-tool'`,
      ).one().status).toBe("admitted");
    });
  });

  it("does not reap an expired nonterminal run during transcript backfill", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      state.storage.sql.exec(`INSERT INTO runs
        (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
         next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
         idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
         input_tokens, output_tokens, cost_micros, output_bytes, legacy_attempt_id,
         lease_owner, lease_expires_at, heartbeat_at, created_at, updated_at)
        VALUES ('expired-running-run', '0', 'running', '{}', 0, 0, '', 0, 0, 1,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'expired-attempt',
                'expired-owner', 0, 0, 1, 1)`);
    });

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.backfillLegacyTranscript({
        objectId: id.toString(),
        operatorRunId: "00000000-0000-7000-8000-000000000715",
        cutoverVersion: 27,
      })).rejects.toThrow("legacy_transcript_backfill_not_quiescent");
      expect(state.storage.sql.exec<{ status: string; terminalized_at: number | null }>(
        `SELECT status, terminalized_at FROM runs WHERE run_id = 'expired-running-run'`,
      ).one()).toEqual({ status: "running", terminalized_at: null });
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(0);
    });
  });

  it("explicitly abandons only a lease-less pre-cutover run before backfill", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      state.storage.sql.exec(`INSERT INTO runs
        (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
         next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
         idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
         input_tokens, output_tokens, cost_micros, output_bytes, origin, created_at, updated_at)
        VALUES ('pre-cutover-lease-less-run', '0', 'running', '{}', 0, 0, '', 0, 0, 1,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'slack_workspace_opening_message', 1, 1)`);
    });

    const cleanup = await stub.abandonPreCutoverRunsForTranscriptBackfill({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000716",
      cutoverVersion: 27,
    });
    expect(cleanup).toEqual({
      abandonedRunCount: 1,
      cleanupOperatorRunId: "00000000-0000-7000-8000-000000000716",
    });
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(`INSERT INTO transcript_activities
        (activity_id, parent_activity_id, scope, subject_id, call_index, label,
         lifecycle_state, revision, created_at, updated_at)
        VALUES ('backfill-blocker', NULL, 'response', 'backfill-blocker', NULL,
                'Working', 'active', 1, 1, 1)`);
      await expect(instance.backfillLegacyTranscript({
        objectId: id.toString(),
        operatorRunId: "00000000-0000-7000-8000-000000000716",
        cutoverVersion: 27,
      })).rejects.toThrow("legacy_transcript_backfill_not_quiescent");
      state.storage.sql.exec(`UPDATE transcript_activities
        SET lifecycle_state = 'completed', revision = 2, updated_at = 2
        WHERE activity_id = 'backfill-blocker'`);
    });
    expect(await stub.abandonPreCutoverRunsForTranscriptBackfill({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000717",
      cutoverVersion: 27,
    })).toEqual({
      abandonedRunCount: 1,
      cleanupOperatorRunId: "00000000-0000-7000-8000-000000000716",
    });
    const outcome = await stub.backfillLegacyTranscript({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000717",
      cutoverVersion: 27,
    });
    expect(outcome).toMatchObject({ applied: true, verified: true });
    expect(await stub.abandonPreCutoverRunsForTranscriptBackfill({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000717",
      cutoverVersion: 27,
    })).toEqual({
      abandonedRunCount: 1,
      cleanupOperatorRunId: "00000000-0000-7000-8000-000000000716",
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{
        status: string;
        terminal_reason: string | null;
        error_code: string | null;
      }>(`SELECT status, terminal_reason, json_extract(error_json, '$.code') AS error_code
            FROM runs WHERE run_id = 'pre-cutover-lease-less-run'`).one()).toEqual({
        status: "failed",
        terminal_reason: "migration_cutover_abandoned",
        error_code: "migration_cutover_abandoned",
      });
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(1);
      expect(state.storage.sql.exec<{
        exact_state: string;
        state_reason_code: string;
      }>(`SELECT exact_state, state_reason_code FROM workstream WHERE id = 1`).one()).toEqual({
        exact_state: "failed",
        state_reason_code: "runtime_failed",
      });
      expect(state.storage.sql.exec<{
        operator_run_id: string;
        abandoned_run_count: number;
      }>(`SELECT operator_run_id, abandoned_run_count
            FROM legacy_transcript_cleanup_receipts`).one()).toEqual({
        operator_run_id: "00000000-0000-7000-8000-000000000716",
        abandoned_run_count: 1,
      });
    });
  });

  it.each([
    { name: "attempt id", attemptId: "live-attempt", leaseOwner: null,
      leaseExpiresAt: null, heartbeatAt: null, afterCutover: false, openReceipt: false },
    { name: "lease owner", attemptId: null, leaseOwner: "live-owner",
      leaseExpiresAt: null, heartbeatAt: null, afterCutover: false, openReceipt: false },
    { name: "lease deadline", attemptId: null, leaseOwner: null,
      leaseExpiresAt: 4_102_444_800_000, heartbeatAt: null, afterCutover: false, openReceipt: false },
    { name: "heartbeat", attemptId: null, leaseOwner: null,
      leaseExpiresAt: null, heartbeatAt: 1, afterCutover: false, openReceipt: false },
    { name: "post-cutover start", attemptId: null, leaseOwner: null,
      leaseExpiresAt: null, heartbeatAt: null, afterCutover: true, openReceipt: false },
    { name: "open tool receipt", attemptId: null, leaseOwner: null,
      leaseExpiresAt: null, heartbeatAt: null, afterCutover: false, openReceipt: true },
  ])("refuses to abandon a run with a $name", async ({
    attemptId,
    leaseOwner,
    leaseExpiresAt,
    heartbeatAt,
    afterCutover,
    openReceipt,
  }) => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const cutover = Number(state.storage.sql.exec<{ applied_at: number }>(
        `SELECT applied_at FROM _sql_schema_migrations WHERE version = 27`,
      ).one().applied_at);
      state.storage.sql.exec(`INSERT INTO runs
        (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
         next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
         idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
         input_tokens, output_tokens, cost_micros, output_bytes, legacy_attempt_id,
         lease_owner, lease_expires_at, heartbeat_at, created_at, updated_at)
        VALUES ('guarded-pre-cutover-run', '0', 'running', '{}', 0, 0, '', 0, 0, ?1,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?2, ?3, ?4, ?5, 1, 1)`,
      afterCutover ? cutover + 1 : cutover - 1,
      attemptId,
      leaseOwner,
      leaseExpiresAt,
      heartbeatAt);
      if (openReceipt) {
        state.storage.sql.exec(`INSERT INTO tool_effects
          (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
           tool_name, mode, request_hash, authority_revision, status, tool_call_id, input_json)
          VALUES ('guarded-open-tool', 'guarded-pre-cutover-run', 0, 0,
                  'guarded-open-tool', 'search', 'read', 'request', 'authority',
                  'admitted', 'guarded-open-provider-call', '{}')`);
      }
      await expect(instance.abandonPreCutoverRunsForTranscriptBackfill({
        objectId: id.toString(),
        operatorRunId: "00000000-0000-7000-8000-000000000718",
        cutoverVersion: 27,
      })).rejects.toThrow(openReceipt
        ? "legacy_transcript_pre_cutover_run_has_open_receipt"
        : "legacy_transcript_pre_cutover_run_not_abandonable");
      expect(state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM runs WHERE run_id = 'guarded-pre-cutover-run'`,
      ).one().status).toBe("running");
    });
  });

  it("refuses to renumber while a client holds an immutable transcript snapshot", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const pair = new WebSocketPair();
      const server = pair[1];
      state.acceptWebSocket(server);
      server.serializeAttachment({
        connectionId: "00000000-0000-7000-8000-000000000710",
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        substreamId: "0",
        userId: "00000000-0000-7000-8000-000000000711",
        connectedAt: "2026-08-26T00:00:00.000Z",
        afterSequence: 0,
        subscribed: true,
        snapshotInFlight: false,
        transcriptSnapshot: {
          snapshotId: "snapshot-before-backfill",
          snapshotThrough: 1,
          snapshotAtUtc: "2026-08-26T00:00:00.000Z",
        },
      });

      await expect(instance.backfillLegacyTranscript({
        objectId: id.toString(),
        operatorRunId: "00000000-0000-7000-8000-000000000712",
        cutoverVersion: 27,
      })).rejects.toThrow("legacy_transcript_backfill_live_snapshot");
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(0);
    });
  });

  it("refuses to create a successful no-op receipt for an auxiliary substream", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName("auxiliary-substream-backfill-test");
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(`INSERT INTO substream_agent_identity
        (id, external_substream_id, created_at, updated_at)
        VALUES (1, '00000000-0000-7000-8000-000000000703', 0, 0)`);
      await expect(instance.backfillLegacyTranscript({
        objectId: id.toString(),
        operatorRunId: "00000000-0000-7000-8000-000000000700",
        cutoverVersion: 27,
      })).rejects.toThrow("legacy_transcript_backfill_requires_main_substream");
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(0);
    });
  });

  it("backfills through the production RPC with a real PITR bookmark and reconciles replay", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const cutover = Number(state.storage.sql.exec<{ applied_at: number }>(
        `SELECT applied_at FROM _sql_schema_migrations WHERE version = 27`,
      ).one().applied_at);
      state.storage.sql.exec(`INSERT INTO substreams
        (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
        VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)` , cutover - 1);
      state.storage.sql.exec(`INSERT INTO parts
        (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
         author_user_id, content, client_message_id, visibility, pinned, message_type,
         created_at, updated_at)
        VALUES ('legacy-workerd', '0', 1, 1, 'user', 'text', 'member', 'user-1',
                'Legacy', 'legacy-workerd-client', 'both', 0, 'text', ?, ?)`,
      cutover - 1, cutover - 1);
    });

    const first = await stub.backfillLegacyTranscript({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000701",
      cutoverVersion: 27,
    });
    expect(first).toMatchObject({
      applied: true,
      verified: true,
      sourcePartCount: 1,
      participantTurnCount: 1,
    });
    expect(first.preBackfillBookmark.length).toBeGreaterThan(0);

    const replay = await stub.backfillLegacyTranscript({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000702",
      cutoverVersion: 27,
    });
    expect(replay).toMatchObject({ applied: false, verified: true });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM participant_transcript_turns`).one().count).toBe(1);
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(1);
    });
  });

  it("commits the exact loop and participant projections atomically and preserves snapshot fences", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, async (_instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.commitBindTransition({
        kind: "state_initialized",
        loopId: "run-workerd",
        generation: 1,
        stateRevision: 1,
        systemProjection: {
          revision: 1,
          rendererVersion: "workstream-system-v1",
          inputHash: "system-input",
          message: { role: "system", content: "System" },
        },
        nonSystemMessages: [{ role: "user", content: "Question" }],
        nonSystemMessageOrigins: [{
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: "message-1",
          sourceRevision: 1,
        }],
      });
      await transcript.commitBindTransition({
        kind: "assistant_accepted",
        loopId: "run-workerd",
        generation: 1,
        stateRevision: 2,
        turnId: "run-workerd:turn:1",
        modelTurnIndex: 1,
        message: {
          role: "assistant",
          content: "Before",
          tool_calls: [{
            id: "provider-call",
            type: "function",
            function: { name: "search", arguments: "{}" },
          }],
        },
      });

      const snapshot = transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null });
      expect(snapshot.ranges[0]!.turns[0]!.blocks.map((block) => block.type))
        .toEqual(["text", "tool"]);
      expect(transcript.readBindProjection("run-workerd")?.nonSystemMessages.map((message) => message.role))
        .toEqual(["user", "assistant"]);
      expect(state.storage.sql.exec<{
        origin_kind: string;
        source_kind: string | null;
        source_id: string | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT fact.origin_kind, fact.source_kind, fact.source_id
           FROM bind_loop_state_messages projected
           JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
          WHERE projected.loop_id = 'run-workerd'
            AND projected.state_revision = 2
            AND projected.message_position = 1`,
      ).one()).toMatchObject({
        origin_kind: "derived",
        source_kind: "participant_turn",
        source_id: "message-1",
      });

      await transcript.appendParticipantMessage({
        turnId: "after-fence",
        actor: "human",
        authorUserId: "user-1",
        text: "After",
        createdAtUtc: new Date().toISOString(),
        attentionOrdinal: 1,
      });
      expect(transcript.range(snapshot, { startInclusive: 1, endExclusive: 10 }).covered)
        .toEqual({ startInclusive: 1, endExclusive: 2 });
    });
  });
});
