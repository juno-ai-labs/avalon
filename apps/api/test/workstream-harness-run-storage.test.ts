import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { BindLoopTransition } from "@rally/agent-harness";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import {
  expireLocalAttemptLeasesFromPreviousInstance,
  PREVIOUS_INSTANCE_RECOVERY_OWNER_PREFIX,
  previousInstanceRecoveryOwner,
  WorkstreamHarnessRunStorage,
} from "../src/durable-objects/workstream-harness-run-storage";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_787_000_000_000;
const RUN = "00000000-0000-7000-8000-0000000000a1";
const OTHER = "00000000-0000-7000-8000-0000000000a2";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function open() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "harness-run-storage-test", NOW);
  sql.exec(`INSERT INTO workstream (
      id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
      authority_mode, authority_generation, title, description, preview, scope,
      exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
      unread_tracking_start_ordinal, authority_epoch, scope_epoch,
      source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
      created_at, last_people_activity_at, state_changed_at, updated_at
    ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
              'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
  sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
    VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
  return { binding, storage: new WorkstreamHarnessRunStorage(binding), sql };
}

function seedRun(
  sql: SqlStorage,
  runId: string,
  overrides: {
    status?: string;
    origin?: string;
    startedAt?: number;
    parentRunId?: string;
    parentToolCallId?: string;
    chainRootRunId?: string;
  } = {},
): void {
  // A delegated sub-agent gets its own substream, which is why a running child
  // receives a distinct substream and stable loop identity from its parent.
  const substreamId = overrides.parentToolCallId ? `run:${runId}` : "0";
  if (substreamId !== "0") {
    sql.exec(
      `INSERT OR IGNORE INTO substreams
         (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq, depth,
          return_mode, audience, tool_policy, status, created_at)
       VALUES (?, 'agent', 'fork', '0', 0, 1, 'tool_result', 'system', 'read_only', 'open', 1)`,
      substreamId,
    );
  }
  sql.exec(
    `INSERT INTO runs
       (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
        next_action_cursor, input_fence_seq, revision, started_at,
        active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
        tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
        origin, execution_principal_json, chain_depth, parent_run_id,
        parent_tool_call_id, chain_root_run_id, created_at, updated_at)
     VALUES (?, ?, ?, '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, '{}', 0, ?, ?, ?, 1, 1)`,
    runId,
    substreamId,
    overrides.status ?? "admitted",
    overrides.startedAt ?? 0,
    overrides.origin ?? "member_message",
    overrides.parentRunId ?? null,
    overrides.parentToolCallId ?? null,
    overrides.chainRootRunId ?? null,
  );
}

function seedTransientCheckpoints(
  sql: SqlStorage,
  runId: string,
  attemptId: string,
  attemptEpoch: number,
): void {
  sql.exec(
    `INSERT INTO active_output_turns
       (run_id, attempt_epoch, turn_id, transcript_sequence, substream_id, status,
        durable_event_seq, durable_through_frame_seq, next_chunk_index, stream_id,
        seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
     VALUES (?, ?, ?, 1, '0', 'streaming', 1, 1, 1, ?, '[]', 0, ?, ?, ?)`,
    runId,
    attemptEpoch,
    `${runId}:turn`,
    `${runId}:stream`,
    NOW,
    NOW,
    NOW,
  );
  sql.exec(
    `INSERT INTO active_agent_compaction
       (id, run_id, attempt_id, compaction_index, trigger, started_at, updated_at)
     VALUES (1, ?, ?, 1, 'auto', ?, ?)`,
    runId,
    attemptId,
    NOW,
    NOW,
  );
  sql.exec(
    `INSERT INTO inference_delay_status
       (inference_request_id, run_id, execution_id, root_attempt_id, attempt_id, turn_id, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    `${runId}:inference`,
    runId,
    runId,
    attemptId,
    attemptId,
    `${runId}:turn`,
  );
}

function expectNoTransientCheckpoints(sql: SqlStorage, runId: string): void {
  for (const table of [
    "active_output_turns",
    "active_agent_compaction",
    "inference_delay_status",
  ]) {
    expect(sql.exec(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`, runId).one())
      .toEqual({ count: 0 });
  }
}

const fence = { attemptId: "attempt-1", owner: "owner-1", now: NOW };

