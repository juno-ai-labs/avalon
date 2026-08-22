import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import {
  WorkstreamToolReceiptStorage,
  type ToolReceiptFence,
} from "../src/durable-objects/workstream-tool-receipt-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const RUN = "00000000-0000-7000-8000-0000000000r1";
const ATTEMPT = "attempt-1";
const OWNER = "owner-1";
const NOW = 1_787_000_000_000;

const fence: ToolReceiptFence = { runId: RUN, attemptId: ATTEMPT, owner: OWNER };

/**
 * A live run holding its lease, which is the precondition every write here is
 * fenced against. `legacy_attempt_id` rather than `attempt_epoch` because that
 * is the identity `claimHarnessAttempt` writes and the receipt fence reads.
 */
function open(): {
  storage: WorkstreamToolReceiptStorage;
  sql: ReturnType<typeof createTestSqlStorage>;
} {
  const database = new DatabaseSync(":memory:");
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "v", 1);
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
  sql.exec(
    `INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
       model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
       active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
       tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
       created_at, updated_at, legacy_attempt_id, lease_owner, lease_expires_at)
     VALUES (?,'0','running','{}',0,0,'',0,0,1,0,0,0,0,0,0,0,0,0,0,1,1,?,?,?)`,
    RUN,
    ATTEMPT,
    OWNER,
    NOW + 600_000,
  );
  return { storage: new WorkstreamToolReceiptStorage(binding), sql };
}

function plan(overrides: Partial<Parameters<WorkstreamToolReceiptStorage["admit"]>[0]> = {}): Parameters<WorkstreamToolReceiptStorage["admit"]>[0] {
  return {
    effectIntentId: "effect-1",
    runId: RUN,
    toolCallId: "call-1",
    toolName: "read_resource",
    mode: "read",
    connectionId: null,
    requestHash: "request-hash",
    inputJson: "{}",
    executionPlanHash: "plan-hash",
    executionPlanJson: '{"mode":"read"}',
    compatiblePriorPlanHashes: [],
    incomingIsRead: true,
    providerIdempotencyKey: null,
    fence,
    now: NOW,
    ...overrides,
  };
}

