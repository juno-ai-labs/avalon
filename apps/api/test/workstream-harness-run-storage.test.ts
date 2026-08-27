import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import {
  expireLocalAttemptLeasesFromPreviousInstance,
  PREVIOUS_INSTANCE_RECOVERY_OWNER_PREFIX,
  previousInstanceRecoveryOwner,
  WorkstreamHarnessRunStorage,
} from "../src/durable-objects/workstream-harness-run-storage";
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
  // does not collide with its running parent under `runs_mutating_substream_uq`.
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

  it("does not expire a HyperSight attempt owned by another agent object", () => {
    const { binding, storage, sql } = open();
    seedRun(sql, RUN, { origin: "block_dashboard_block" });
    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 300, lifecycleEventId: "event-1" });

    expect(expireLocalAttemptLeasesFromPreviousInstance(binding, NOW + 1_000)).toEqual([]);
    expect(sql.exec(`SELECT lease_owner, lease_expires_at FROM runs WHERE run_id = ?`, RUN).one())
      .toMatchObject({ lease_owner: "owner-1", lease_expires_at: NOW + 300_000 });
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
      finalPartId: null,
      model: null,
      usageJson: null,
      errorJson: null,
      memberSafePayloadJson: '{"code":"run_cancelled"}',
      lifecycleEventId: "event-terminal",
      receiptMarkerEventKey: "residual_receipts_settled",
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

  it("leaves the work stream alone when a HyperSight block claims", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN, { origin: "block_dashboard_block" });

    storage.claimAttempt({ ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-1" });

    // A block run is beside the conversation rather than holding it, so the
    // sidebar must not report the work stream busy on its account.
    expect(sql.exec(`SELECT exact_state FROM workstream WHERE id = 1`).one())
      .toMatchObject({ exact_state: "idle" });
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

  it("lets a HyperSight block claim beside a live interactive run", () => {
    const { storage, sql } = open();
    seedRun(sql, OTHER);
    seedRun(sql, RUN, { origin: "block_dashboard_block" });
    storage.claimAttempt({
      ...fence, runId: OTHER, leaseSeconds: 60, lifecycleEventId: "event-other",
    });

    // Each block owns its own run. The single-mutating-run rule is about the
    // member's conversation, not about every run in the work stream.
    expect(storage.claimAttempt({
      ...fence, runId: RUN, attemptId: "attempt-2", leaseSeconds: 60, lifecycleEventId: "event-1",
    })).toMatchObject({ outcome: "claimed" });
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
    memoryContextHash: null,
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

  it("refuses a second, different scope on the same run", () => {
    const { storage } = claimed();
    storage.persistScope({ ...fence, runId: RUN, ...scope });

    // The scope is immutable for the life of the run: what the model was
    // allowed to reach cannot be renegotiated after it started reaching. This
    // is a caller defect rather than a race, which is why it is its own answer.
    expect(storage.persistScope({ ...fence, runId: RUN, ...scope, scopeHash: "scope-hash-2" }))
      .toEqual({ outcome: "mismatch" });
    expect(storage.scope({ runId: RUN })).toMatchObject({ scope_hash: "scope-hash-1" });
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

  it("refuses an activation whose tool surface has changed", () => {
    const { storage } = claimed();
    storage.persistPluginActivation({ ...fence, runId: RUN, ...activation });

    // The surface hash is part of the frozen scope. A second activation naming
    // a different one means the tools moved under a run that was promised they
    // would not, so it is refused rather than recorded over.
    expect(storage.persistPluginActivation({
      ...fence, runId: RUN, ...activation, toolSurfaceHash: "surface-v2",
    })).toEqual({ outcome: "mismatch" });
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

describe("the inline child's double fence", () => {
  const CHILD = "00000000-0000-7000-8000-0000000000a3";

  const childFence = {
    parentRunId: RUN,
    parentAttemptId: "attempt-1",
    parentOwner: "owner-1",
    childRunId: CHILD,
    childAttemptId: "attempt-child",
    childOwner: "owner-child",
    now: NOW,
  };

  function delegated() {
    const opened = open();
    seedRun(opened.sql, RUN);
    seedRun(opened.sql, CHILD, { parentRunId: RUN, parentToolCallId: "call-1" });
    opened.storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-parent",
    });
    // A child run is claimed directly: `claimAttempt` refuses anything with a
    // parent tool call, because a sub-agent's lease is granted by its parent
    // rather than taken from the work stream.
    opened.sql.exec(
      `UPDATE runs SET status = 'running', legacy_attempt_id = ?, lease_owner = ?,
              lease_expires_at = ? WHERE run_id = ?`,
      "attempt-child",
      "owner-child",
      NOW + 60_000,
      CHILD,
    );
    return opened;
  }

  it("holds while both leases are live", () => {
    const { storage } = delegated();

    expect(storage.inlineChildOwnership(childFence)).toEqual({ outcome: "owned" });
  });

  it("refuses a child whose parent's lease has lapsed", () => {
    const { storage, sql } = delegated();
    sql.exec(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`, NOW - 1, RUN);

    // The whole point of the double fence: a sub-agent must not outlive the
    // run that delegated to it, even while its own lease is still good.
    expect(storage.inlineChildOwnership(childFence)).toEqual({ outcome: "ownership_lost" });
  });

  it("reports a parent's stop to the child", () => {
    const { storage, sql } = delegated();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    expect(storage.inlineChildOwnership(childFence)).toEqual({ outcome: "cancelled" });
  });

  it("calls a lost lease lost even when the other side was also stopped", () => {
    const { storage, sql } = delegated();
    sql.exec(
      `UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`,
      NOW,
      RUN,
    );
    sql.exec(`UPDATE runs SET lease_owner = 'someone-else' WHERE run_id = ?`, CHILD);

    // Precedence, and it is load-bearing: a caller that no longer owns the run
    // has not observed the cancellation — it is reading a row someone else now
    // controls, so it must be told it lost the run rather than told to settle.
    expect(storage.inlineChildOwnership(childFence)).toEqual({ outcome: "ownership_lost" });
  });

  it("refuses a run that is not this parent's child", () => {
    const { storage, sql } = delegated();
    sql.exec(`UPDATE runs SET parent_run_id = NULL WHERE run_id = ?`, CHILD);

    expect(storage.inlineChildOwnership(childFence)).toEqual({ outcome: "ownership_lost" });
  });

  it("refuses a root run wearing the child's lease", () => {
    const { storage, sql } = delegated();
    sql.exec(`UPDATE runs SET parent_tool_call_id = NULL WHERE run_id = ?`, CHILD);

    // `parent_tool_call_id IS NOT NULL` is what distinguishes a delegated
    // sub-agent from a chained run that merely records its parent. Only the
    // former may be fenced by someone else's lease.
    expect(storage.inlineChildOwnership(childFence)).toEqual({ outcome: "ownership_lost" });
  });
});

describe("settling a sub-agent", () => {
  const CHILD = "00000000-0000-7000-8000-0000000000a4";

  const settlement = {
    parentRunId: RUN,
    parentAttemptId: "attempt-1",
    parentOwner: "owner-1",
    childRunId: CHILD,
    childAttemptId: "attempt-child",
    childOwner: "owner-child",
    status: "completed",
    model: "a-model",
    usageJson: '{"inputTokens":1}',
    errorJson: null,
    childResultJson: '{"status":"completed"}',
    childResultHash: "result-hash-1",
    memberSafePayloadJson: "{}",
    lifecycleEventId: "event-terminal",
    now: NOW,
  };

  function delegated() {
    const opened = open();
    seedRun(opened.sql, RUN);
    seedRun(opened.sql, CHILD, { parentRunId: RUN, parentToolCallId: "call-1" });
    opened.storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-parent",
    });
    opened.sql.exec(
      `UPDATE runs SET status = 'running', legacy_attempt_id = ?, lease_owner = ?,
              lease_expires_at = ? WHERE run_id = ?`,
      "attempt-child",
      "owner-child",
      NOW + 60_000,
      CHILD,
    );
    return opened;
  }

  it("stores the result and releases the child's lease", () => {
    const { storage, sql } = delegated();

    expect(storage.terminalizeInlineChild(settlement)).toEqual({ outcome: "terminalized" });
    expect(sql.exec(
      `SELECT status, terminalized_at, child_result_hash, lease_owner, lease_expires_at, model
         FROM runs WHERE run_id = ?`,
      CHILD,
    ).one()).toMatchObject({
      status: "completed",
      terminalized_at: NOW,
      child_result_hash: "result-hash-1",
      lease_owner: null,
      lease_expires_at: null,
      model: "a-model",
    });
    // The lifecycle event and the settlement are one transaction. The routed
    // version wrote them as a batch whose second statement asked, through an
    // `EXISTS` on the first's row, whether the first had landed.
    expect(storage.lifecycleEvent({ runId: CHILD, eventKey: "terminal" }))
      .toMatchObject({ event_type: "terminal", status: "completed" });
  });

  it("refuses a child whose parent's lease was taken by someone else", () => {
    const { storage, sql } = delegated();
    sql.exec(`UPDATE runs SET lease_owner = 'someone-else' WHERE run_id = ?`, RUN);

    // The settlement is the parent's read of its sub-agent's answer. A parent
    // that has lost its own attempt is no longer the one waiting for it, and
    // letting the settlement through would hand a result to an executor that
    // has been fenced out.
    expect(storage.terminalizeInlineChild(settlement)).toEqual({ outcome: "ownership_lost" });
    expect(sql.exec(`SELECT terminalized_at FROM runs WHERE run_id = ?`, CHILD).one())
      .toMatchObject({ terminalized_at: null });
  });

  it("lets a stopped child settle through a requested cancellation", () => {
    const { storage, sql } = delegated();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, CHILD);

    // A stop is exactly when a live owner must still be able to settle: the
    // parent is waiting on this child's result, and refusing the write because
    // the child was asked to stop leaves it waiting forever.
    expect(storage.terminalizeInlineChild({ ...settlement, status: "cancelled" }))
      .toEqual({ outcome: "terminalized" });
  });

  it("still refuses an ordinary settlement once cancellation was requested", () => {
    const { storage, sql } = delegated();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, CHILD);

    // The exemption above is only for the stop itself. A child that was asked
    // to stop must not report success as though nothing had happened.
    expect(storage.terminalizeInlineChild(settlement)).toEqual({ outcome: "ownership_lost" });
  });

  it("replays an identical settlement instead of writing twice", () => {
    const { storage } = delegated();
    storage.terminalizeInlineChild(settlement);

    expect(storage.terminalizeInlineChild({ ...settlement, lifecycleEventId: "event-2" }))
      .toEqual({ outcome: "already_terminal" });
  });

  it("refuses a settlement that disagrees with the stored result", () => {
    const { storage } = delegated();
    storage.terminalizeInlineChild(settlement);

    // A second settlement carrying a different result is not a replay: the
    // stored answer is what the parent already read, and it is immutable.
    expect(storage.terminalizeInlineChild({
      ...settlement, childResultHash: "result-hash-2", lifecycleEventId: "event-2",
    })).toEqual({ outcome: "ownership_lost" });
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
    status: "failed",
    errorJson: '{"code":"never_started"}',
    memberSafePayloadJson: '{"code":"never_started"}',
    lifecycleEventId: "event-queued",
    now: NOW,
  };

  it("stamps an attempt so the ending has an owner", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);

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

describe("a run's frozen memory recall", () => {
  const recall = {
    memoryScopeIdsJson: '["scope-1"]',
    queryText: "the first attempt's query",
    retrievalMode: "hybrid",
    resultsJson: '[{"memoryItemId":"m1"}]',
    memoryContextHash: "recall-hash-1",
  };

  function claimed() {
    const opened = open();
    seedRun(opened.sql, RUN);
    opened.storage.claimAttempt({
      ...fence, runId: RUN, leaseSeconds: 60, lifecycleEventId: "event-claim",
    });
    return opened;
  }

  it("hands a later attempt the recall the run already froze", () => {
    const { storage, sql } = claimed();
    storage.persistMemoryContext({ ...fence, runId: RUN, ...recall });
    // A second attempt takes over the same run.
    sql.exec(
      `UPDATE runs SET legacy_attempt_id = ?, lease_owner = ? WHERE run_id = ?`,
      "attempt-2", "owner-2", RUN,
    );
    const second = { ...fence, runId: RUN, attemptId: "attempt-2", owner: "owner-2" };

    // The row is PRIMARY KEY (run_id), so there is no per-attempt row to find.
    // Filtering this read by attempt id made a retry miss the fast path, pay a
    // vector search, and then discard it for this very row.
    expect(storage.memoryContext(second)).toMatchObject({
      attempt_id: "attempt-1",
      memory_context_hash: "recall-hash-1",
    });
    expect(storage.persistMemoryContext({ ...second, ...recall, memoryContextHash: "recall-hash-2" }))
      .toMatchObject({ outcome: "reused", row: { memory_context_hash: "recall-hash-1" } });
  });

  it("tells a caller that no longer holds the run nothing at all", () => {
    const { storage } = claimed();
    storage.persistMemoryContext({ ...fence, runId: RUN, ...recall });

    expect(storage.memoryContext({ ...fence, runId: RUN, owner: "someone-else" }))
      .toBeUndefined();
  });
});

describe("admitting a root run", () => {
  const base = {
    origin: "slack_workspace_message",
    executionPrincipalJson: '{"type":"workspace"}',
    status: "running",
    startedAt: NOW,
    model: null,
    triggerPartId: null,
    parentRunId: null,
    expectedLatestRunId: null,
  };

  it("creates the run and marks the work stream busy", () => {
    const { storage, sql } = open();

    expect(storage.admitRun({ ...base, runId: RUN, supersedeActive: false, now: NOW }))
      .toEqual({ outcome: "admitted" });
    expect(sql.exec(`SELECT substream_id, status, origin FROM runs WHERE run_id = ?`, RUN).one())
      .toMatchObject({ substream_id: "0", status: "running", origin: "slack_workspace_message" });
    expect(sql.exec(`SELECT exact_state FROM workstream WHERE id = 1`).one())
      .toMatchObject({ exact_state: "running" });
  });

  it("refuses a second mutating run rather than throwing the transaction away", () => {
    const { storage, sql } = open();
    storage.admitRun({ ...base, runId: RUN, supersedeActive: false, now: NOW });

    // `runs_mutating_substream_uq` allows one mutating run per substream and
    // every root run shares '0'. A bare INSERT throws here, and the throw takes
    // the whole transaction with it — including the supersede below, so the
    // follow-up would neither start its run nor stop the one it replaced.
    expect(storage.admitRun({
      ...base, runId: OTHER, supersedeActive: true, now: NOW + 1_000,
    })).toEqual({ outcome: "busy" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs`).one()).toEqual({ count: 1 });
    // The supersede still landed: the incumbent has been asked to stop, which
    // is what lets the next attempt through once it does.
    expect(sql.exec(
      `SELECT cancellation_requested_at, cancellation_reason FROM runs WHERE run_id = ?`,
      RUN,
    ).one()).toMatchObject({
      cancellation_requested_at: NOW + 1_000,
      cancellation_reason: "superseded_by_follow_up",
    });
  });

  it("admits once the incumbent has actually terminalized", () => {
    const { storage, sql } = open();
    storage.admitRun({ ...base, runId: RUN, supersedeActive: false, now: NOW });
    sql.exec(
      `UPDATE runs SET status = 'cancelled', terminalized_at = ? WHERE run_id = ?`,
      NOW + 500,
      RUN,
    );

    expect(storage.admitRun({
      ...base, runId: OTHER, supersedeActive: true, now: NOW + 1_000,
    })).toEqual({ outcome: "admitted" });
  });

  it("lets a scheduled run in beside a live one, because it is not yet mutating", () => {
    const { storage } = open();
    storage.admitRun({ ...base, runId: RUN, supersedeActive: false, now: NOW });

    // `admitted` is outside the index's status list. An automation queues its
    // run long before anything claims it, and must not be turned away by
    // whatever happens to be running now.
    expect(storage.admitRun({
      ...base, runId: OTHER, status: "admitted", origin: "automation",
      supersedeActive: false, now: NOW + 1_000,
    })).toEqual({ outcome: "admitted" });
  });

  it("lets a HyperSight block in beside a live interactive run", () => {
    const { storage } = open();
    storage.admitRun({ ...base, runId: RUN, supersedeActive: false, now: NOW });

    // The index exempts block runs on both sides, and so does this check.
    expect(storage.admitRun({
      ...base, runId: OTHER, origin: "block_dashboard_block",
      supersedeActive: false, now: NOW + 1_000,
    })).toEqual({ outcome: "admitted" });
  });

  it("refuses when the caller's view of the newest run is out of date", () => {
    const { storage, sql } = open();
    seedRun(sql, OTHER);

    expect(storage.admitRun({
      ...base, runId: RUN, supersedeActive: false,
      expectedLatestRunId: "00000000-0000-7000-8000-00000000ffff", now: NOW,
    })).toEqual({ outcome: "stale" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs WHERE run_id = ?`, RUN).one())
      .toEqual({ count: 0 });
  });

  it("reports a repeated id as an existing run rather than creating a second", () => {
    const { storage } = open();
    storage.admitRun({ ...base, runId: RUN, supersedeActive: false, now: NOW });

    expect(storage.admitRun({ ...base, runId: RUN, supersedeActive: false, now: NOW + 1_000 }))
      .toEqual({ outcome: "exists" });
  });
});

describe("publishing a run's final message", () => {
  const publish = {
    messageId: "00000000-0000-7000-8000-0000000000c1",
    text: "Here is what I found.",
    hostOutcomeStatus: "completed",
    eventPayloadJson: '{"finalMessageId":"m"}',
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

  it("appends the transcript row and records that it did, in one transaction", async () => {
    const { storage, sql } = claimed();

    expect(await storage.publishFinalMessage({ ...fence, runId: RUN, ...publish }))
      .toEqual({ outcome: "published", sequenceNumber: 1 });
    expect(sql.exec(
      `SELECT author_type, message_type, content, client_message_id, produced_by_run_id
         FROM workstream_message_details WHERE id = ?`,
      publish.messageId,
    ).one()).toMatchObject({
      author_type: "agent",
      message_type: "text",
      content: "Here is what I found.",
      client_message_id: `harness:${RUN}`,
      produced_by_run_id: RUN,
    });
    // The lifecycle event is what every later reader joins against. The routed
    // version wrote it as a second statement that re-read `messages` to check
    // the first had landed.
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "final_message" }))
      .toMatchObject({ event_type: "final_message_persisted", status: "completed" });
  });

  it("moves the transcript counters the append consumed", async () => {
    const { storage, sql } = claimed();

    await storage.publishFinalMessage({ ...fence, runId: RUN, ...publish });

    // The routed batch's third statement also assigned
    // `latest_attention_sequence_number`, which was never a column — the view
    // derived it and its trigger ignored the assignment. What it really did is
    // this, and `appendMessage` already did it.
    expect(sql.exec(
      `SELECT next_sequence_number, next_attention_ordinal, last_people_activity_at
         FROM workstream WHERE id = 1`,
    ).one()).toMatchObject({
      next_sequence_number: 2,
      next_attention_ordinal: 2,
      last_people_activity_at: NOW,
    });
  });

  it("refuses an attempt that no longer holds the run", async () => {
    const { storage, sql } = claimed();

    expect(await storage.publishFinalMessage({
      ...fence, runId: RUN, owner: "someone-else", ...publish,
    })).toEqual({ outcome: "ownership_lost" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM workstream_message_records WHERE id = ?`, publish.messageId).one())
      .toEqual({ count: 0 });
    expect(storage.lifecycleEvent({ runId: RUN, eventKey: "final_message" })).toBeUndefined();
  });

  it("refuses an ordinary publish once cancellation was requested", async () => {
    const { storage, sql } = claimed();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    // A run asked to stop must not go on to report a completed answer.
    expect(await storage.publishFinalMessage({ ...fence, runId: RUN, ...publish }))
      .toEqual({ outcome: "ownership_lost" });
  });

  it("lets a stopped run publish what it had already written", async () => {
    const { storage, sql } = claimed();
    sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, NOW, RUN);

    // The member asked it to stop, not to vanish: whatever the model had
    // produced by then is still theirs to read. Same exemption, and the same
    // reason, as `assertHarnessToolSettlementOwned`.
    expect(await storage.publishFinalMessage({
      ...fence, runId: RUN, ...publish,
      hostOutcomeStatus: "stopped", allowCancellationRequested: true,
    })).toMatchObject({ outcome: "published" });
  });

  it("replays rather than writing a second message for the same run", async () => {
    const { storage, sql } = claimed();
    await storage.publishFinalMessage({ ...fence, runId: RUN, ...publish });

    expect(await storage.publishFinalMessage({
      ...fence, runId: RUN, ...publish,
      messageId: "00000000-0000-7000-8000-0000000000c2",
      lifecycleEventId: "event-final-2",
    })).toEqual({ outcome: "replayed", sequenceNumber: 1 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM workstream_message_records WHERE substream_id = '0'`).one())
      .toEqual({ count: 1 });
  });
});