describe("claiming a run's attempt", () => {
  it("takes the lease, stamps the start, and records the claim once", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);

    const claimed = storage.claimAttempt({
      ...fence,
      runId: RUN,
      leaseSeconds: 60,
      lifecycleEventId: "event-1",
    });

    expect(claimed).toEqual({
      outcome: "claimed",
      attemptEpoch: 1,
      leaseExpiresAt: NOW + 60_000,
      startedAt: NOW,
    });
    expect(sql.exec(`SELECT status, lease_owner FROM runs WHERE run_id = ?`, RUN).one())
      .toMatchObject({ status: "running", lease_owner: "owner-1" });
    // The lifecycle event is the claim's own record, written in the same
    // transaction. The routed version wrote it as a second statement whose
    // `WHERE` re-stated the claim's fence, because a batch cannot ask whether
    // its own first statement landed.
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "attempt:attempt-1:claimed" }))
      .toMatchObject({ event_type: "claimed", status: "running" });
  });

  it("keeps the epoch and the original start when the same attempt reclaims", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1" });

    const again = storage.claimAttempt({
      ...fence,
      runId: RUN,
      now: NOW + 10_000,
      leaseSeconds: 60,
      lifecycleEventId: "event-2",
    });

    // A retrying executor renewing its own attempt is not a new attempt, and the
    // run did not start again — `started_at` is what the member sees as the
    // beginning of the work.
    expect(again).toMatchObject({ outcome: "claimed", attemptEpoch: 1, startedAt: NOW });
  });

  it("resumes a previous instance's attempt immediately under a new owner", () => {
    const { binding, storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 300, lifecycleEventId: "event-1" });

    const recoverable = expireLocalAttemptLeasesFromPreviousInstance(binding, NOW + 1_000);
    expect(recoverable).toEqual([{ runId: RUN, attemptId: "attempt-1" }]);
    expect(sql.exec(
      `SELECT lease_owner, lease_expires_at FROM runs WHERE run_id = ?`,
      RUN,
    ).one()).toEqual({
      lease_owner: `${PREVIOUS_INSTANCE_RECOVERY_OWNER_PREFIX}attempt-1`,
      lease_expires_at: NOW + 1_000,
    });

    // Recovery intent is durable rather than resident in one replacement's
    // in-memory map. A second reconstruction before the claim rediscovers the
    // same attempt even though its deliberately expired lease is no longer
    // "live" by time alone.
    expect(expireLocalAttemptLeasesFromPreviousInstance(binding, NOW + 2_000))
      .toEqual([{ runId: RUN, attemptId: "attempt-1" }]);

    const resumed = storage.claimAttempt({
      runId: RUN,
      attemptId: "attempt-1",
      owner: "owner-2",
      now: NOW + 2_000,
      leaseSeconds: 300,
      lifecycleEventId: "event-2",
    });
    expect(resumed).toMatchObject({
      outcome: "claimed",
      attemptEpoch: 2,
      startedAt: NOW,
    });
    expect(sql.exec(
      `SELECT legacy_attempt_id, lease_owner, lease_expires_at FROM runs WHERE run_id = ?`,
      RUN,
    ).one()).toMatchObject({
      legacy_attempt_id: "attempt-1",
      lease_owner: "owner-2",
      lease_expires_at: NOW + 302_000,
    });
  });

  it("settles a recovered attempt whose cancellation preceded the eviction", () => {
    const { binding, storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 300, lifecycleEventId: "event-1" });
    sql.exec(
      `UPDATE runs SET cancellation_requested_at = ?, cancellation_reason = 'member_stop'
        WHERE run_id = ?`,
      NOW + 500,
      RUN,
    );
    expireLocalAttemptLeasesFromPreviousInstance(binding, NOW + 1_000);

    expect(storage.terminalizeAttempt({
      runId: RUN,
      attemptId: "attempt-1",
      owner: previousInstanceRecoveryOwner("attempt-1"),
      now: NOW + 2_000,
      status: "cancelled",
      finalTurnId: null,
      model: null,
      usageJson: null,
      errorJson: null,
      memberSafePayloadJson: '{"code":"run_cancelled"}',
      lifecycleEventId: "event-terminal",
      receiptMarkerEventKey: "residual_receipts_settled",
      loopExecutionFence: null,
    })).toMatchObject({ outcome: "terminalized" });
    expect(sql.exec(
      `SELECT status, terminalized_at, lease_owner, lease_expires_at FROM runs WHERE run_id = ?`,
      RUN,
    ).one()).toEqual({
      status: "cancelled",
      terminalized_at: NOW + 2_000,
      lease_owner: null,
      lease_expires_at: null,
    });
    // Recovery and automation settlement read these fields through the typed
    // run operation. Receipt cancellation remains provenance; it is not the
    // persistent loop's stop authority.
    expect(storage.run({ runId: RUN })).toMatchObject({
      status: "cancelled",
      terminalized_at: NOW + 2_000,
      final_turn_id: null,
      error_json: null,
      cancellation_reason: "member_stop",
    });
  });

  it("terminalizes a linked receipt and closes only its exact loop execution atomically", () => {
    const { binding, storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 300, lifecycleEventId: "event-1" });
    sql.exec(
      `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
      RUN,
    );
    const loops = new SubstreamLoopStorage(binding);
    const loopId = "terminal-loop";
    loops.ensureLoop({ loopId, bindStateRevision: 0, now: NOW });
    loops.activateExecutionReceipt({
      runId: RUN,
      loopId,
      executionEpoch: 1,
      leaseOwner: "loop-owner",
      leaseExpiresAt: NOW + 300_000,
      expectedLoopRevision: loops.loop()!.revision,
      expectedBindStateRevision: 0,
      now: NOW,
    });
    sql.exec(
      `INSERT INTO transcript_activities
         (activity_id, parent_activity_id, scope, subject_id, call_index, label,
          lifecycle_state, revision, created_at, updated_at)
       VALUES (?, NULL, 'response', ?, NULL, 'Working', 'active', 1, ?, ?),
              (?, ?, 'assistant_turn', 'turn-1', 1, 'Assistant turn', 'active', 1, ?, ?)`,
      `${RUN}:activity`,
      RUN,
      NOW - 1_000,
      NOW - 1_000,
      `${RUN}:turn:1:activity`,
      `${RUN}:activity`,
      NOW - 900,
      NOW - 900,
    );
    sql.exec(
      `INSERT INTO transcript_activity_intervals
         (activity_id, interval_id, started_at, stopped_at, duration_ms,
          boundary_source, timing_accuracy, revision)
       VALUES (?, ?, ?, NULL, NULL, 'rally', 'observed', 1),
              (?, ?, ?, NULL, NULL, 'rally', 'observed', 1)`,
      `${RUN}:activity`,
      `${RUN}:activity:1`,
      NOW - 1_000,
      `${RUN}:turn:1:activity`,
      `${RUN}:turn:1:activity:1`,
      NOW - 900,
    );
    seedTransientCheckpoints(sql, RUN, fence.attemptId, 1);
    const terminalInput = {
      ...fence,
      runId: RUN,
      now: NOW + 1,
      status: "failed" as const,
      finalTurnId: null,
      model: null,
      usageJson: null,
      errorJson: '{"code":"test_failure"}',
      memberSafePayloadJson: '{"code":"test_failure"}',
      lifecycleEventId: "event-terminal",
      receiptMarkerEventKey: "residual_receipts_settled",
    };

    // A receipt-level cancellation request can arrive before the persistent
    // loop reaches its safe boundary. It remains provenance on the receipt;
    // only the exact loop execution fence may choose the terminal outcome.
    sql.exec(
      `UPDATE runs
          SET cancellation_requested_at = ?, cancellation_reason = ?
        WHERE run_id = ?`,
      NOW,
      "obsolete_receipt_stop",
      RUN,
    );

    expect(storage.terminalizeAttempt({
      ...terminalInput,
      loopExecutionFence: {
        loopId,
        executionId: RUN,
        executionEpoch: 1,
        leaseOwner: "wrong-owner",
      },
    })).toEqual({ outcome: "ownership_lost" });
    expect(sql.exec(
      `SELECT status, terminalized_at FROM runs WHERE run_id = ?`, RUN,
    ).one()).toEqual({ status: "running", terminalized_at: null });
    expect(loops.loop()).toMatchObject({ status: "executing", active_execution_id: RUN });
    expect(sql.exec(
      `SELECT lifecycle_state FROM transcript_activities WHERE activity_id = ?`,
      `${RUN}:activity`,
    ).one()).toEqual({ lifecycle_state: "active" });

    expect(storage.terminalizeAttempt({
      ...terminalInput,
      loopExecutionFence: {
        loopId,
        executionId: RUN,
        executionEpoch: 1,
        leaseOwner: "loop-owner",
      },
    })).toEqual({ outcome: "terminalized" });
    expect(sql.exec(
      `SELECT status, terminalized_at, cancellation_reason FROM runs WHERE run_id = ?`, RUN,
    ).one()).toEqual({
      status: "failed",
      terminalized_at: NOW + 1,
      cancellation_reason: "obsolete_receipt_stop",
    });
    expect(loops.loop()).toMatchObject({
      status: "idle",
      cycle_ordinal: 1,
      active_execution_id: null,
      active_execution_epoch: null,
    });
    expect(sql.exec(
      `SELECT activity_id, lifecycle_state, revision
         FROM transcript_activities
        WHERE activity_id IN (?, ?) ORDER BY activity_id`,
      `${RUN}:activity`,
      `${RUN}:turn:1:activity`,
    ).toArray()).toEqual([
      { activity_id: `${RUN}:activity`, lifecycle_state: "failed", revision: 2 },
      { activity_id: `${RUN}:turn:1:activity`, lifecycle_state: "failed", revision: 2 },
    ]);
    expect(sql.exec(
      `SELECT activity_id, stopped_at, duration_ms, boundary_source,
              timing_accuracy, revision
         FROM transcript_activity_intervals
        WHERE activity_id IN (?, ?) ORDER BY activity_id`,
      `${RUN}:activity`,
      `${RUN}:turn:1:activity`,
    ).toArray()).toEqual([
      {
        activity_id: `${RUN}:activity`,
        stopped_at: NOW + 1,
        duration_ms: 1_001,
        boundary_source: "recovered",
        timing_accuracy: "upper_bound",
        revision: 2,
      },
      {
        activity_id: `${RUN}:turn:1:activity`,
        stopped_at: NOW + 1,
        duration_ms: 901,
        boundary_source: "recovered",
        timing_accuracy: "upper_bound",
        revision: 2,
      },
    ]);
    expectNoTransientCheckpoints(sql, RUN);
  });

  it("leaves an already-expired attempt for the stale-run reaper", () => {
    const { binding, storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1" });

    expect(expireLocalAttemptLeasesFromPreviousInstance(binding, NOW + 60_001)).toEqual([]);
    expect(sql.exec(`SELECT lease_owner, lease_expires_at FROM runs WHERE run_id = ?`, RUN).one())
      .toMatchObject({ lease_owner: "owner-1", lease_expires_at: NOW + 60_000 });
  });

  it("refuses while another interactive run holds a live lease", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    seedRun(sql, OTHER);
    storage.claimAttempt({
      ...fence, runId: OTHER, leaseSeconds: 60, lifecycleEventId: "event-other",
    });

    // The refusal says *why*, and when to look again — the routed version
    // needed a second statement with a correlated subquery for that.
    expect(storage.claimAttempt({
      ...fence, runId: RUN, attemptId: "attempt-2", leaseSeconds: 60, lifecycleEventId: "event-1",
    })).toEqual({ outcome: "busy", activeLeaseExpiresAt: NOW + 60_000 });
  });

  it("marks the work stream running, and stamps when that changed", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);

    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1" });

    // The claim batch's third statement. It is the sidebar's whole answer to
    // "is this work stream busy", and the routed version wrote it guarded on
    // the first statement having landed.
    expect(sql.exec(
      `SELECT exact_state, state_reason_code, state_changed_at, last_people_activity_at
         FROM workstream WHERE id = 1`,
    ).one()).toMatchObject({
      exact_state: "running",
      state_reason_code: "runtime_running",
      state_changed_at: NOW,
      last_people_activity_at: NOW,
    });
  });

  it("does not demote a work stream that is already busy in a more exact way", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    sql.exec(
      `UPDATE workstream SET exact_state = 'interrupting', state_reason_code = 'member_stop',
              state_changed_at = ? WHERE id = 1`,
      NOW - 5_000,
    );

    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1" });

    // `interrupting`, `preparing_context` and `waiting_capacity` all published
    // as `running` through the retired view, so its trigger compared the
    // *projection* on both sides and left the exact state alone. Writing plain
    // `running` here would lose the reason a member is being shown.
    expect(sql.exec(
      `SELECT exact_state, state_reason_code, state_changed_at, last_people_activity_at
         FROM workstream WHERE id = 1`,
    ).one()).toMatchObject({
      exact_state: "interrupting",
      state_reason_code: "member_stop",
      state_changed_at: NOW - 5_000,
      // Activity is not a state change: the claim happened, whatever it left
      // the state as.
      last_people_activity_at: NOW,
    });
  });

  it("reports the contended run's own lease when a duplicate dispatch races it", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 300, lifecycleEventId: "event-first",
    });

    // An at-least-once dispatch delivering the same run twice: the second
    // executor is refused, and the lease it must wait for is *this run's own*.
    // Answering null would be read by both agents as "retry in five seconds",
    // so a duplicate dispatch would wake and reattempt every five seconds for
    // the whole five-minute lease instead of once at the end of it.
    expect(storage.claimAttempt({
      ...fence, runId: RUN, attemptId: "attempt-2", owner: "owner-2",
      leaseSeconds: 300, lifecycleEventId: "event-second",
    })).toEqual({ outcome: "busy", activeLeaseExpiresAt: NOW + 300_000 });
    expect(sql.exec(`SELECT lease_owner FROM runs WHERE run_id = ?`, RUN).one())
      .toMatchObject({ lease_owner: "owner-1" });
  });

  it("refuses a run whose cancellation was requested", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    expect(storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1",
    })).toEqual({ outcome: "cancelled" });
  });

  it("reports a finished run as terminal rather than busy", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN, { status: "completed" });

    // The caller reports the outcome instead of retrying, so telling this apart
    // from a contended work stream is the difference between answering the
    // member and spinning.
    expect(storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1",
    })).toEqual({ outcome: "terminal", status: "completed" });
  });

  it("says so when the run is not there at all", () => {
    const { storage } = open();

    expect(storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1",
    })).toEqual({ outcome: "not_found" });
  });
});

describe("reaping a stale root", () => {
  it("leaves a loop-linked receipt to persistent-loop recovery", () => {
    const { binding, storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({
      ...fence,
      runId: RUN,
      leaseSeconds: 60,
      lifecycleEventId: "event-claim",
    });
    sql.exec(
      `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
      RUN,
    );
    const loops = new SubstreamLoopStorage(binding);
    loops.ensureLoop({ loopId: RUN, bindStateRevision: 0, now: NOW });
    loops.activateExecutionReceipt({
      runId: RUN,
      loopId: RUN,
      executionEpoch: 1,
      leaseOwner: "loop-owner",
      leaseExpiresAt: NOW + 60_000,
      expectedLoopRevision: loops.loop()!.revision,
      expectedBindStateRevision: 0,
      now: NOW,
    });

    expect(storage.staleLeaseRuns({ now: NOW + 60_001, limit: 25 })).toEqual([]);
    expect(storage.reapStaleRoot({
      runId: RUN,
      attemptId: fence.attemptId,
      leaseExpiresAt: NOW + 60_000,
      lifecycleEventId: "event-terminal",
      now: NOW + 60_001,
    })).toEqual({ outcome: "not_stale" });
    expect(storage.run({ runId: RUN })).toMatchObject({
      status: "running",
      terminalized_at: null,
    });
    expect(loops.loop()).toMatchObject({
      status: "executing",
      active_execution_id: RUN,
    });
  });

  it("closes its activity tree and removes its transient presentation checkpoints", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    seedRun(sql, OTHER);
    storage.claimAttempt({
      ...fence,
      runId: RUN,
      leaseSeconds: 60,
      lifecycleEventId: "event-claim",
    });
    sql.exec(
      `INSERT INTO transcript_activities
         (activity_id, parent_activity_id, scope, subject_id, call_index, label,
          lifecycle_state, revision, created_at, updated_at)
       VALUES (?, NULL, 'response', ?, NULL, 'Working', 'active', 1, ?, ?),
              (?, ?, 'assistant_turn', 'turn-1', 1, 'Assistant turn', 'active', 1, ?, ?)`,
      `${RUN}:activity`,
      RUN,
      NOW - 1_000,
      NOW - 1_000,
      `${RUN}:turn:1:activity`,
      `${RUN}:activity`,
      NOW - 900,
      NOW - 900,
    );
    sql.exec(
      `INSERT INTO transcript_activity_intervals
         (activity_id, interval_id, started_at, stopped_at, duration_ms,
          boundary_source, timing_accuracy, revision)
       VALUES (?, ?, ?, NULL, NULL, 'rally', 'observed', 1),
              (?, ?, ?, NULL, NULL, 'rally', 'observed', 1)`,
      `${RUN}:activity`,
      `${RUN}:activity:1`,
      NOW - 1_000,
      `${RUN}:turn:1:activity`,
      `${RUN}:turn:1:activity:1`,
      NOW - 900,
    );
    sql.exec(
      `INSERT INTO active_output_turns
         (run_id, attempt_epoch, turn_id, transcript_sequence, substream_id, status,
          durable_event_seq, durable_through_frame_seq, next_chunk_index, stream_id,
          seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
       VALUES (?, 1, 'turn-1', 1, '0', 'streaming', 1, 1, 1, ?, '[]', 0, ?, ?, ?)`,
      RUN,
      RUN,
      NOW - 900,
      NOW - 800,
      NOW - 800,
    );
    sql.exec(
      `INSERT INTO active_output_chunks
         (run_id, attempt_epoch, chunk_index, text, byte_length, first_frame_seq,
          through_frame_seq, content_hash, updated_at)
       VALUES (?, 1, 0, 'partial', 7, 1, 1, 'hash', ?)`,
      RUN,
      NOW - 800,
    );
    sql.exec(
      `INSERT INTO active_output_turns
         (run_id, attempt_epoch, turn_id, transcript_sequence, substream_id, status,
          durable_event_seq, durable_through_frame_seq, next_chunk_index, stream_id,
          seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
       VALUES (?, 1, 'turn-other', 2, '0', 'streaming', 1, 1, 1, ?, '[]', 0, ?, ?, ?)`,
      OTHER,
      OTHER,
      NOW - 600,
      NOW - 500,
      NOW - 500,
    );
    sql.exec(
      `INSERT INTO active_output_chunks
         (run_id, attempt_epoch, chunk_index, text, byte_length, first_frame_seq,
          through_frame_seq, content_hash, updated_at)
       VALUES (?, 1, 0, 'other', 5, 1, 1, 'other-hash', ?)`,
      OTHER,
      NOW - 500,
    );
    sql.exec(
      `INSERT INTO active_agent_compaction
         (id, run_id, attempt_id, compaction_index, trigger, started_at, updated_at)
       VALUES (1, ?, 'attempt-1', 1, 'auto', ?, ?)`,
      RUN,
      NOW - 700,
      NOW - 700,
    );
    sql.exec(
      `INSERT INTO inference_delay_status
         (inference_request_id, run_id, execution_id, root_attempt_id, attempt_id, turn_id, active)
       VALUES ('inference-1', ?, ?, 'attempt-1', 'attempt-1', 'turn-1', 1),
              ('inference-other', ?, ?, 'attempt-other', 'attempt-other', 'turn-other', 1)`,
      RUN,
      RUN,
      OTHER,
      OTHER,
    );

    expect(storage.reapStaleRoot({
      runId: RUN,
      attemptId: "attempt-1",
      leaseExpiresAt: NOW + 60_000,
      lifecycleEventId: "event-terminal",
      now: NOW + 60_001,
    })).toEqual({ outcome: "reaped" });

    expect(sql.exec(
      `SELECT status, terminalized_at FROM runs WHERE run_id = ?`,
      RUN,
    ).one()).toEqual({ status: "failed", terminalized_at: NOW + 60_001 });
    expect(sql.exec(
      `SELECT activity_id, lifecycle_state, revision
         FROM transcript_activities
        WHERE activity_id IN (?, ?) ORDER BY activity_id`,
      `${RUN}:activity`,
      `${RUN}:turn:1:activity`,
    ).toArray()).toEqual([
      { activity_id: `${RUN}:activity`, lifecycle_state: "failed", revision: 2 },
      { activity_id: `${RUN}:turn:1:activity`, lifecycle_state: "failed", revision: 2 },
    ]);
    expect(sql.exec(
      `SELECT activity_id, stopped_at, duration_ms, boundary_source,
              timing_accuracy, revision
         FROM transcript_activity_intervals
        WHERE activity_id IN (?, ?) ORDER BY activity_id`,
      `${RUN}:activity`,
      `${RUN}:turn:1:activity`,
    ).toArray()).toEqual([
      {
        activity_id: `${RUN}:activity`,
        stopped_at: NOW + 60_000,
        duration_ms: 61_000,
        boundary_source: "recovered",
        timing_accuracy: "upper_bound",
        revision: 2,
      },
      {
        activity_id: `${RUN}:turn:1:activity`,
        stopped_at: NOW + 60_000,
        duration_ms: 60_900,
        boundary_source: "recovered",
        timing_accuracy: "upper_bound",
        revision: 2,
      },
    ]);
    expect(sql.exec(`SELECT run_id FROM active_output_turns`).toArray())
      .toEqual([{ run_id: OTHER }]);
    expect(sql.exec(`SELECT run_id FROM active_output_chunks`).toArray())
      .toEqual([{ run_id: OTHER }]);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM active_agent_compaction`).one())
      .toEqual({ count: 0 });
    expect(sql.exec(`SELECT run_id FROM inference_delay_status`).toArray())
      .toEqual([{ run_id: OTHER }]);
  });

  it("preserves another run's singleton compaction checkpoint", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    seedRun(sql, OTHER);
    storage.claimAttempt({
      ...fence,
      runId: RUN,
      leaseSeconds: 60,
      lifecycleEventId: "event-claim",
    });
    sql.exec(
      `INSERT INTO active_agent_compaction
         (id, run_id, attempt_id, compaction_index, trigger, started_at, updated_at)
       VALUES (1, ?, 'attempt-other', 1, 'auto', ?, ?)`,
      OTHER,
      NOW - 700,
      NOW - 700,
    );

    expect(storage.reapStaleRoot({
      runId: RUN,
      attemptId: "attempt-1",
      leaseExpiresAt: NOW + 60_000,
      lifecycleEventId: "event-terminal",
      now: NOW + 60_001,
    })).toEqual({ outcome: "reaped" });

    expect(sql.exec(
      `SELECT run_id, attempt_id FROM active_agent_compaction WHERE id = 1`,
    ).one()).toEqual({ run_id: OTHER, attempt_id: "attempt-other" });
  });

  it("leaves all subordinate state untouched when the stale fence is not authoritative", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    seedRun(sql, OTHER, {
      parentRunId: RUN,
      parentToolCallId: "tool-child",
      chainRootRunId: RUN,
    });
    storage.claimAttempt({
      ...fence,
      runId: RUN,
      leaseSeconds: 60,
      lifecycleEventId: "event-claim",
    });
    sql.exec(
      `INSERT INTO transcript_activities
         (activity_id, parent_activity_id, scope, subject_id, call_index, label,
          lifecycle_state, revision, created_at, updated_at)
       VALUES (?, NULL, 'response', ?, NULL, 'Working', 'active', 1, ?, ?)`,
      `${RUN}:activity`,
      RUN,
      NOW,
      NOW,
    );
    seedTransientCheckpoints(sql, RUN, fence.attemptId, 1);

    expect(storage.reapStaleRoot({
      runId: RUN,
      attemptId: "attempt-1",
      leaseExpiresAt: NOW + 59_999,
      lifecycleEventId: "event-terminal",
      now: NOW + 60_001,
    })).toEqual({ outcome: "not_stale" });

    expect(storage.reapStaleRoot({
      runId: RUN,
      attemptId: "attempt-1",
      leaseExpiresAt: NOW + 60_000,
      lifecycleEventId: "event-terminal-live-deadline",
      now: NOW + 59_999,
    })).toEqual({ outcome: "not_stale" });

    expect(sql.exec(
      `SELECT lifecycle_state, revision FROM transcript_activities WHERE activity_id = ?`,
      `${RUN}:activity`,
    ).one()).toEqual({ lifecycle_state: "active", revision: 1 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM active_output_turns WHERE run_id = ?`, RUN).one())
      .toEqual({ count: 1 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM active_agent_compaction WHERE run_id = ?`, RUN).one())
      .toEqual({ count: 1 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM inference_delay_status WHERE run_id = ?`, RUN).one())
      .toEqual({ count: 1 });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'terminal'`,
      RUN,
    ).one()).toEqual({ count: 0 });
    expect(storage.run({ runId: OTHER })).toMatchObject({
      cancellation_requested_at: null,
      cancellation_reason: null,
    });
    expect(sql.exec(`SELECT status, lease_expires_at FROM runs WHERE run_id = ?`, RUN).one())
      .toEqual({ status: "running", lease_expires_at: NOW + 60_000 });
  });
});

describe("renewing and proving a lease", () => {
  function claimed() {
    const opened = open();
    seedRun(opened.sql, RUN);
    opened.storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1",
    });
    return opened;
  }

  it("pushes the deadline forward and answers with it", () => {
    const { storage } = claimed();

    // One round trip where the routed version took three: the update, a re-read
    // to classify a zero-change result, and a third read for the deadline it
    // had just written itself.
    expect(storage.heartbeatAttempt({
      ...fence, runId: RUN, now: NOW + 5_000, leaseSeconds: 60,
    })).toEqual({ outcome: "renewed", leaseExpiresAt: NOW + 65_000 });
  });

  it("tells a cancelled run apart from a lost lease", () => {
    const { storage, sql } = claimed();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    // Two different endings for the caller: a member stopped this, or somebody
    // else owns the attempt. The routed version reported both as zero changes
    // and needed a second statement to tell them apart.
    expect(storage.heartbeatAttempt({ ...fence, runId: RUN, leaseSeconds: 60 }))
      .toEqual({ outcome: "cancelled" });
    sql.exec(`UPDATE runs SET cancellation_requested_at = NULL, lease_owner = 'someone-else' WHERE run_id = ?`, RUN);
    expect(storage.heartbeatAttempt({ ...fence, runId: RUN, leaseSeconds: 60 }))
      .toEqual({ outcome: "ownership_lost" });
  });

  it("refuses to renew a lapsed lease", () => {
    const { storage } = claimed();

    expect(storage.heartbeatAttempt({
      ...fence, runId: RUN, now: NOW + 61_000, leaseSeconds: 60,
    })).toEqual({ outcome: "ownership_lost" });
  });

  it("lets a cancelled run's owner still settle a tool it started", () => {
    const { storage, sql } = claimed();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    // Cancellation blocks new work; it cannot strand a child receipt the same
    // attempt has to settle before it can terminalize. That is why the
    // settlement predicate omits the cancellation fence the others carry.
    expect(storage.attemptOwnership({ ...fence, runId: RUN })).toEqual({ outcome: "cancelled" });
    expect(storage.attemptOwnership({ ...fence, runId: RUN, allowCancellationRequested: true }))
      .toEqual({ outcome: "owned" });
  });

  it("keeps a heartbeat-extended loop lease takeover-proof until it truly lapses", () => {
    const { binding, sql } = claimed();
    sql.exec(
      `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
      RUN,
    );
    const loops = new SubstreamLoopStorage(binding);
    const loopId = "heartbeat-loop";
    loops.ensureLoop({ loopId, bindStateRevision: 0, now: NOW });
    loops.activateExecutionReceipt({
      runId: RUN,
      loopId,
      executionEpoch: 1,
      leaseOwner: "owner-a",
      leaseExpiresAt: NOW + 60_000,
      expectedLoopRevision: loops.loop()!.revision,
      expectedBindStateRevision: 0,
      now: NOW,
    });

    // Mid-tool heartbeat: the executor is alive and pushes its deadline out.
    expect(loops.heartbeatExecution({
      executionId: RUN,
      executionEpoch: 1,
      leaseOwner: "owner-a",
      expectedLoopRevision: loops.loop()!.revision,
      leaseExpiresAt: NOW + 120_000,
      now: NOW + 30_000,
    }).lease_expires_at).toBe(NOW + 120_000);

    // A rival wakes after the ORIGINAL deadline. Without the heartbeat this
    // recovery would be legitimate; with it, the lease is live and the
    // takeover must be refused without disturbing the executing owner.
    const takeover = (now: number) => loops.recoverExecution({
      executionId: RUN,
      newExecutionEpoch: 2,
      leaseOwner: "owner-b",
      leaseExpiresAt: now + 60_000,
      expectedLoopRevision: loops.loop()!.revision,
      now,
    });
    expect(() => takeover(NOW + 90_000)).toThrowError("substream_loop_lease_not_expired");
    expect(loops.loop()).toMatchObject({
      status: "executing",
      lease_owner: "owner-a",
      active_execution_epoch: 1,
      lease_expires_at: NOW + 120_000,
    });
    // The identical takeover succeeds once the extended lease actually lapses,
    // so the earlier refusal is attributable to the heartbeat alone.
    expect(takeover(NOW + 121_000)).toMatchObject({
      outcome: "recovered",
      loop: { lease_owner: "owner-b", active_execution_epoch: 2 },
    });
  });
});