describe("admitting a tool call's execution plan", () => {
  it("creates the receipt and its first checkpoint together", () => {
    const { storage, sql } = open();

    expect(storage.admit(plan())).toEqual({ state: "created", effectIntentId: "effect-1" });

    expect(sql.exec(`SELECT status, tool_call_id, tool_position, mode FROM tool_effects`).toArray())
      .toEqual([{ status: "executing", tool_call_id: "call-1", tool_position: 0, mode: "read" }]);
    // Admission and its checkpoint commit together or not at all. The routed
    // version wrote them as two statements in a D1 batch, so a receipt with no
    // checkpoint was a reachable state.
    expect(sql.exec(`SELECT checkpoint_index, phase FROM tool_effect_checkpoints`).toArray())
      .toEqual([{ checkpoint_index: 0, phase: "execution_planned" }]);
  });

  it("allocates positions from a high-water mark, so a deleted receipt cannot wedge the run", () => {
    const { storage, sql } = open();
    storage.admit(plan({ effectIntentId: "effect-a", toolCallId: "call-a" }));
    storage.admit(plan({ effectIntentId: "effect-b", toolCallId: "call-b" }));
    storage.admit(plan({ effectIntentId: "effect-c", toolCallId: "call-c" }));
    // The middle one, so the high-water mark stays above the freed number.
    // Deleting the last would free the top and prove nothing.
    sql.exec(`DELETE FROM tool_effects WHERE effect_intent_id = 'effect-b'`);

    storage.admit(plan({ effectIntentId: "effect-d", toolCallId: "call-d" }));

    // 3, not 2. `UNIQUE (run_id, attempt_epoch, tool_position)` still holds 2,
    // and a count-based allocator would have collided there and silently
    // dropped this admission — which is the wedge migration 16 repaired in the
    // compatibility trigger.
    expect(sql.exec(
      `SELECT effect_intent_id, tool_position FROM tool_effects ORDER BY tool_position`,
    ).toArray()).toEqual([
      { effect_intent_id: "effect-a", tool_position: 0 },
      { effect_intent_id: "effect-c", tool_position: 2 },
      { effect_intent_id: "effect-d", tool_position: 3 },
    ]);
  });

  it("resumes a read that is already admitted under the same plan", () => {
    const { storage } = open();
    storage.admit(plan());

    expect(storage.admit(plan())).toEqual({ state: "resume_read", effectIntentId: "effect-1" });
  });

  it("replays a completed receipt rather than running it twice", () => {
    const { storage } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });

    expect(storage.admit(plan())).toEqual({ state: "replay_completed", effectIntentId: "effect-1" });
  });

  it("refuses a write whose coordinate was already admitted, and marks it ambiguous", () => {
    const { storage, sql } = open();
    const write = plan({ mode: "write", executionPlanJson: '{"mode":"write"}' });
    storage.admit(write);

    expect(storage.admit(write))
      .toEqual({ state: "ambiguous_external_write", effectIntentId: "effect-1" });
    // The receipt is moved, not merely reported: a prior write may have reached
    // the provider, so nothing may later treat it as replayable.
    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "ambiguous" }]);
  });

  it("treats a reused coordinate with a different plan as ambiguous", () => {
    const { storage } = open();
    storage.admit(plan());

    expect(storage.admit(plan({ requestHash: "different", executionPlanHash: "different" })))
      .toEqual({ state: "ambiguous_external_write", effectIntentId: "effect-1" });
  });

  it("accepts a plan the caller declared compatible with the stored one", () => {
    const { storage } = open();
    storage.admit(plan());

    expect(storage.admit(plan({
      executionPlanHash: "plan-hash-2",
      compatiblePriorPlanHashes: ["plan-hash"],
    }))).toEqual({ state: "resume_read", effectIntentId: "effect-1" });
  });

  it("rebinds a settled read nothing depends on to the call that landed on it", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });

    expect(storage.admit(plan({ requestHash: "other", executionPlanHash: "other" })))
      .toEqual({ state: "created", effectIntentId: "effect-1" });
    // Rebound, not duplicated: one row, live again, and its earlier result
    // cleared so nothing replays a payload the new call did not produce.
    expect(sql.exec(`SELECT status, output_ref, request_hash FROM tool_effects`).toArray())
      .toEqual([{ status: "executing", output_ref: null, request_hash: "other" }]);
  });

  it("refuses to rebind a settled read something else already built on", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });
    sql.exec(
      `INSERT INTO attachment_tool_receipts
         (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
       VALUES ('W','resource-1','effect-1','sha',?)`,
      NOW,
    );

    expect(storage.admit(plan({ requestHash: "other", executionPlanHash: "other" })))
      .toEqual({ state: "ambiguous_external_write", effectIntentId: "effect-1" });
  });
});

