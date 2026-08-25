/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable scheduling authority, on real workerd.
 *
 * The Node suite proves what the SQL decides. This proves what the *runtime*
 * decides, and for wake-ups that is most of the behaviour: that a mutating
 * operation commits its row, its sidebar projection and its alarm index
 * together, that the object's own alarm index tracks the table without any
 * caller maintaining it, and that a misrouted stub is refused before it can
 * claim another work stream's wake-up. None of those is observable over
 * `node:sqlite`.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { asSubstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

const RUN = "00000000-0000-7000-8000-00000000sc01";

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    ),
  ));
}

/** Call the real endpoint, exactly as the Worker's port does. */
async function scheduling(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<{ status: number; value: unknown; error?: string }> {
  const { status, body } = await post(stub, "/internal/scheduling", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  const parsed = body as { value?: unknown; error?: string } | null;
  return { status, value: parsed?.value ?? null, ...(parsed?.error ? { error: parsed.error } : {}) };
}

function seedRun(state: DurableObjectState): void {
  state.storage.sql.exec(
    `INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
       model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
       active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
       tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
       created_at, updated_at)
     VALUES (?,'0','running','{}',0,0,'',0,0,1,0,0,0,0,0,0,0,0,0,0,1,1)`,
    RUN,
  );
}

const ELICITATION = "00000000-0000-7000-8000-0000000000el";
const ACTOR = JSON.stringify({
  provider: "slack",
  providerAccountId: "T123",
  providerUserId: "U456",
  displayName: "Taylor",
  avatarUrl: null,
});

function elicitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    elicitationId: ELICITATION,
    runId: RUN,
    prompt: "Which environment?",
    responseType: "text",
    optionsJson: "[]",
    minimumSelections: 0,
    maximumSelections: null,
    targetUserId: null,
    messageId: "00000000-0000-7000-8000-0000000000m1",
    structuredContentJson: JSON.stringify({ kind: "elicitation" }),
    now: 2,
    ...overrides,
  };
}

function answer(clientMessageId: string): Record<string, unknown> {
  return {
    elicitationId: ELICITATION,
    answerJson: JSON.stringify("staging"),
    externalActorJson: ACTOR,
    messageId: `00000000-0000-7000-8000-${clientMessageId.slice(-8).padStart(12, "0")}`,
    clientMessageId,
    structuredContentJson: JSON.stringify({ kind: "elicitation_response" }),
    now: 3,
  };
}

function wakeup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wakeupId: "00000000-0000-7000-8000-00000000wk01",
    createdByRunId: RUN,
    executionPrincipalJson: JSON.stringify({ type: "workspace", workspaceId: WORKSPACE_ID }),
    prompt: "Check the deploy",
    dueAt: Date.now() + 3_600_000,
    idempotencyKey: "receipt-1",
    now: Date.now(),
    ...overrides,
  };
}

