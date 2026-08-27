import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import {
  WorkstreamToolReceiptStorage,
  type ToolReceiptFence,
} from "../src/durable-objects/workstream-tool-receipt-storage";
import {
  insertWorkstreamMessageRecord,
  prepareWorkstreamMessageRecord,
} from "../src/durable-objects/workstream-transcript-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const RUN = "00000000-0000-7000-8000-0000000000r1";
const ATTEMPT = "attempt-1";
const OWNER = "owner-1";
const NOW = 1_787_000_000_000;
const WORKSPACE = "00000000-0000-7000-8000-0000000000w1";

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

  it("replays an exact completed receipt after its executor lease is gone", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });
    sql.exec(`UPDATE runs SET lease_expires_at = ?`, NOW - 1);

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

  it("refuses to rebind when either statement of the incoming mode is not a read", () => {
    // Each half on its own, because the gate is a conjunction and a test that
    // only ever disagreed with both at once would pass against either one being
    // dropped. The two statements come from different places in the caller's
    // plan and are checked here rather than trusted as a boolean, so the case
    // where they disagree has to be reachable in a test even though no caller
    // produces it today.
    for (const incoming of [
      { mode: "write" as const, executionPlanJson: '{"mode":"read"}' },
      { mode: "read" as const, executionPlanJson: '{"mode":"write"}' },
      { mode: "read" as const, executionPlanJson: "not json at all" },
    ]) {
      const { storage, sql } = open();
      storage.admit(plan());
      storage.complete({
        effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
        outputSummary: "done", providerOperationId: null, payloadJson: "{}",
        allowAmbiguousReconciliation: false, fence, now: NOW,
      });

      expect(storage.admit(plan({
        ...incoming,
        requestHash: "other",
        executionPlanHash: "other",
      }))).toEqual({ state: "ambiguous_external_write", effectIntentId: "effect-1" });
      // And the settled read is untouched — still completed, still holding its
      // own result and its own request. That is the point of failing closed: a
      // rebind clears `output_ref` and takes the incoming call's hash, so the
      // refusal has to leave both where they were.
      expect(sql.exec(`SELECT status, output_ref, request_hash FROM tool_effects`).toArray())
        .toEqual([{ status: "completed", output_ref: "ref", request_hash: "request-hash" }]);
    }
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

  /**
   * The statuses the retired `_runtime_harness_runs` view projected as
   * `running`. Nothing writes either one today, so these two cases pass on the
   * `runs` CHECK constraint's vocabulary rather than on a path the product can
   * reach — which is the point: the fence is what would silently start
   * refusing settled receipts if a writer ever appeared.
   */
  for (const status of ["waiting", "steering"] as const) {
    it(`still holds the lease while the run is ${status}`, () => {
      const { storage, sql } = open();
      storage.admit(plan());
      sql.exec(`UPDATE runs SET status = '${status}'`);

      expect(storage.complete({
        effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
        outputSummary: "done", providerOperationId: null, payloadJson: "{}",
        allowAmbiguousReconciliation: false, fence, now: NOW,
      })).toBe("persisted");
      expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
        .toEqual([{ status: "completed" }]);
    });
  }

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

// ------------------------------------------------------------------- reading

/**
 * Reading a receipt back, in the object's own vocabulary.
 *
 * The retired view answered these questions in compat spellings — `id`,
 * `harness_run_id`, `pending`/`started`, ISO-8601 — and the callers were written
 * against that. The translation does not disappear: `ToolInvocationSchema` is a
 * published wire shape, so it moves into the Worker-side port. What these
 * operations owe is the *real* value, once, without a correlated subquery for a
 * column nothing reads.
 */
describe("reading a receipt by its call coordinate", () => {
  it("returns the stored receipt for a run and tool call", () => {
    const { storage } = open();
    storage.admit(plan());

    expect(storage.receiptForCall({ runId: RUN, toolCallId: "call-1" })).toMatchObject({
      effectIntentId: "effect-1",
      runId: RUN,
      toolCallId: "call-1",
      toolName: "read_resource",
      mode: "read",
      status: "executing",
      requestHash: "request-hash",
      checkpointIndex: 0,
    });
  });

  it("returns null for a call that has no receipt", () => {
    const { storage } = open();
    storage.admit(plan());

    expect(storage.receiptForCall({ runId: RUN, toolCallId: "call-2" })).toBeNull();
  });

  it("answers in real statuses, not the view's spellings", () => {
    const { storage } = open();
    storage.admit(plan());

    // `executing`, never `started`. A caller that wants the wire spelling
    // translates at the port; the object does not lie about its own column.
    expect(storage.receiptForCall({ runId: RUN, toolCallId: "call-1" })?.status).toBe("executing");
  });

  it("carries settlement through as unix milliseconds", () => {
    const { storage } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });

    const receipt = storage.receiptForCall({ runId: RUN, toolCallId: "call-1" });
    expect(receipt).toMatchObject({ status: "completed", outputRef: "ref", settledAt: NOW });
  });
});