describe("the run lease every receipt write is fenced against", () => {
  /**
   * The reason is carried, not collapsed. A cancelled run is a person stopping
   * the work and surfaces as `RunCancelledError`; everything else is this
   * executor no longer being the one doing it. Only the second is a fault, and
   * the routed version drew the same line inside `assertHarnessAttemptOwned`.
   */
  const lost = [
    ["the lease expired", `UPDATE runs SET lease_expires_at = ${NOW - 1}`, "ownership_lost"],
    ["another executor took the attempt", `UPDATE runs SET lease_owner = 'someone-else'`, "ownership_lost"],
    ["the attempt was superseded", `UPDATE runs SET legacy_attempt_id = 'attempt-2'`, "ownership_lost"],
    ["cancellation was requested", `UPDATE runs SET cancellation_requested_at = ${NOW}`, "cancelled"],
    ["the run was cancelled", `UPDATE runs SET status = 'cancelled'`, "cancelled"],
    ["the run was terminalized", `UPDATE runs SET terminalized_at = ${NOW}`, "ownership_lost"],
    ["the run left running", `UPDATE runs SET status = 'completed'`, "ownership_lost"],
  ] as const;

  for (const [because, breakFence, outcome] of lost) {
    it(`refuses to admit when ${because}`, () => {
      const { storage, sql } = open();
      sql.exec(breakFence);

      expect(storage.admit(plan())).toEqual({ state: outcome });
      expect(sql.exec(`SELECT COUNT(*) AS count FROM tool_effects`).toArray())
        .toEqual([{ count: 0 }]);
    });

    it(`refuses to settle when ${because}`, () => {
      const { storage, sql } = open();
      storage.admit(plan());
      sql.exec(breakFence);

      expect(storage.complete({
        effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
        outputSummary: "done", providerOperationId: null, payloadJson: "{}",
        allowAmbiguousReconciliation: false, fence, now: NOW,
      })).toBe(outcome);
      expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
        .toEqual([{ status: "executing" }]);
    });
  }
});

describe("settling a receipt", () => {
  it("makes a result replayable and appends its checkpoint atomically", () => {
    const { storage, sql } = open();
    storage.admit(plan());

    expect(storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: "op-1", payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW + 5,
    })).toBe("persisted");

    expect(sql.exec(
      `SELECT status, output_ref, output_summary, provider_operation_id, settled_at,
              checkpoint_index
         FROM tool_effects`,
    ).toArray()).toEqual([{
      status: "completed", output_ref: "ref", output_summary: "done",
      provider_operation_id: "op-1", settled_at: NOW + 5, checkpoint_index: 1,
    }]);
    expect(sql.exec(
      `SELECT phase FROM tool_effect_checkpoints ORDER BY checkpoint_index`,
    ).toArray()).toEqual([{ phase: "execution_planned" }, { phase: "result_persisted" }]);
  });

  it("reports an identical repeat as already persisted rather than lost", () => {
    const { storage } = open();
    storage.admit(plan());
    const settle = {
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    };
    expect(storage.complete(settle)).toBe("persisted");

    // The executor retried after its result was already durable. That is a
    // successful step, not a lease failure — the distinction is what stops a
    // retry from ending the run.
    expect(storage.complete(settle)).toBe("already_persisted");
  });

  it("refuses to complete a settled receipt with a different result", () => {
    const { storage } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });

    expect(storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "other-ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    })).toBe("ownership_lost");
  });

  it("only reconciles an ambiguous receipt when the caller allows it", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    sql.exec(`UPDATE tool_effects SET status = 'ambiguous'`);
    const settle = {
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      fence, now: NOW,
    };

    expect(storage.complete({ ...settle, allowAmbiguousReconciliation: false }))
      .toBe("ownership_lost");
    expect(storage.complete({ ...settle, allowAmbiguousReconciliation: true }))
      .toBe("persisted");
  });

  it("moves a failed receipt to ambiguous, because the write may have landed", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    storage.fail({
      effectIntentId: "effect-1", status: "failed", phase: "provider_error",
      errorJson: '{"code":"boom"}', payloadJson: "{}", fence, now: NOW,
    });

    expect(storage.fail({
      effectIntentId: "effect-1", status: "ambiguous", phase: "ambiguous_external_write",
      errorJson: '{"code":"ambiguous"}', payloadJson: "{}", fence, now: NOW,
    })).toBe("persisted");
    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "ambiguous" }]);
  });

  it("refuses to fail a receipt that already completed", () => {
    const { storage } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });

    // A completed receipt is terminal. The routed version's status predicate
    // matched nothing here and the caller reported a lease failure that never
    // happened; this says so directly instead.
    expect(storage.fail({
      effectIntentId: "effect-1", status: "failed", phase: "provider_error",
      errorJson: '{"code":"boom"}', payloadJson: "{}", fence, now: NOW,
    })).toBe("ownership_lost");
  });
});