describe("lifecycle events", () => {
  it("records once and reports a replay", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    const event = {
      eventId: "event-1",
      runId: RUN,
      attemptId: "attempt-1",
      eventKey: "attempt:attempt-1:terminal",
      eventType: "terminal",
      status: "failed",
      memberSafePayloadJson: '{"code":"boom"}',
      now: NOW,
    };

    expect(storage.recordLifecycleEvent(event)).toEqual({ outcome: "recorded" });
    // An event key names the thing that happened once. A replay writes nothing
    // and says so, rather than reporting a write through a changes count.
    expect(storage.recordLifecycleEvent({ ...event, eventId: "event-2" }))
      .toEqual({ outcome: "replayed" });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: event.eventKey }))
      .toMatchObject({ event_id: "event-1", status: "failed" });
  });
});

describe("marking residual receipts reconciled", () => {
  const marker = "residual_receipts_settled";

  it("refuses to call a marker from another attempt this attempt's own", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN, { status: "failed" });
    sql.exec(
      `UPDATE runs SET legacy_attempt_id = 'attempt-2', terminalized_at = ? WHERE run_id = ?`,
      NOW,
      RUN,
    );
    // A superseded attempt's marker, under the same key: the key names the
    // thing that happened once per run, so nothing stops one attempt finding
    // another's.
    storage.recordLifecycleEvent({
      eventId: "event-other",
      runId: RUN,
      attemptId: "attempt-1",
      eventKey: marker,
      eventType: "receipt_reconciliation",
      status: "failed",
      memberSafePayloadJson: "{}",
      now: NOW,
    });

    // `attempt-2` holds the run, so the terminalized fence above rejects this
    // caller and the fallback decides the answer. Reporting `replayed` would
    // tell a caller its own marker exists when it does not — and that row is
    // then re-selected by every sweep while each sweep calls it settled, which
    // is a wedged repair page that never warns.
    expect(storage.recordReceiptReconciliation({
      runId: RUN,
      attemptId: "attempt-3",
      terminalizedAt: NOW - 1,
      eventKey: marker,
      eventId: "event-mine",
      now: NOW,
    })).toEqual({ outcome: "not_terminal" });
  });

  it("reports a replay to the attempt whose marker it is", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN, { status: "failed" });
    sql.exec(
      `UPDATE runs SET legacy_attempt_id = 'attempt-1', terminalized_at = ? WHERE run_id = ?`,
      NOW,
      RUN,
    );
    storage.recordLifecycleEvent({
      eventId: "event-mine",
      runId: RUN,
      attemptId: "attempt-1",
      eventKey: marker,
      eventType: "receipt_reconciliation",
      status: "failed",
      memberSafePayloadJson: "{}",
      now: NOW,
    });

    // The same attempt asking again, with a stale terminal stamp: its own
    // marker is there, so this is an honest replay rather than a lost write.
    expect(storage.recordReceiptReconciliation({
      runId: RUN,
      attemptId: "attempt-1",
      terminalizedAt: NOW - 1,
      eventKey: marker,
      eventId: "event-second",
      now: NOW,
    })).toEqual({ outcome: "replayed" });
  });
});

