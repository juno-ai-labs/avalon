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

  it("leaves the alarm index alone for an operation that reads", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state);
    });
    await scheduling(stub, "scheduleWakeup", wakeup());

    const hints = await scheduling(stub, "activationHints");

    // Reads do not reconcile, do not arm, and do not republish. The set of
    // mutating operations is named in the protocol rather than inferred, so a
    // read cannot accidentally join it.
    expect(hints.value).toEqual([]);
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