describe("checkpointing a live receipt", () => {
  it("advances the index and records the phase", () => {
    const { storage, sql } = open();
    storage.admit(plan());

    expect(storage.checkpoint({
      effectIntentId: "effect-1", checkpointIndex: 1, phase: "provider_acknowledged",
      payloadJson: '{"seen":true}', fence, now: NOW,
    })).toBe("persisted");
    expect(sql.exec(`SELECT checkpoint_index FROM tool_effects`).toArray())
      .toEqual([{ checkpoint_index: 1 }]);
  });

  it("treats a replayed checkpoint as already persisted", () => {
    const { storage } = open();
    storage.admit(plan());
    const step = {
      effectIntentId: "effect-1", checkpointIndex: 1, phase: "provider_acknowledged",
      payloadJson: "{}", fence, now: NOW,
    };
    storage.checkpoint(step);

    expect(storage.checkpoint(step)).toBe("already_persisted");
  });

  it("never moves the index backwards", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    storage.checkpoint({
      effectIntentId: "effect-1", checkpointIndex: 3, phase: "late",
      payloadJson: "{}", fence, now: NOW,
    });

    expect(storage.checkpoint({
      effectIntentId: "effect-1", checkpointIndex: 2, phase: "earlier",
      payloadJson: "{}", fence, now: NOW,
    })).toBe("already_persisted");
    expect(sql.exec(`SELECT checkpoint_index FROM tool_effects`).toArray())
      .toEqual([{ checkpoint_index: 3 }]);
  });
});

/**
 * One tool call gets one receipt, and two things enforce it.
 *
 * `tool_effects_run_call_uq` is a unique index on `(run_id, tool_call_id)` that
 * the *compatibility* schema creates. That placement makes it look like debris
 * to be swept out with the views, and it is not: it is the constraint behind
 * the routed `ON CONFLICT(harness_run_id, tool_call_id) DO NOTHING` — the SQL
 * router strips that clause on the ground that each compat trigger applies the
 * equivalent policy to its normalized table, and this index is the equivalence.
 * It is the replay dedup for every tool receipt in the product.
 *
 * These two specs are here to make dropping it loud. Retiring the compat layer
 * must carry this index into the object's own schema; deleting it along with
 * the views changes nothing observable at the time and silently permits two
 * receipts for one call, which is precisely the class of silent loss the
 * retirement PRD exists to prevent.
 */
describe("one receipt per tool call", () => {
  it("refuses a second row on the same (run_id, tool_call_id)", () => {
    const { storage, sql } = open();
    storage.admit(plan());

    // Straight at the table, bypassing `admit` entirely: the point is that the
    // schema refuses this, not that the storage class declines to ask.
    expect(() => sql.exec(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          input_json)
       VALUES ('effect-2', ?, 0, 99, 'runtime:effect-2', 'read_resource', 'read',
               'request-hash', 'runtime', 'executing', 'call-1', '{}')`,
      RUN,
    )).toThrow(/UNIQUE constraint failed: tool_effects\.run_id, tool_effects\.tool_call_id/u);
  });

  it("resolves a replayed admission by the call key, not by an ignored insert", () => {
    const { storage, sql } = open();
    storage.admit(plan());

    // A retry that minted a fresh effect id. The routed version inferred this
    // from `changes() === 0` after an `INSERT OR IGNORE`, which is why a
    // position collision could be mistaken for a replay; `admit` reads the call
    // key first, so it returns the *stored* id rather than the one it was
    // handed.
    const replay = storage.admit(plan({ effectIntentId: "effect-2" }));

    expect(replay).toEqual({ state: "resume_read", effectIntentId: "effect-1" });
    expect(sql.exec(`SELECT effect_intent_id FROM tool_effects`).toArray())
      .toEqual([{ effect_intent_id: "effect-1" }]);
  });
});
