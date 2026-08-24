import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamSchedulingStorage } from "../src/durable-objects/workstream-scheduling-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const RUN = "00000000-0000-7000-8000-0000000000d1";
const NOW = 1_787_000_000_000;

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * A work stream's own object, with one run to hang scheduling rows from.
 *
 * The object's tables rather than the compatibility views: these operations are
 * what replaces those views, so a fixture written in their vocabulary would be
 * seeding the thing this slice deletes.
 */
function open(): {
  storage: WorkstreamSchedulingStorage;
  sql: ReturnType<typeof createTestSqlStorage>;
} {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
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
    `INSERT INTO runs
       (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
        next_action_cursor, input_fence_seq, revision, started_at,
        active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
        tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
        origin, execution_principal_json, chain_depth, model, created_at, updated_at)
     VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
             'member_message', '{}', 0, 'a-model', ?, ?)`,
    RUN,
    NOW,
    NOW,
    NOW,
  );
  return { storage: new WorkstreamSchedulingStorage(binding), sql };
}

/** The wake-up every test starts from. */
function wakeup(overrides: Record<string, unknown> = {}) {
  return {
    wakeupId: "wakeup-1",
    createdByRunId: RUN,
    executionPrincipalJson: JSON.stringify({ type: "workspace", workspaceId: "W" }),
    prompt: "Check the deploy",
    dueAt: NOW + 3_600_000,
    idempotencyKey: "receipt-1",
    now: NOW,
    ...overrides,
  };
}