describe("freezing a run's scope", () => {
  const scope = {
    scopeHash: "scope-hash-1",
    executionPrincipalJson: '{"type":"user","userId":"u1"}',
    eligibleConnectionIdsJson: '["connection-read"]',
    eligibleCapabilitiesJson: '["documents.read"]',
    eligibleConnectionCapabilitiesJson: '{"connection-read":["documents.read"]}',
    triggerPolicyJson: '{"kind":"interactive"}',
    routingPolicyVersion: "routing-v1",
    promptVersion: "prompt-v1",
    toolSurfaceHash: "tools-v1",
    limitsJson: '{"maxIterations":8}',
  };

  function claimed() {
    const opened = open();
    seedRun(opened.sql, RUN);
    opened.storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-claim",
    });
    return opened;
  }

  it("freezes the scope for the attempt that holds the run", () => {
    const { storage } = claimed();

    expect(storage.persistScope({ ...fence, runId: RUN, ...scope }))
      .toEqual({ outcome: "persisted" });
    expect(storage.scope({ runId: RUN }))
      .toMatchObject({ attempt_id: "attempt-1", scope_hash: "scope-hash-1", created_at: NOW });
  });

  it("reports the same attempt's identical scope as a reuse, not a write", () => {
    const { storage } = claimed();
    storage.persistScope({ ...fence, runId: RUN, ...scope });

    // A retrying executor re-freezing what it already froze is a replay. The
    // routed version could not tell this from a lost run without a second
    // statement, because both came back as zero changes.
    expect(storage.persistScope({ ...fence, runId: RUN, ...scope }))
      .toEqual({ outcome: "reused" });
  });

  it("keeps the recorded scope when a resumed attempt recomputes a different one", () => {
    const { storage } = claimed();
    storage.persistScope({ ...fence, runId: RUN, ...scope });

    // The incident this replaced: Cloudflare resets a Durable Object on deploy,
    // so a run in flight resumes on a new bundle and recomputes a scope hash
    // that carries the new build. Refusing that killed the run and told the
    // member not to retry. The recorded scope wins and the loop restarts.
    expect(storage.persistScope({ ...fence, runId: RUN, ...scope, scopeHash: "scope-hash-2" }))
      .toEqual({ outcome: "reused" });
    expect(storage.scope({ runId: RUN })).toMatchObject({ scope_hash: "scope-hash-1" });
  });

  it("keeps the recorded scope when a later attempt takes the run over", () => {
    const { storage, sql } = claimed();
    storage.persistScope({ ...fence, runId: RUN, ...scope });

    // A restart that mints a fresh attempt id, rather than reclaiming the
    // fenced one, is the other shape of the same thing: the run's scope is
    // still the one it was admitted with, not the taker's recomputation. The
    // taker has genuinely claimed the run, so it clears the lease fence below.
    sql.exec(
      `UPDATE runs SET lease_owner = ?, legacy_attempt_id = ?, attempt_epoch = 2 WHERE run_id = ?`,
      "owner-2",
      "attempt-2",
      RUN,
    );
    expect(storage.persistScope({
      ...fence, runId: RUN, ...scope, attemptId: "attempt-2", owner: "owner-2", scopeHash: "scope-hash-2",
    })).toEqual({ outcome: "reused" });
    expect(storage.scope({ runId: RUN }))
      .toMatchObject({ attempt_id: "attempt-1", scope_hash: "scope-hash-1" });
  });

  it("refuses an executor that lost the run even though a scope is recorded", () => {
    const { storage, sql } = claimed();
    storage.persistScope({ ...fence, runId: RUN, ...scope });

    // Reusing on the row alone would answer a stale executor with success. The
    // removed hash comparison used to catch this by accident, because a stale
    // executor carries a different attempt id; the lease fence catches it on
    // purpose.
    sql.exec(
      `UPDATE runs SET lease_owner = ?, legacy_attempt_id = ? WHERE run_id = ?`,
      "owner-2",
      "attempt-2",
      RUN,
    );
    expect(storage.persistScope({ ...fence, runId: RUN, ...scope }))
      .toEqual({ outcome: "ownership_lost" });
  });

  it("refuses an attempt that no longer holds the run", () => {
    const { storage } = claimed();

    expect(storage.persistScope({ ...fence, runId: RUN, attemptId: "attempt-2", ...scope }))
      .toEqual({ outcome: "ownership_lost" });
    expect(storage.scope({ runId: RUN })).toBeUndefined();
  });

  it("refuses once the lease has lapsed", () => {
    const { storage } = claimed();

    // The `SELECT … FROM harness_runs WHERE lease_expires_at > now` that used
    // to be the INSERT's own source. Nothing is written for an attempt whose
    // lease has run out, because another executor may already have taken over.
    expect(storage.persistScope({ ...fence, runId: RUN, now: NOW + 61_000, ...scope }))
      .toEqual({ outcome: "ownership_lost" });
    expect(storage.scope({ runId: RUN })).toBeUndefined();
  });
});