describe("reading receipts by id", () => {
  it("returns only the ids it was given, in id order", () => {
    const { storage } = open();
    storage.admit(plan());
    storage.admit(plan({ effectIntentId: "effect-2", toolCallId: "call-2" }));
    storage.admit(plan({ effectIntentId: "effect-3", toolCallId: "call-3" }));

    const found = storage.receiptsByIds({ effectIntentIds: ["effect-3", "effect-1"] });

    expect(found.map((r) => r.effectIntentId)).toEqual(["effect-1", "effect-3"]);
  });

  it("silently omits an id with no receipt rather than failing", () => {
    const { storage } = open();
    storage.admit(plan());

    // The transcript projection asks about every tool message it holds; a
    // message whose receipt was discarded is an ordinary state, not an error.
    expect(storage.receiptsByIds({ effectIntentIds: ["effect-1", "missing"] })
      .map((r) => r.effectIntentId)).toEqual(["effect-1"]);
  });

  it("returns nothing for an empty request without touching the database", () => {
    const { storage } = open();
    storage.admit(plan());

    expect(storage.receiptsByIds({ effectIntentIds: [] })).toEqual([]);
  });
});

// -------------------------------------------------- attachment dependencies

/**
 * The resource versions a replayable attachment read depended on.
 *
 * These rows live in `attachment_tool_receipts`, which is a real table the
 * compatibility schema happens to create — not a view, and not debris. The
 * comparison they support is now the *only* mechanism invalidating a stale
 * attachment replay: the D1 trigger that once deleted receipts eagerly when a
 * derivative changed has no cross-object successor, because receipts and
 * resources now live in different Durable Objects.
 */
/**
 * Complete the admitted receipt, because a dependency may only attach to one.
 *
 * The caller registers *after* completing, so the row it names may already have
 * been replanned onto another call and completed again; matching `output_ref` is
 * what ties the dependency to the result the caller actually saw.
 */
const OUTPUT_REF = "tool-results/effect-1";

function settle(storage: WorkstreamToolReceiptStorage, outputRef = OUTPUT_REF): void {
  storage.complete({
    effectIntentId: "effect-1", checkpointIndex: 1, outputRef,
    outputSummary: "done", providerOperationId: null, payloadJson: "{}",
    allowAmbiguousReconciliation: false, fence, now: NOW,
  });
}