describe("scheduling a wake-up", () => {
  it("tells a replay apart from a first scheduling and from an archived work stream", () => {
    const { storage, sql } = open();

    expect(storage.scheduleWakeup(wakeup())).toEqual({
      outcome: "scheduled",
      wakeupId: "wakeup-1",
    });
    // The same receipt, retried. The routed statement expressed this as
    // `ON CONFLICT … DO NOTHING` plus a re-read, so a replay and a refusal both
    // arrived as zero rows written; the operation names which happened, and
    // answers with the wake-up the first attempt created rather than the id
    // this caller proposed.
    expect(storage.scheduleWakeup(wakeup({ wakeupId: "wakeup-2" }))).toEqual({
      outcome: "replayed",
      wakeupId: "wakeup-1",
    });
    expect(sql.exec(`SELECT COUNT(*) AS n FROM workstream_wakeups`).one().n).toBe(1);

    sql.exec(`UPDATE workstream SET archived_at = ? WHERE id = 1`, NOW);
    // The third case, which the routed statement could only express as a
    // `SELECT … FROM workstreams WHERE archived_at IS NULL` that inserted
    // nothing — indistinguishable from the replay above.
    expect(storage.scheduleWakeup(wakeup({
      wakeupId: "wakeup-3",
      idempotencyKey: "receipt-2",
    }))).toEqual({ outcome: "workstream_archived", wakeupId: "wakeup-3" });
    expect(sql.exec(`SELECT COUNT(*) AS n FROM workstream_wakeups`).one().n).toBe(1);
  });

  it("claims a wake-up once, and refuses a claim made on a stale version", () => {
    const { storage, sql } = open();
    storage.scheduleWakeup(wakeup());

    expect(storage.claimDueWakeup({ wakeupId: "wakeup-1", expectedVersion: 1, now: NOW }))
      .toBe(true);
    // The compare-and-swap the routed `WHERE status = 'pending' AND version = ?`
    // spelled out. A second alarm holding the same version it read before the
    // first one won loses, which is what makes a wake-up at-most-once.
    expect(storage.claimDueWakeup({ wakeupId: "wakeup-1", expectedVersion: 1, now: NOW }))
      .toBe(false);
    expect(sql.exec(`SELECT status, version FROM workstream_wakeups`).toArray())
      .toEqual([{ status: "fired", version: 2 }]);

    // And the version is doing work the status cannot. Released, the row is
    // pending again — so a claim is refused here only because the version the
    // caller read is no longer the version the row is on. This is the case the
    // argument exists for: a caller that read the row, did something slow, and
    // came back to claim on a stale understanding.
    storage.releaseClaimedWakeup({ wakeupId: "wakeup-1", now: NOW });
    expect(storage.claimDueWakeup({ wakeupId: "wakeup-1", expectedVersion: 1, now: NOW }))
      .toBe(false);
    expect(storage.claimDueWakeup({ wakeupId: "wakeup-1", expectedVersion: 3, now: NOW }))
      .toBe(true);
  });

  it("releases a claim whose run never started, so the next alarm retries it", () => {
    const { storage, sql } = open();
    storage.scheduleWakeup(wakeup());
    storage.claimDueWakeup({ wakeupId: "wakeup-1", expectedVersion: 1, now: NOW });

    expect(storage.releaseClaimedWakeup({ wakeupId: "wakeup-1", now: NOW })).toBe(true);
    expect(sql.exec(`SELECT status, fired_at FROM workstream_wakeups`).toArray())
      .toEqual([{ status: "pending", fired_at: null }]);
    // Only a claim can be released. A pending row is not a claim this caller
    // holds, and releasing one would resurrect a wake-up somebody cancelled.
    expect(storage.releaseClaimedWakeup({ wakeupId: "wakeup-1", now: NOW })).toBe(false);
  });

  it("separates a wake-up that is already settled from one that is not there", () => {
    const { storage } = open();
    storage.scheduleWakeup(wakeup());

    expect(storage.cancelWakeup({ wakeupId: "wakeup-1", now: NOW })).toBe("cancelled");
    expect(storage.cancelWakeup({ wakeupId: "wakeup-1", now: NOW })).toBe("not_pending");
    expect(storage.cancelWakeup({ wakeupId: "absent", now: NOW })).toBe("not_found");
  });

  it("deletes an unarmed wake-up, and only while it is still pending", () => {
    const { storage, sql } = open();
    storage.scheduleWakeup(wakeup());
    storage.claimDueWakeup({ wakeupId: "wakeup-1", expectedVersion: 1, now: NOW });

    // A fired wake-up has already run; deleting it here would erase the record
    // of work that happened. Only the arming failure this exists for — a row
    // written moments ago and still pending — is removable.
    expect(storage.deleteUnarmedWakeup({ wakeupId: "wakeup-1" })).toBe(false);
    storage.releaseClaimedWakeup({ wakeupId: "wakeup-1", now: NOW });
    expect(storage.deleteUnarmedWakeup({ wakeupId: "wakeup-1" })).toBe(true);
    expect(sql.exec(`SELECT COUNT(*) AS n FROM workstream_wakeups`).one().n).toBe(0);
  });

  it("lists pending wake-ups soonest first, and counts only those", () => {
    const { storage } = open();
    storage.scheduleWakeup(wakeup({ dueAt: NOW + 7_200_000 }));
    storage.scheduleWakeup(wakeup({
      wakeupId: "wakeup-2",
      idempotencyKey: "receipt-2",
      prompt: "Sooner",
      dueAt: NOW + 3_600_000,
    }));
    storage.scheduleWakeup(wakeup({
      wakeupId: "wakeup-3",
      idempotencyKey: "receipt-3",
      prompt: "Cancelled",
      dueAt: NOW + 60_000,
    }));
    storage.cancelWakeup({ wakeupId: "wakeup-3", now: NOW });

    // The sidebar marker and the tool's own listing both read this, so the
    // order is the product's: the next thing that will happen, first. The
    // cancelled row is soonest by due time and must not lead it.
    expect(storage.pendingWakeups({ limit: 20 }).map((row) => row.prompt))
      .toEqual(["Sooner", "Check the deploy"]);
    expect(storage.pendingWakeupCount()).toBe(2);
  });
});