describe("recording a plugin activation", () => {
  function claimed() {
    const opened = open();
    seedRun(opened.sql, RUN);
    opened.storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-claim",
    });
    return opened;
  }

  const activation = { pluginId: "linear", toolSurfaceHash: "surface-v1" };

  it("records the activation for the attempt that holds the run", () => {
    const { storage, sql } = claimed();

    expect(storage.persistPluginActivation({ ...fence, runId: RUN, ...activation }))
      .toEqual({ outcome: "persisted" });
    expect(sql.exec(
      `SELECT attempt_id, tool_surface_hash, authorized_at, activated_at
         FROM run_plugin_activations WHERE run_id = ? AND plugin_id = ?`,
      RUN,
      "linear",
    ).one()).toMatchObject({
      attempt_id: "attempt-1",
      tool_surface_hash: "surface-v1",
      authorized_at: NOW,
      activated_at: NOW,
    });
  });

  it("reports the same attempt's identical activation as a reuse", () => {
    const { storage } = claimed();
    storage.persistPluginActivation({ ...fence, runId: RUN, ...activation });

    expect(storage.persistPluginActivation({ ...fence, runId: RUN, ...activation }))
      .toEqual({ outcome: "reused" });
  });

  it("keeps the recorded activation when a resumed attempt recomputes a different surface", () => {
    const { storage, sql } = claimed();
    storage.persistPluginActivation({ ...fence, runId: RUN, ...activation });

    // The same deploy that moves a run's scope hash moves each plugin's surface
    // hash, for the same reason and out of the same tool definitions. Refusing
    // here was the second landmine on the resumption path, so fixing only
    // `persistScope` would have moved the next deploy's failure to this row.
    expect(storage.persistPluginActivation({
      ...fence, runId: RUN, ...activation, toolSurfaceHash: "surface-v2",
    })).toEqual({ outcome: "reused" });
    expect(sql.exec(
      `SELECT tool_surface_hash FROM run_plugin_activations WHERE run_id = ? AND plugin_id = ?`,
      RUN,
      "linear",
    ).one()).toMatchObject({ tool_surface_hash: "surface-v1" });
  });

  it("refuses an executor that lost the run even though the activation exists", () => {
    const { storage, sql } = claimed();
    storage.persistPluginActivation({ ...fence, runId: RUN, ...activation });

    // A stale executor told its activation is durable goes on preparing the
    // plugin against a run it no longer holds, so the lease is checked before
    // the row is.
    sql.exec(
      `UPDATE runs SET lease_owner = ?, legacy_attempt_id = ? WHERE run_id = ?`,
      "owner-2",
      "attempt-2",
      RUN,
    );
    expect(storage.persistPluginActivation({ ...fence, runId: RUN, ...activation }))
      .toEqual({ outcome: "ownership_lost" });
  });

  it("refuses an attempt that no longer holds the run", () => {
    const { storage, sql } = claimed();

    expect(storage.persistPluginActivation({
      ...fence, runId: RUN, attemptId: "attempt-2", ...activation,
    })).toEqual({ outcome: "ownership_lost" });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM run_plugin_activations WHERE run_id = ?`,
      RUN,
    ).one()).toMatchObject({ count: 0 });
  });
});

describe("sweeping a run's descendants", () => {
  const CHILD = "00000000-0000-7000-8000-0000000000a5";
  const GRANDCHILD = "00000000-0000-7000-8000-0000000000a6";

  function chain() {
    const opened = open();
    seedRun(opened.sql, RUN, { status: "running" });
    seedRun(opened.sql, CHILD, {
      status: "running", parentRunId: RUN, parentToolCallId: "call-1", chainRootRunId: RUN,
    });
    // A grandchild's parent is the child, not the root. Only `chain_root_run_id`
    // connects it to the run being stopped.
    seedRun(opened.sql, GRANDCHILD, {
      status: "running", parentRunId: CHILD, parentToolCallId: "call-2", chainRootRunId: RUN,
    });
    return opened;
  }

  it("reaches a grandchild through the chain root, not just the parent link", () => {
    const { storage, sql } = chain();

    expect(storage.cancelDescendants({ rootRunId: RUN, reason: "parent_cancelled", now: NOW }))
      .toEqual({ cancelled: 2 });
    expect(sql.exec(
      `SELECT run_id FROM runs WHERE cancellation_requested_at IS NOT NULL ORDER BY run_id`,
    ).toArray()).toEqual([{ run_id: CHILD }, { run_id: GRANDCHILD }]);
  });

  it("keeps the first cancellation's reason when a later sweep passes over", () => {
    const { storage, sql } = chain();
    sql.exec(
      `UPDATE runs SET cancellation_requested_at = ?, cancellation_reason = 'member_stop'
        WHERE run_id = ?`,
      NOW - 5_000,
      CHILD,
    );

    storage.cancelDescendants({ rootRunId: RUN, reason: "parent_cancelled", now: NOW });

    // A member stopped this one, and then its parent's terminalization swept
    // over it. The reason a person will be shown is the member's, not the
    // sweep's — which is what the two `COALESCE`s are for.
    expect(sql.exec(
      `SELECT cancellation_reason, cancellation_requested_at FROM runs WHERE run_id = ?`,
      CHILD,
    ).one()).toMatchObject({
      cancellation_reason: "member_stop",
      cancellation_requested_at: NOW - 5_000,
    });
  });

  it("leaves a run that already finished alone", () => {
    const { storage, sql } = chain();
    sql.exec(
      `UPDATE runs SET status = 'completed', terminalized_at = ? WHERE run_id = ?`,
      NOW - 1_000,
      GRANDCHILD,
    );

    expect(storage.cancelDescendants({ rootRunId: RUN, reason: "parent_cancelled", now: NOW }))
      .toEqual({ cancelled: 1 });
  });

  it("does not sweep a root run that merely records this one as its chain root", () => {
    const { storage, sql } = chain();
    sql.exec(`UPDATE runs SET parent_tool_call_id = NULL WHERE run_id = ?`, GRANDCHILD);

    // `parent_tool_call_id IS NOT NULL` again: a chained run that is not a
    // delegated sub-agent has its own lifecycle and is not the parent's to stop.
    expect(storage.cancelDescendants({ rootRunId: RUN, reason: "parent_cancelled", now: NOW }))
      .toEqual({ cancelled: 1 });
  });
});

describe("ending a run that was never claimed", () => {
  const queued = {
    runId: RUN,
    attemptId: "attempt-queued",
    status: "failed" as const,
    errorJson: '{"code":"never_started"}',
    memberSafePayloadJson: '{"code":"never_started"}',
    lifecycleEventId: "event-queued",
    loopExecutionFence: null,
    now: NOW,
  };

  it("stamps an attempt so the ending has an owner", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    seedRun(sql, OTHER, {
      parentRunId: RUN,
      parentToolCallId: "tool-child",
      chainRootRunId: RUN,
    });
    seedTransientCheckpoints(sql, RUN, queued.attemptId, 0);

    expect(storage.terminalizeQueuedRun(queued)).toEqual({ outcome: "terminalized" });
    expect(sql.exec(
      `SELECT status, legacy_attempt_id, terminalized_at, error_json FROM runs WHERE run_id = ?`,
      RUN,
    ).one()).toMatchObject({
      status: "failed",
      legacy_attempt_id: "attempt-queued",
      terminalized_at: NOW,
      error_json: '{"code":"never_started"}',
    });
    expect(sql.exec(`SELECT exact_state FROM workstream WHERE id = 1`).one())
      .toMatchObject({ exact_state: "failed" });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "terminal" }))
      .toMatchObject({ attempt_id: queued.attemptId, status: "failed" });
    expectNoTransientCheckpoints(sql, RUN);
    expect(storage.run({ runId: OTHER })).toMatchObject({
      cancellation_reason: "parent_terminalized",
      cancellation_requested_at: NOW,
    });
  });

  it("requires and releases the exact loop execution before ending a linked queued run", () => {
    const { binding, storage, sql } = open();
    seedRun(sql, RUN);
    sql.exec(
      `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
      RUN,
    );
    const loops = new SubstreamLoopStorage(binding);
    loops.ensureLoop({ loopId: RUN, bindStateRevision: 0, now: NOW });
    loops.activateExecutionReceipt({
      runId: RUN,
      loopId: RUN,
      executionEpoch: 1,
      leaseOwner: "loop-owner",
      leaseExpiresAt: NOW + 60_000,
      expectedLoopRevision: loops.loop()!.revision,
      expectedBindStateRevision: 0,
      now: NOW,
    });
    const loopExecutionFence = {
      loopId: RUN,
      executionId: RUN,
      executionEpoch: 1,
      leaseOwner: "loop-owner",
    };
    const stopped = {
      ...queued,
      status: "cancelled" as const,
      errorJson: null,
    };

    expect(storage.terminalizeQueuedRun(stopped)).toEqual({ outcome: "ownership_lost" });
    expect(storage.run({ runId: RUN })).toMatchObject({
      status: "running",
      terminalized_at: null,
    });
    expect(loops.loop()).toMatchObject({ status: "executing", active_execution_id: RUN });

    sql.exec(`UPDATE substream_loops SET lease_expires_at = ? WHERE id = 1`, NOW);
    expect(storage.terminalizeQueuedRun({ ...stopped, loopExecutionFence }))
      .toEqual({ outcome: "ownership_lost" });
    expect(storage.run({ runId: RUN })).toMatchObject({
      status: "running",
      terminalized_at: null,
    });

    sql.exec(`UPDATE substream_loops SET lease_expires_at = ? WHERE id = 1`, NOW + 60_000);
    expect(storage.terminalizeQueuedRun({ ...stopped, loopExecutionFence }))
      .toEqual({ outcome: "terminalized" });
    expect(storage.run({ runId: RUN })).toMatchObject({
      status: "cancelled",
      terminalized_at: NOW,
    });
    expect(loops.loop()).toMatchObject({
      status: "idle",
      active_execution_id: null,
      lease_owner: null,
    });
    expect(storage.terminalizeQueuedRun({
      ...stopped,
      loopExecutionFence,
      lifecycleEventId: "event-queued-replay",
    })).toEqual({ outcome: "already_terminal" });
  });

  it("refuses a run an executor has already claimed", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-claim" });

    // This path exists for a run whose executor never arrived. A run that *is*
    // being worked on has an attempt, and ending it from here would terminalize
    // it out from under a live owner that still holds the lease.
    expect(storage.terminalizeQueuedRun(queued)).toEqual({ outcome: "ownership_lost" });
    expect(sql.exec(`SELECT status, terminalized_at FROM runs WHERE run_id = ?`, RUN).one())
      .toMatchObject({ status: "running", terminalized_at: null });
  });

  it("replays the same ending rather than writing it twice", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    storage.terminalizeQueuedRun(queued);

    expect(storage.terminalizeQueuedRun({ ...queued, lifecycleEventId: "event-2" }))
      .toEqual({ outcome: "already_terminal" });
  });
});

