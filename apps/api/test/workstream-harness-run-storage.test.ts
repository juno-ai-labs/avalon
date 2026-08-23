import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
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
  return { storage: new WorkstreamHarnessRunStorage(binding), sql };
}

function seedRun(
  sql: SqlStorage,
  runId: string,
  overrides: { status?: string; origin?: string; startedAt?: number } = {},
): void {
  sql.exec(
    `INSERT INTO runs
       (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
        next_action_cursor, input_fence_seq, revision, started_at,
        active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
        tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
        origin, execution_principal_json, chain_depth, created_at, updated_at)
     VALUES (?, '0', ?, '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, '{}', 0, 1, 1)`,
    runId,
    overrides.status ?? "admitted",
    overrides.startedAt ?? 0,
    overrides.origin ?? "member_message",
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

  it("refuses while another interactive run holds a live lease", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    seedRun(sql, OTHER);
    storage.claimAttempt({
      ...fence, runId: OTHER, leaseSeconds: 60, lifecycleEventId: "event-other",
    });

    expect(storage.claimAttempt({
      ...fence, runId: RUN, attemptId: "attempt-2", leaseSeconds: 60, lifecycleEventId: "event-1",
    })).toEqual({ outcome: "not_claimable" });
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
    })).toEqual({ outcome: "not_claimable" });
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