describe("recording what an attachment read depended on", () => {
  it("records one row per resource against a completed receipt", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    settle(storage);

    expect(storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [
        { resourceId: "resource-b", derivativeSha256: "sha-b" },
        { resourceId: "resource-a", derivativeSha256: "sha-a" },
      ],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    })).toBe("recorded");

    expect(sql.exec(
      `SELECT resource_id, derivative_sha256 FROM attachment_tool_receipts ORDER BY resource_id`,
    ).toArray()).toEqual([
      { resource_id: "resource-a", derivative_sha256: "sha-a" },
      { resource_id: "resource-b", derivative_sha256: "sha-b" },
    ]);
  });

  it("refuses to record against a receipt that does not exist", () => {
    const { storage, sql } = open();

    expect(storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [{ resourceId: "resource-a", derivativeSha256: "sha-a" }],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    })).toBe("receipt_missing");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM attachment_tool_receipts`).one().count).toBe(0);
  });

  it("overwrites the digest when the same resource is recorded again", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    settle(storage);
    const record = (sha: string) => storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [{ resourceId: "resource-a", derivativeSha256: sha }],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    });
    record("sha-old");

    record("sha-new");

    expect(sql.exec(`SELECT derivative_sha256 FROM attachment_tool_receipts`).toArray())
      .toEqual([{ derivative_sha256: "sha-new" }]);
  });

  it("refuses a dependency against a completion the caller did not see", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    settle(storage, "tool-results/a-later-call");

    // The caller completed, then registered. Between the two the receipt can be
    // replanned onto another call and completed again, and attaching the first
    // call's dependency to the second call's result would make a replay claim a
    // resource version that result never read.
    expect(storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [{ resourceId: "resource-a", derivativeSha256: "sha-a" }],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    })).toBe("receipt_missing");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM attachment_tool_receipts`).one().count).toBe(0);
  });

  it("refuses to record against a receipt that has not been completed", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    // The ref is planted on a receipt still in flight, so that matching it is
    // not what refuses — the status is. Asserting against an ordinary admitted
    // receipt would pass on its null `output_ref` whether the completion
    // scoping existed or not.
    sql.exec(
      `UPDATE tool_effects SET output_ref = ? WHERE effect_intent_id = ?`,
      OUTPUT_REF,
      "effect-1",
    );

    expect(storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [{ resourceId: "resource-a", derivativeSha256: "sha-a" }],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    })).toBe("receipt_missing");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM attachment_tool_receipts`).one().count).toBe(0);
  });

  it("unwinds nothing when the completion it was told to unwind has moved on", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    settle(storage);
    storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [{ resourceId: "resource-a", derivativeSha256: "sha-a" }],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    });
    sql.exec(
      `UPDATE tool_effects SET output_ref = ? WHERE effect_intent_id = ?`,
      "tool-results/a-later-call",
      "effect-1",
    );

    // The compensating delete carries the same fence as the write: a stale
    // executor rolling back its own failed check must not take a successor's
    // dependencies with it.
    expect(storage.clearAttachmentDependencies({
      workspaceId: WORKSPACE, effectIntentId: "effect-1", expectedOutputRef: OUTPUT_REF,
    })).toBe(0);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM attachment_tool_receipts`).one().count).toBe(1);
  });

  it("clears every dependency of one receipt", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    settle(storage);
    storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [
        { resourceId: "resource-a", derivativeSha256: "sha-a" },
        { resourceId: "resource-b", derivativeSha256: "sha-b" },
      ],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    });

    expect(storage.clearAttachmentDependencies({
      workspaceId: WORKSPACE, effectIntentId: "effect-1", expectedOutputRef: OUTPUT_REF,
    })).toBe(2);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM attachment_tool_receipts`).one().count).toBe(0);
  });
});

describe("reading what an attachment replay depends on", () => {
  it("lists dependencies of a completed receipt, in resource order", () => {
    const { storage } = open();
    storage.admit(plan());
    settle(storage);
    storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [
        { resourceId: "resource-b", derivativeSha256: "sha-b" },
        { resourceId: "resource-a", derivativeSha256: "sha-a" },
      ],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    });
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });

    expect(storage.attachmentDependencies({
      workspaceId: WORKSPACE, effectIntentId: "effect-1",
    })).toEqual([
      { resourceId: "resource-a", derivativeSha256: "sha-a" },
      { resourceId: "resource-b", derivativeSha256: "sha-b" },
    ]);
  });

  it("returns nothing while the receipt is still executing", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    settle(storage);
    storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [{ resourceId: "resource-a", derivativeSha256: "sha-a" }],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    });
    // Written directly, because no operation puts a receipt back in flight once
    // it carries dependencies — recording requires a completion and rebinding
    // refuses a receipt anything depends on. The state is still worth asserting
    // on: it is what the reader sees mid-replan, and the scoping is what keeps
    // "in flight" and "nothing to replay" indistinguishable to the caller.
    sql.exec(`UPDATE tool_effects SET status = 'executing' WHERE effect_intent_id = ?`, "effect-1");

    // The caller reads an empty list as "not replayable". An in-flight receipt
    // has nothing to replay, so the two answers must not be distinguishable
    // here — the routed statement joined on `status = 'completed'` for exactly
    // this reason.
    expect(storage.attachmentDependencies({
      workspaceId: WORKSPACE, effectIntentId: "effect-1",
    })).toEqual([]);
  });
});

describe("discarding a receipt whose replay is no longer valid", () => {
  it("returns the output ref it held and deletes the row", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "receipts/output.json",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });

    // The ref comes back so the Worker can queue the stored payload for
    // deletion *after* the row is gone. The routed version enqueued first and
    // could strand an outbox row pointing at a receipt that still existed.
    expect(storage.discardReceipt({ workspaceId: WORKSPACE, effectIntentId: "effect-1" }))
      .toEqual({ outputRef: "receipts/output.json", deleted: true });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM tool_effects`).one().count).toBe(0);
  });

  it("reports a receipt that was already gone without inventing a ref", () => {
    const { storage } = open();

    expect(storage.discardReceipt({ workspaceId: WORKSPACE, effectIntentId: "effect-1" }))
      .toEqual({ outputRef: null, deleted: false });
  });

  it("takes the receipt's attachment dependencies with it", () => {
    const { storage, sql } = open();
    storage.admit(plan());
    settle(storage);
    storage.recordAttachmentDependencies({
      workspaceId: WORKSPACE,
      effectIntentId: "effect-1",
      dependencies: [{ resourceId: "resource-a", derivativeSha256: "sha-a" }],
      expectedOutputRef: OUTPUT_REF,
      now: NOW,
    });

    storage.discardReceipt({ workspaceId: WORKSPACE, effectIntentId: "effect-1" });

    // By `ON DELETE CASCADE`, which is load-bearing and was never covered.
    expect(sql.exec(`SELECT COUNT(*) AS count FROM attachment_tool_receipts`).one().count).toBe(0);
  });
});