describe("admitting a root run", () => {
  const base = {
    origin: "slack_workspace_message",
    executionPrincipalJson: '{"type":"workspace"}',
    status: "running" as const,
    startedAt: NOW,
    model: null,
    triggerPartId: null,
    parentRunId: null,
    expectedLatestRunId: null,
  };

  it("creates an execution receipt and projects the work stream as running", () => {
    const { storage, sql } = open();

    expect(storage.admitRun({ ...base, runId: RUN, now: NOW }))
      .toEqual({ outcome: "admitted" });
    expect(sql.exec(`SELECT substream_id, status, origin FROM runs WHERE run_id = ?`, RUN).one())
      .toMatchObject({ substream_id: "0", status: "running", origin: "slack_workspace_message" });
    expect(sql.exec(`SELECT exact_state FROM workstream WHERE id = 1`).one())
      .toMatchObject({ exact_state: "running" });
  });

  it("admits another receipt without cancelling the execution already owned by the loop", () => {
    const { storage, sql } = open();
    storage.admitRun({ ...base, runId: RUN, now: NOW });

    expect(storage.admitRun({
      ...base, runId: OTHER, now: NOW + 1_000,
    })).toEqual({ outcome: "admitted" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs`).one()).toEqual({ count: 2 });
    expect(sql.exec(
      `SELECT cancellation_requested_at, cancellation_reason FROM runs WHERE run_id = ?`,
      RUN,
    ).one()).toMatchObject({
      cancellation_requested_at: null,
      cancellation_reason: null,
    });
  });

  it("refuses when the caller's view of the newest run is out of date", () => {
    const { storage, sql } = open();
    seedRun(sql, OTHER);

    expect(storage.admitRun({
      ...base, runId: RUN,
      expectedLatestRunId: "00000000-0000-7000-8000-00000000ffff", now: NOW,
    })).toEqual({ outcome: "stale" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs WHERE run_id = ?`, RUN).one())
      .toEqual({ count: 0 });
  });

  it("reports a repeated id as an existing run rather than creating a second", () => {
    const { storage } = open();
    storage.admitRun({ ...base, runId: RUN, now: NOW });

    expect(storage.admitRun({ ...base, runId: RUN, now: NOW + 1_000 }))
      .toEqual({ outcome: "exists" });
  });

  it("rejects retired per-run phase states at the active write boundary", () => {
    const { storage } = open();

    expect(() => storage.admitRun({
      ...base, runId: RUN, status: "waiting", now: NOW,
    } as never)).toThrow("admitted_run_status_invalid");
    expect(() => storage.admitRun({
      ...base, runId: RUN, status: "steering", now: NOW,
    } as never)).toThrow("admitted_run_status_invalid");
  });
});