describe("scheduling authority on real workerd", () => {
  it("commits the wake-up, its projection and its alarm entry in one step", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });

    const result = await scheduling(stub, "scheduleWakeup", wakeup());

    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ outcome: "scheduled" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT status FROM workstream_wakeups`).toArray())
        .toEqual([{ status: "pending" }]);
      // The sidebar's next-wake-up marker is a projection of this table, and it
      // used to be republished because the object matched `workstream_wakeups`
      // in routed statement text. Running the operation inside the same commit
      // is what replaces that — and this is the assertion that would catch its
      // loss, which the conversion itself could not.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM projection_keys WHERE projection_key = 'common'`,
      ).one().count).toBe(1);
      // And the alarm index, which nothing outside the object maintains.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = 'agent_timer'`,
      ).one().count).toBe(1);
    });
  });

  it("republishes the sidebar projection when a wake-up is claimed", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });
    await scheduling(stub, "scheduleWakeup", wakeup());
    const before = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ next_version: number }>(
        `SELECT next_version FROM projection_keys WHERE projection_key = 'common'`,
      ).one().next_version);

    const claimed = await scheduling(stub, "claimDueWakeup", {
      wakeupId: "00000000-0000-7000-8000-00000000wk01",
      expectedVersion: 1,
      now: Date.now(),
    });

    // The sidebar's next-wake-up marker is derived from `status = 'pending'`,
    // so a claim invalidates it: the wake-up it advertises has just fired.
    // Every wake-up write has to reach this endpoint for that republish to
    // happen — including the object's own alarm, which is the one writer that
    // could have taken the in-isolate seam and skipped it.
    expect(claimed.value).toBe(true);
    const after = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ next_version: number }>(
        `SELECT next_version FROM projection_keys WHERE projection_key = 'common'`,
      ).one().next_version);
    expect(after).toBeGreaterThan(before);
  });

  it("takes the alarm entry back out when the wake-up is cancelled", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });
    await scheduling(stub, "scheduleWakeup", wakeup());
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = 'agent_timer'`,
      ).one().count).toBe(1);
    });

    const cancelled = await scheduling(stub, "cancelWakeup", {
      wakeupId: "00000000-0000-7000-8000-00000000wk01",
      now: Date.now(),
    });

    expect(cancelled.value).toBe("cancelled");
    // A cancelled wake-up that keeps its alarm entry wakes the object for work
    // nobody asked for. The index reconciles against the table on every
    // mutating operation, so the entry goes out with the row's status.
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = 'agent_timer'`,
      ).one().count).toBe(0);
    });
  });

  it("clears the alarm entry when an unarmed wake-up is rolled back", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });
    await scheduling(stub, "scheduleWakeup", wakeup());
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = 'agent_timer'`,
      ).one().count).toBe(1);
    });

    const deleted = await scheduling(stub, "deleteUnarmedWakeup", {
      wakeupId: "00000000-0000-7000-8000-00000000wk01",
    });

    // The rollback path, which is the one the routed conversion nearly lost:
    // it is the only wake-up write with no `refreshAgentTimerAlarm` beside it,
    // because it used to be a routed `DELETE` and the object noticed the table
    // name. Nothing notices statement text any more.
    expect(deleted.value).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = 'agent_timer'`,
      ).one().count).toBe(0);
    });
  });

  it("answers a read from its own table without moving the index or the projection", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });
    await scheduling(stub, "scheduleWakeup", wakeup());
    await scheduling(stub, "recordPluginActivation", { pluginId: "a-plugin", now: 1 });
    const before = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ next_version: number }>(
        `SELECT next_version FROM projection_keys WHERE projection_key = 'common'`,
      ).one().next_version);

    const hints = await scheduling(stub, "activationHints");

    // What this proves is that the read answers from its own table and moves
    // nothing — not that a read cannot be misclassified. Adding
    // `activationHints` to `WAKEUP_MUTATIONS` leaves every assertion here
    // green, and that is a fact about the system rather than a hole in the
    // test: `commitWithRegionalEffects` compares the effect's payload hash
    // against `projection_keys.last_payload_hash` and skips an identical one,
    // so a read that changes nothing publishes nothing, and reconciling the
    // alarm index against an unchanged table lands on the number it started
    // from. Misclassifying a read costs a transaction and a reconcile, and the
    // suite has no way to see it because there is nothing to see.
    //
    // The direction that does damage is the other one — a mutation *missing*
    // from the set stops arming — and it is covered: emptying `WAKEUP_MUTATIONS`
    // fails the four specs above.
    //
    // The hint is seeded rather than left absent so the returned array is the
    // row this work stream wrote. An assertion of `[]` against a table nobody
    // populated passes for a query that reads the wrong table entirely, which
    // is what this assertion was before.
    expect(hints.value).toEqual(["a-plugin"]);
    const after = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ next_version: number }>(
        `SELECT next_version FROM projection_keys WHERE projection_key = 'common'`,
      ).one().next_version);
    expect(after).toBe(before);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = 'agent_timer'`,
      ).one().count).toBe(1);
    });
  });

  it("refuses a request routed to the wrong work stream", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/scheduling", {
      workspaceId: WORKSPACE_ID,
      workstreamId: "00000000-0000-7000-8000-0000000000ff",
      operation: "scheduleWakeup",
      args: [wakeup()],
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_scheduling_identity_mismatch" });
  });

  it("refuses a write against an object that is no longer the authority", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec(`UPDATE workstream SET authority_mode = 'quarantined' WHERE id = 1`);
    });

    // `persistCompactionCheckpoint` is the review's example, and the one this
    // slice moved: it is a write whose only fence was the routed path's
    // `authority_mode` check, and unlike the wake-up mutations it does not
    // reach `commitRuntimeMutation` to pick an equivalent one up by accident.
    const { status, body } = await post(stub, "/internal/scheduling", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "persistCompactionCheckpoint",
      args: [{
        executionPrincipalKey: "user:someone",
        resourceVisibilityFingerprint: "fingerprint",
        checkpointTemplateVersion: 1,
        runId: RUN,
        compactedThroughSequence: 4,
        messagesJson: "[]",
        summary: "A summary nobody should be able to persist here.",
        model: "a-model",
        contextTokensBeforeCompaction: 100,
        contextWindowTokens: 1000,
        inputTokens: 10,
        outputTokens: 20,
        costMicros: 30,
        expectedInventoryRevision: 0,
        now: 1,
      }],
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_runtime_authority_fenced" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM compaction_checkpoints`,
      ).one().count).toBe(0);
    });
  });

  it("refuses a write against an authoritative object that was never promoted", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec(`UPDATE workstream SET authority_generation = 0 WHERE id = 1`);
    });

    // The routed fence was two checks in two places: `executeWorkstreamRuntimeSql`
    // refused a non-authoritative mode, and it then ran *every* batch through
    // `commitRuntimeMutation`, whose `commitWithRegionalEffects` refuses
    // generation zero. A port that kept only the mode check would let this
    // write land where the statement it replaced was refused.
    const { status, body } = await post(stub, "/internal/scheduling", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "recordPluginActivation",
      args: [{ pluginId: "a-plugin", now: 1 }],
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_runtime_authority_fenced" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM plugin_activation_hints`,
      ).one().count).toBe(0);
    });
  });

  it("writes the question, its transcript part and needs_input in one step", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });

    const opened = await scheduling(stub, "openElicitation", elicitation());

    expect(opened.value).toEqual({ outcome: "opened", sequenceNumber: 1 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT status, run_id FROM elicitation_requests`,
      ).toArray()).toEqual([{ status: "pending", run_id: RUN }]);
      // The part and the counters it consumed. The routed batch numbered the
      // part from a subquery and then fenced its own counter update on having
      // taken that number; here one transaction does both, so the part's
      // sequence and the root's next one cannot disagree.
      expect(state.storage.sql.exec(
        `SELECT sequence_number, attention_ordinal, author_type, message_type
           FROM parts WHERE client_message_id = 'elicitation:' || ?`,
        ELICITATION,
      ).toArray()).toEqual([{
        sequence_number: 1,
        attention_ordinal: 1,
        author_type: "agent",
        message_type: "elicitation",
      }]);
      expect(state.storage.sql.exec(
        `SELECT exact_state, state_reason_code, next_sequence_number, next_attention_ordinal
           FROM workstream WHERE id = 1`,
      ).one()).toMatchObject({
        exact_state: "needs_input",
        state_reason_code: "runtime_needs_input",
        next_sequence_number: 2,
        next_attention_ordinal: 2,
      });
    });
  });

  it("answers a question once, and tells the loser of the race that it lost", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });
    await scheduling(stub, "openElicitation", elicitation());

    const first = await scheduling(stub, "answerElicitationExternally", answer("event:first"));
    const second = await scheduling(stub, "answerElicitationExternally", answer("event:second"));

    // The routed update fenced on `status = 'open'` and the caller read
    // `meta.changes` to learn whether it had won. Losing is an ordinary
    // outcome — somebody else answered first — and the second attempt must
    // leave both the row and the transcript exactly as the winner left them.
    expect(first.value).toEqual({ outcome: "answered", sequenceNumber: 2 });
    expect(second.value).toEqual({ outcome: "already_answered", sequenceNumber: null });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT status, answer_json, external_actor_json FROM elicitation_requests`,
      ).toArray()).toEqual([{
        status: "answered",
        answer_json: JSON.stringify("staging"),
        external_actor_json: ACTOR,
      }]);
      expect(state.storage.sql.exec(
        `SELECT client_message_id FROM parts WHERE message_type = 'elicitation'
          ORDER BY sequence_number`,
      ).toArray()).toEqual([
        { client_message_id: `elicitation:${ELICITATION}` },
        { client_message_id: "event:first" },
      ]);
    });
  });

  it("refuses an operation that is not on the contract", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/scheduling", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "dropEverything",
      args: [],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_scheduling_operation" });
  });
});