// ------------------------------------------------------------ terminal-run cleanup

/**
 * Settling the residual receipts of a terminal run.
 *
 * This one cannot be `fail()` with different arguments. Every other operation
 * here opens with `#fence`, which requires a live lease — and the sweep's whole
 * premise is that no lease exists, so all four would answer `ownership_lost` by
 * construction. Its guard is the run's own `terminalized_at` instead, re-read
 * here rather than trusted from the caller, so the method is safe to call
 * outside the batch that terminalized the run.
 */
describe("settling the residual receipts of a terminal run", () => {
  function reaped(sql: ReturnType<typeof createTestSqlStorage>, at = NOW): void {
    sql.exec(
      `UPDATE runs SET status = 'failed', terminalized_at = ?, lease_owner = NULL WHERE run_id = ?`,
      at,
      RUN,
    );
  }

  function settleResidual(
    storage: WorkstreamToolReceiptStorage,
    at = NOW,
  ): ReturnType<WorkstreamToolReceiptStorage["settleResidualReceipts"]> {
    return storage.settleResidualReceipts({
      runId: RUN,
      attemptId: ATTEMPT,
      phase: "failed",
      errorJson: '{"code":"parent_run_terminated","message":"The parent run lost its durable lease"}',
      payloadJson: '{"code":"parent_run_terminated"}',
      ambiguousMessage: "The parent run lost its durable lease while an external write was in flight",
      lease: { kind: "terminalized", at },
      now: at,
    });
  }

  it("fails a read receipt that never started talking to a provider", async () => {
    const { storage, sql } = open();
    storage.admit(plan());
    reaped(sql);

    await expect(settleResidual(storage)).resolves.toEqual({ settled: 1, open: 0 });
    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "failed" }]);
  });

  it("leaves a write receipt ambiguous, because the provider may have been reached", async () => {
    const { storage, sql } = open();
    storage.admit(plan({
      mode: "write",
      executionPlanJson: '{"mode":"write"}',
    }));
    reaped(sql);

    await expect(settleResidual(storage)).resolves.toEqual({ settled: 1, open: 0 });
    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "ambiguous" }]);
  });

  it("treats a receipt with no readable plan as possibly a write", async () => {
    const { storage, sql } = open();
    storage.admit(plan());
    // The mode column says `read` for an unreadable plan; the sweep does not
    // trust it. Demoting these to `failed` would turn "we could not confirm the
    // write" into "it definitely failed", which is the wrong direction for a
    // call whose provider request may have landed.
    sql.exec(`UPDATE tool_effects SET execution_plan_json = NULL`);
    reaped(sql);

    await settleResidual(storage);

    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "ambiguous" }]);
  });

  it("never touches a receipt that already settled", async () => {
    const { storage, sql } = open();
    storage.admit(plan());
    storage.complete({
      effectIntentId: "effect-1", checkpointIndex: 1, outputRef: "ref",
      outputSummary: "done", providerOperationId: null, payloadJson: "{}",
      allowAmbiguousReconciliation: false, fence, now: NOW,
    });
    reaped(sql);

    await expect(settleResidual(storage)).resolves.toEqual({ settled: 0, open: 0 });
    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "completed" }]);
  });

  it("settles the tool card the member is looking at, not just the receipt", async () => {
    const { storage, sql } = open();
    storage.admit(plan());
    // A rendered tool part carrying the same id as its receipt, mid-flight.
    insertWorkstreamMessageRecord(sql, await prepareWorkstreamMessageRecord({
      messageId: "effect-1",
      clientMessageId: "tool:effect-1",
      authorType: "agent",
      authorUserId: null,
      externalActorJson: null,
      messageType: "tool",
      text: "",
      structuredContentJson:
        '{"invocation":{"status":"started","completedAt":null,"error":null}}',
      producedByRunId: null,
      role: "assistant",
      kind: "tool_call",
      effectIntentId: "effect-1",
      toolName: "read_resource",
      toolMode: "read",
      toolStatus: "pending",
      visibility: "both",
      sequenceNumber: 2,
      attentionOrdinal: null,
      createdAt: 1,
      editedAt: null,
      now: 1,
    }));
    reaped(sql);

    await settleResidual(storage);

    // Without this the receipt goes terminal and the card spins forever. It
    // used to be the compatibility trigger's job — object schema migration 14
    // taught it to project a settled receipt into the same-id part, because the
    // sweep has no event publisher and never writes the transcript row again.
    // Dropping that trigger is therefore not a pure deletion, and this is the
    // spec that says so.
    expect(sql.exec(
      `SELECT tool_status,
              json_extract(structured_content_json, '$.invocation.status') AS visible_status,
              json_extract(structured_content_json, '$.invocation.error.code') AS visible_error
         FROM workstream_message_details WHERE id = 'effect-1'`,
    ).toArray()).toEqual([{
      tool_status: "failed",
      visible_status: "failed",
      visible_error: "parent_run_terminated",
    }]);
    const canonical = sql.exec<{
      tool_status: string;
      edited_at: number | null;
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT record.tool_status, record.edited_at, payload.payload_json
         FROM workstream_message_records record
         JOIN transcript_facts fact ON fact.fact_id = record.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE record.id = 'effect-1'`,
    ).one();
    expect(canonical.tool_status).toBe("failed");
    expect(canonical.edited_at).toBe(NOW);
    expect(JSON.parse(canonical.payload_json)).toMatchObject({
      structuredContent: {
        invocation: {
          status: "failed",
          error: { code: "parent_run_terminated" },
        },
      },
    });
  });

  it("refuses when the run was not terminalized at the instant claimed", async () => {
    const { storage, sql } = open();
    storage.admit(plan());
    reaped(sql, NOW);

    // The guard is the sweep's own fence, re-proved here. A caller passing a
    // stale timestamp is describing a different terminalization than the one
    // that happened, and must move nothing.
    await expect(settleResidual(storage, NOW - 1)).resolves.toEqual({ settled: 0, open: 1 });
    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "executing" }]);
  });

  it("refuses while the run is still live", async () => {
    const { storage, sql } = open();
    storage.admit(plan());

    await expect(settleResidual(storage)).resolves.toEqual({ settled: 0, open: 1 });
    expect(sql.exec(`SELECT status FROM tool_effects`).toArray())
      .toEqual([{ status: "executing" }]);
  });
});