describe("typed run and telemetry reads", () => {
  it("finds only a live root receipt from the requested producer family", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN, { origin: "automation", startedAt: NOW });
    seedRun(sql, OTHER, { origin: "member_message", startedAt: NOW + 1 });

    expect(storage.latestActiveRootRun({ origin: "automation" })?.run_id).toBe(RUN);
    sql.exec(`UPDATE runs SET status = 'completed', completed_at = ?, terminalized_at = ?
      WHERE run_id = ?`, NOW + 2, NOW + 2, RUN);
    expect(storage.latestActiveRootRun({ origin: "automation" })).toBeUndefined();
  });

  it("assembles terminal telemetry from normalized run, inference, and receipt rows", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN, { origin: "member_message", startedAt: NOW });
    sql.exec(
      `UPDATE runs SET status = 'completed', completed_at = ?, terminalized_at = ?,
          model = 'provider/model', usage_json = '{"run_stats":{"turns":2}}'
        WHERE run_id = ?`,
      NOW + 10_000,
      NOW + 10_000,
      RUN,
    );
    storage.recordInferenceAttempt({
      inferenceAttemptId: "inference-telemetry",
      runId: RUN,
      attemptId: "attempt-telemetry",
      turnId: "turn-telemetry",
      endpointAttempt: 1,
      fallbackAttempt: 1,
      provider: "provider",
      model: "provider/model",
      credentialSourceHash: null,
      workspaceIdentityHash: "workspace-hash",
      routingDecisionJson: "{}",
      outcome: "success",
      failureClassification: null,
      latencyMs: 1_000,
      ttftMs: 250,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 0,
      cachedTokens: 0,
      costMicros: 1,
      responseBytes: 20,
      startedAt: NOW + 500,
      completedAt: NOW + 1_500,
      now: NOW + 1_500,
    });
    sql.exec(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          input_json, execution_plan_json, started_at, settled_at)
       VALUES ('effect-telemetry', ?, 1, 0, 'occurrence-telemetry', 'create_issue',
               'write', 'request-hash', 'test', 'completed', 'call-telemetry', '{}',
               '{"pluginId":"linear","canonicalToolName":"create_issue","capability":"linear.issue.create","mode":"write"}',
               ?, ?)`,
      RUN,
      NOW + 2_000,
      NOW + 3_000,
    );

    expect(storage.runOutcomeTelemetry({ runId: RUN })).toMatchObject({
      status: "completed",
      model: "provider/model",
      first_inference_started_at: NOW + 500,
      first_ttft_ms: 250,
      turn_count: 1,
      tool_call_count: 1,
      write_tool_call_count: 1,
      fallback_used: 1,
    });
    expect(storage.toolTerminalTelemetry({
      runId: RUN,
      effectIntentId: "effect-telemetry",
    })).toMatchObject({
      effect_intent_id: "effect-telemetry",
      run_id: RUN,
      status: "completed",
      origin: "member_message",
    });
    expect(storage.toolTerminalTelemetry({
      runId: OTHER,
      effectIntentId: "effect-telemetry",
    })).toBeUndefined();
  });

  it("seeds development receipts idempotently and rejects retired phase states", () => {
    const { storage, sql } = open();
    const input = {
      runId: RUN,
      origin: "message",
      executionPrincipalJson: "{}",
      status: "completed" as const,
      startedAt: NOW,
      completedAt: NOW + 1,
      terminalizedAt: NOW + 1,
      createdAt: NOW,
    };

    expect(storage.seedDevelopmentRun(input)).toEqual({ outcome: "inserted" });
    expect(storage.seedDevelopmentRun(input)).toEqual({ outcome: "exists" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs WHERE run_id = ?`, RUN).one())
      .toEqual({ count: 1 });
    expect(() => storage.seedDevelopmentRun({
      ...input, runId: OTHER, status: "steering",
    } as never)).toThrow("persisted_run_status_invalid");
  });
});