describe("open elicitations", () => {
  const ask = (elicitationId: string, createdAt: number, overrides: Record<string, unknown> = {}) => ({
    elicitation_id: elicitationId,
    run_id: RUN,
    prompt: `Question ${elicitationId}`,
    response_type: "text",
    options_json: "[]",
    minimum_selections: 0,
    maximum_selections: null,
    target_user_id: null,
    status: "pending",
    created_at: createdAt,
    ...overrides,
  });

  function seed(
    sql: ReturnType<typeof createTestSqlStorage>,
    row: ReturnType<typeof ask>,
  ): void {
    sql.exec(
      `INSERT INTO elicitation_requests
         (elicitation_id, run_id, prompt, response_type, options_json, minimum_selections,
          maximum_selections, target_user_id, status, answer_json, answered_by_user_id,
          external_actor_json, created_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
      row.elicitation_id,
      row.run_id,
      row.prompt,
      row.response_type,
      row.options_json,
      row.minimum_selections,
      row.maximum_selections,
      row.target_user_id,
      row.status,
      row.created_at,
    );
  }

  it("answers with the question waiting longest, and ignores answered ones", () => {
    const { storage, sql } = open();
    seed(sql, ask("answered-first", NOW - 120_000, { status: "answered" }));
    seed(sql, ask("waiting-longest", NOW - 60_000));
    seed(sql, ask("newer", NOW));

    // Slack delivers one question at a time, so "the open one" has to be the
    // oldest rather than any open one — otherwise a person answering in a
    // thread answers a different question than the one they were shown.
    expect(storage.oldestOpenElicitation()?.elicitation_id).toBe("waiting-longest");
    expect(storage.openElicitationCount()).toBe(2);
  });

  it("says nothing is waiting once every question is answered", () => {
    const { storage, sql } = open();
    seed(sql, ask("only", NOW, { status: "answered" }));

    // The count is what decides whether answering resumes the run: a work
    // stream with a question still open must not start one, or the harness
    // wakes up to a question it is still blocked on.
    expect(storage.oldestOpenElicitation()).toBeUndefined();
    expect(storage.openElicitationCount()).toBe(0);
  });

  it("finds a replayed question only under the run that asked it", () => {
    const { storage, sql } = open();
    seed(sql, ask("asked", NOW));

    expect(storage.elicitationExistsForRun({ elicitationId: "asked", runId: RUN }))
      .toBe(true);
    // The id is derived from a provider idempotency key, which is scoped to a
    // run. Answering yes for another run's id would let one run's replay check
    // be satisfied by a question it never asked.
    expect(storage.elicitationExistsForRun({
      elicitationId: "asked",
      runId: "00000000-0000-7000-8000-0000000000ff",
    })).toBe(false);
    expect(storage.elicitationExistsForRun({ elicitationId: "never-asked", runId: RUN }))
      .toBe(false);
  });
});

describe("the description-refresh cadence", () => {
  const claim = (evaluatedAt: number, restUntil: number) => ({
    evaluatedAt,
    restUntil,
    evaluatedThroughSequence: 10,
    windowMessageCount: 4,
  });

  it("admits one evaluation per rest, and carries the keep count across claims", () => {
    const { storage } = open();

    expect(storage.claimDescriptionEvaluation(claim(NOW, NOW + 21_600_000)))
      .toEqual({ version: 1, consecutiveKeeps: 0 });
    // The floor is what stops two runs terminalizing together from both
    // spending an inference call, and what stops a failing model being retried
    // by every run behind it. It is written before the model is called, not
    // after, so a second claimant inside the rest is refused rather than
    // queued.
    expect(storage.claimDescriptionEvaluation(claim(NOW + 60_000, NOW + 21_660_000)))
      .toBeNull();

    storage.recordDescriptionOutcome({
      expectedVersion: 1,
      decision: "kept",
      rejectionCode: null,
      confidence: 0.9,
      model: "a-model",
      previousDescription: "before",
      description: null,
      reasoning: "unchanged",
      windowMessageCount: 4,
      consecutiveKeeps: 1,
      restUntil: NOW + 43_200_000,
      now: NOW,
    });

    // Past the rest, the next claim lands — and inherits the keep count rather
    // than zeroing it. The routed statement kept that by omitting the column so
    // the trigger saw NULL and preserved the standing value; a claim that reset
    // it would restart the backoff on every evaluation and the ratchet would
    // never climb.
    expect(storage.claimDescriptionEvaluation(claim(NOW + 43_200_001, NOW + 64_800_000)))
      .toEqual({ version: 2, consecutiveKeeps: 1 });
  });

  it("clears the last evaluation's decision when the next claim lands", () => {
    const { storage, sql } = open();
    storage.claimDescriptionEvaluation(claim(NOW, NOW + 21_600_000));
    storage.recordDescriptionOutcome({
      expectedVersion: 1,
      decision: "rewritten",
      rejectionCode: null,
      confidence: 0.95,
      model: "a-model",
      previousDescription: "before",
      description: "Track the 3-D Secure migration",
      reasoning: "the work moved",
      windowMessageCount: 4,
      consecutiveKeeps: 0,
      restUntil: NOW + 43_200_000,
      now: NOW,
    });

    storage.claimDescriptionEvaluation(claim(NOW + 43_200_001, NOW + 64_800_000));

    // The retired trigger's conflict arm set these five from `excluded.*`, and
    // the routed claim omitted them from its column list, so a claim wiped
    // them. Carrying them instead would leave `decision = 'pending'` beside a
    // closed evaluation's answer — a row that reads as current and never
    // existed in production. An evaluation that dies between claiming and
    // recording is the window where the difference shows.
    expect(sql.exec(
      `SELECT decision, confidence, model, previous_description, description, reasoning
         FROM description_refresh_state WHERE id = 1`,
    ).toArray()).toEqual([{
      decision: "pending",
      confidence: null,
      model: null,
      previous_description: null,
      description: null,
      reasoning: null,
    }]);
  });

  it("refuses an outcome from an evaluation the row has moved past", () => {
    const { storage, sql } = open();
    const first = storage.claimDescriptionEvaluation(claim(NOW, NOW + 21_600_000))!;
    // A person edited the description, or a later run claimed, while this
    // evaluation was still waiting on its model.
    storage.claimDescriptionEvaluation(claim(NOW + 21_600_001, NOW + 43_200_000));

    const outcome = {
      decision: "rewritten",
      rejectionCode: null,
      confidence: 0.95,
      model: "a-model",
      previousDescription: "before",
      description: "the slow evaluation's answer",
      reasoning: "the work moved",
      windowMessageCount: 4,
      consecutiveKeeps: 0,
      restUntil: NOW + 21_600_000,
      now: NOW + 30_000_000,
    };
    expect(storage.recordDescriptionOutcome({ ...outcome, expectedVersion: first.version }))
      .toBe(false);
    // Nothing written: the write that superseded it owns the row, and the rest
    // it set must not be pulled back by a decision made against a state that no
    // longer holds.
    expect(sql.exec(`SELECT decision, description FROM description_refresh_state`).toArray())
      .toEqual([{ decision: "pending", description: null }]);

    expect(storage.recordDescriptionOutcome({ ...outcome, expectedVersion: 2 })).toBe(true);
    expect(sql.exec(`SELECT decision, description FROM description_refresh_state`).toArray())
      .toEqual([{ decision: "rewritten", description: "the slow evaluation's answer" }]);
  });
});

describe("plugin activation hints", () => {
  it("keeps the first activation instant and moves only the last authorization", () => {
    const { storage, sql } = open();

    storage.recordPluginActivation({ pluginId: "linear", now: NOW });
    storage.recordPluginActivation({ pluginId: "linear", now: NOW + 60_000 });

    // `activated_at` is when this work stream first reached for the plugin, and
    // a later authorization must not rewrite that history; `last_authorized_at`
    // is the one that moves. The retired trigger wrote exactly this, and the
    // caller's own `ON CONFLICT(workstream_id, plugin_id)` clause never ran —
    // the view had no unique index for it to name.
    expect(sql.exec(`SELECT plugin_id, activated_at, last_authorized_at
                       FROM plugin_activation_hints`).toArray()).toEqual([
      { plugin_id: "linear", activated_at: NOW, last_authorized_at: NOW + 60_000 },
    ]);
  });

  it("answers every hint it holds, leaving eligibility to the caller", () => {
    const { storage } = open();
    storage.recordPluginActivation({ pluginId: "slack", now: NOW });
    storage.recordPluginActivation({ pluginId: "linear", now: NOW });

    // A hint is not an authorization. This returns both, and the run's own
    // eligible set is what discards one — a plugin the run may not load is
    // refused where the run scope is known, not here.
    expect(storage.activationHints()).toEqual(["linear", "slack"]);
  });
});