describe("publishing a run's final turn", () => {
  const publish = {
    finalTurn: { turnId: `${RUN}:turn:1`, text: "Here is what I found." },
    participantNotice: null,
    hostOutcomeStatus: "completed" as const,
    hostOutcomeError: null,
    lifecycleEventId: "event-final",
    allowCancellationRequested: false,
  };

  function claimed() {
    const opened = open();
    seedRun(opened.sql, RUN);
    opened.storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-claim",
    });
    return opened;
  }

  async function commitFinalBindTurn(binding: DurableObjectStorage): Promise<void> {
    const transcript = new WorkstreamTranscriptStorage(binding);
    const loop = new SubstreamLoopStorage(binding);
    const initialized: BindLoopTransition = {
      kind: "state_initialized",
      loopId: RUN,
      generation: 1,
      stateRevision: 1,
      systemProjection: {
        revision: 1,
        rendererVersion: "final-turn-test-v1",
        inputHash: "input-1",
        message: { role: "system", content: "System" },
      },
      nonSystemMessages: [{ role: "user", content: "Question" }],
      nonSystemMessageOrigins: [{
        originKind: "derived",
        sourceKind: "participant_turn",
        sourceId: "question-1",
        sourceRevision: 1,
      }],
    };
    await transcript.commitBindTransition(initialized, NOW);
    loop.ensureLoop({ loopId: RUN, bindStateRevision: 1, now: NOW });
    binding.sql.exec(
      `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
      RUN,
    );
    loop.activateExecutionReceipt({
      runId: RUN,
      loopId: RUN,
      executionEpoch: 1,
      leaseOwner: fence.owner,
      leaseExpiresAt: NOW + 60_000,
      expectedLoopRevision: loop.loop()!.revision,
      expectedBindStateRevision: 1,
      now: NOW,
    });
    const reservation = loop.reserveAssistantTurn({
      executionId: RUN,
      executionEpoch: 1,
      leaseOwner: fence.owner,
      expectedLoopRevision: loop.loop()!.revision,
      receiptRunId: RUN,
      turnId: publish.finalTurn.turnId,
      modelTurnIndex: 1,
      streamId: "final-turn-test-stream",
      now: NOW,
    });
    if (reservation.outcome !== "reserved") throw new Error("test_assistant_turn_not_reserved");
    await transcript.commitBindTransition({
      kind: "assistant_reserved",
      loopId: RUN,
      generation: 1,
      stateRevision: 2,
      turnId: publish.finalTurn.turnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
    }, NOW, {
      executionId: RUN,
      executionEpoch: 1,
      leaseOwner: fence.owner,
      expectedBindStateRevision: 1,
    });
    await transcript.commitBindTransition({
      kind: "assistant_accepted",
      loopId: RUN,
      generation: 1,
      stateRevision: 3,
      turnId: publish.finalTurn.turnId,
      modelTurnIndex: 1,
      transcriptSequence: reservation.reservation.transcript_sequence,
      message: { role: "assistant", content: publish.finalTurn.text },
    }, NOW + 1, {
      executionId: RUN,
      executionEpoch: 1,
      leaseOwner: fence.owner,
      expectedBindStateRevision: 2,
    });
    const current = loop.loop();
    if (!current) throw new Error("test_substream_loop_not_found");
    const settled = await transcript.settlePendingSteersAtStep({
      loopId: RUN,
      executionId: RUN,
      executionEpoch: 1,
      leaseOwner: fence.owner,
      expectedLoopRevision: current.revision,
      expectedStepOrdinal: 0,
      expectedBindGeneration: 1,
      expectedBindStateRevision: 3,
      assistantTurnId: publish.finalTurn.turnId,
      modelTurnIndex: 1,
      enqueueRegionalEffectsInTransaction: () => undefined,
      now: NOW + 2,
    });
    expect(settled).toMatchObject({
      transitions: [],
      removedInputIds: [],
      stop: false,
      loop: { status: "executing", bind_state_revision: 3, step_ordinal: 1 },
    });
  }

  it("adopts the Bind assistant turn instead of copying its text", async () => {
    const { binding, storage, sql } = claimed();
    await commitFinalBindTurn(binding);

    expect(sql.exec(
      `SELECT status, terminalized_at FROM runs WHERE run_id = ?`, RUN,
    ).one()).toEqual({ status: "running", terminalized_at: null });

    expect(await storage.publishHostOutcome({ ...fence, runId: RUN, ...publish }))
      .toEqual({
        outcome: "published",
        finalTurnSequenceNumber: 1,
        participantNoticeSequenceNumber: null,
      });
    expect(sql.exec(
      `SELECT turn_id, attention_ordinal FROM participant_transcript_turns
        WHERE actor = 'assistant' ORDER BY transcript_sequence`,
    ).toArray()).toEqual([{ turn_id: publish.finalTurn.turnId, attention_ordinal: 1 }]);
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM transcript_payloads
        WHERE payload_json LIKE '%Here is what I found.%'`,
    ).one()).toEqual({ count: 1 });
    expect(sql.exec(
      `SELECT COUNT(*) AS count
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
        WHERE fact.run_id = ?`,
      RUN,
    ).one()).toEqual({ count: 1 });
  });

  it("fails closed with a payload-free diagnostic when final-turn identity diverges", async () => {
    const { binding, storage } = claimed();
    await commitFinalBindTurn(binding);

    await expect(storage.publishHostOutcome({
      ...fence,
      runId: RUN,
      ...publish,
      finalTurn: {
        ...publish.finalTurn,
        text: "Different final bytes that must not replace the accepted turn.",
      },
    })).resolves.toEqual({ outcome: "content_mismatch", reasons: ["content"] });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "host_outcome" })).toBeUndefined();
  });

  it("finalizes one canonical assistant turn and records that it did, in one transaction", async () => {
    const { storage, sql } = claimed();

    expect(await storage.publishHostOutcome({ ...fence, runId: RUN, ...publish }))
      .toEqual({
        outcome: "published",
        finalTurnSequenceNumber: 1,
        participantNoticeSequenceNumber: null,
      });
    expect(sql.exec(
      `SELECT turn.turn_id, turn.actor, payload.payload_json
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE turn.turn_id = ?`,
      publish.finalTurn.turnId,
    ).one()).toMatchObject({
      turn_id: publish.finalTurn.turnId,
      actor: "assistant",
      payload_json: '{"content":"Here is what I found.","role":"assistant","structuredContent":null}',
    });
    expect(sql.exec(
      `SELECT COUNT(*) AS count
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
        WHERE fact.run_id = ? AND turn.turn_id != ?`,
      RUN,
      publish.finalTurn.turnId,
    ).one()).toEqual({ count: 0 });
    // The lifecycle event is what every later reader joins against. The routed
    // version wrote it as a second statement that re-read `messages` to check
    // the first had landed.
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "host_outcome" }))
      .toMatchObject({ event_type: "host_outcome_persisted", status: "completed" });
  });

  it("moves the transcript counters the append consumed", async () => {
    const { storage, sql } = claimed();

    await storage.publishHostOutcome({ ...fence, runId: RUN, ...publish });

    // Finalization consumes attention, but the already-ordered turn does not
    // consume the legacy message sequence used by routed compatibility rows.
    expect(sql.exec(
      `SELECT next_sequence_number, next_attention_ordinal, last_people_activity_at
         FROM workstream WHERE id = 1`,
    ).one()).toMatchObject({
      next_sequence_number: 1,
      next_attention_ordinal: 2,
      last_people_activity_at: NOW,
    });
  });

  it("refuses an attempt that no longer holds the run", async () => {
    const { storage, sql } = claimed();

    expect(await storage.publishHostOutcome({
      ...fence, runId: RUN, owner: "someone-else", ...publish,
    })).toEqual({ outcome: "ownership_lost" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`, publish.finalTurn.turnId).one())
      .toEqual({ count: 0 });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "host_outcome" })).toBeUndefined();
  });

  it("refuses an ordinary publish once cancellation was requested", async () => {
    const { storage, sql } = claimed();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    // A run asked to stop must not go on to report a completed answer.
    expect(await storage.publishHostOutcome({ ...fence, runId: RUN, ...publish }))
      .toEqual({ outcome: "ownership_lost" });
  });

  it("lets a stopped run publish what it had already written", async () => {
    const { storage, sql } = claimed();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    // The member asked it to stop, not to vanish: whatever the model had
    // produced by then is still theirs to read. Same exemption, and the same
    // reason, as `assertHarnessToolSettlementOwned`.
    expect(await storage.publishHostOutcome({
      ...fence, runId: RUN, ...publish,
      hostOutcomeStatus: "stopped", allowCancellationRequested: true,
    })).toMatchObject({ outcome: "published" });
  });

  it("replays rather than writing a second assistant turn for the same run", async () => {
    const { storage, sql } = claimed();
    await storage.publishHostOutcome({ ...fence, runId: RUN, ...publish });

    expect(await storage.publishHostOutcome({
      ...fence, runId: RUN, ...publish,
      lifecycleEventId: "event-final-2",
    })).toEqual({
      outcome: "replayed",
      finalTurnSequenceNumber: 1,
      participantNoticeSequenceNumber: null,
    });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE actor = 'assistant'`).one())
      .toEqual({ count: 1 });
  });

  it("atomically publishes an accepted final turn and a separately-provenanced host notice", async () => {
    const { storage, sql } = claimed();
    const notice = {
      turnId: `${RUN}:attachment-boundary`,
      text: "Attachment content could not be verified.",
    };

    await expect(storage.publishHostOutcome({
      ...fence,
      runId: RUN,
      ...publish,
      participantNotice: notice,
    })).resolves.toEqual({
      outcome: "published",
      finalTurnSequenceNumber: 1,
      participantNoticeSequenceNumber: 2,
    });
    expect(sql.exec(
      `SELECT turn_id, actor, message_type, transcript_sequence
         FROM participant_transcript_turns ORDER BY transcript_sequence`,
    ).toArray()).toEqual([
      {
        turn_id: publish.finalTurn.turnId,
        actor: "assistant",
        message_type: "text",
        transcript_sequence: 1,
      },
      {
        turn_id: notice.turnId,
        actor: "system",
        message_type: "system",
        transcript_sequence: 2,
      },
    ]);
  });

  it("checkpoints a failed host outcome even when it has no assistant turn", async () => {
    const { storage, sql } = claimed();

    await expect(storage.publishHostOutcome({
      ...fence,
      runId: RUN,
      finalTurn: null,
      participantNotice: null,
      hostOutcomeStatus: "failed",
      hostOutcomeError: null,
      lifecycleEventId: "event-host-failure",
      allowCancellationRequested: false,
    })).resolves.toEqual({
      outcome: "published",
      finalTurnSequenceNumber: null,
      participantNoticeSequenceNumber: null,
    });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
    ).one()).toEqual({ count: 0 });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "host_outcome" }))
      .toMatchObject({ event_type: "host_outcome_persisted", status: "failed" });
  });

  it("checkpoints a completion a tool ended, which has no assistant turn to point at", async () => {
    const { storage } = claimed();

    // A ready draft submitted from an automation's chat ends the run from the
    // tool, and the model is not asked for a closing message. Refusing the
    // checkpoint here left the run un-terminalized with an error, after the
    // tool's effect had already landed.
    await expect(storage.publishHostOutcome({
      ...fence,
      runId: RUN,
      ...publish,
      finalTurn: null,
    })).resolves.toEqual({
      outcome: "published",
      finalTurnSequenceNumber: null,
      participantNoticeSequenceNumber: null,
    });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "host_outcome" }))
      .toMatchObject({ event_type: "host_outcome_persisted", status: "completed" });
  });

  it("refuses a conflicting participant notice before writing a final turn or lifecycle event", async () => {
    const { binding, storage, sql } = claimed();
    const messages = new WorkstreamMessageStorage(binding);
    await messages.appendMessage({
      messageId: "different-notice-turn",
      clientMessageId: `${RUN}:attachment-boundary`,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      text: "Different notice bytes",
      structuredContentJson: null,
      producedByRunId: RUN,
      now: NOW - 1,
    });

    await expect(storage.publishHostOutcome({
      ...fence,
      runId: RUN,
      ...publish,
      participantNotice: {
        turnId: `${RUN}:attachment-boundary`,
        text: "Attachment content could not be verified.",
      },
    })).resolves.toEqual({ outcome: "content_mismatch", reasons: ["notice"] });
    expect(sql.exec(
      `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE actor = 'assistant'`,
    ).one()).toEqual({ count: 0 });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "host_outcome" })).toBeUndefined();
  });
});
