/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The agent run lifecycle, exercised through the object's real entry points on
 * workerd.
 *
 * These are behavioural: each one states something a member or an operator can
 * observe — a run starts, a duplicate does not run twice, a wedged work stream
 * heals — and asserts it against real alarms, real SQLite, and real eviction.
 * The unit suites cover the SQL in isolation; what they cannot cover is the
 * interaction that actually broke production, where an in-memory flag, a real
 * alarm, and a cancelled invocation combined into a permanent stall that no
 * single layer could see.
 *
 * Runs here fail at the model call, because the test worker has no provider
 * credentials. That is deliberate and does not weaken the suite: every property
 * under test concerns admission, scheduling, recovery, and settlement, all of
 * which happen either side of inference.
 */

import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { SubstreamAgent } from "../src/durable-objects/substream-agent";

import { asSubstreamId } from "@rally/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  USER_ID,
  boot,
  dispatches,
  post,
  runInput,
  runStatus,
  seedOpenWorkstreamAuthority,
  seedRun,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members
      (workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-20T00:00:00.000Z')
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = 'active'`)
      .bind(WORKSPACE_ID, USER_ID),
  ]);
});

let unique = 0;
/**
 * A fresh object per test: this file never calls `reset()`, so a reused id would
 * carry the last test's rows. The counter is module-level for that reason — one
 * per `describe` would restart at the same ids in every block.
 */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`)),
  ));
}

/**
 * Dispatch a run and park the alarm it arms, in one invocation.
 *
 * `enqueueAgentRun` arms `now + 1` deliberately, so that a queued run is never
 * stranded by an isolate that dies before it drains. A test that wants to
 * observe the queue *before* the executor touches it therefore has to park that
 * alarm without letting the object's input gate open in between — two separate
 * calls leave a window in which the drain starts, fails the seeded run against
 * this fixture's bare D1, and turns the assertion into a coin flip.
 */
async function dispatchWithoutDraining(stub: DurableObjectStub, runId: string): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    // The stub is untyped here, so the object's own `fetch` is optional on the
    // base type; this file drives one class and that class defines it.
    await (instance as SubstreamAgent).fetch(new Request("https://object.test/internal/run-dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runInput(runId)),
    }));
    await state.storage.setAlarm(Date.now() + 600_000);
  });
}

async function readyAgent(): Promise<DurableObjectStub> {
  const stub = agent();
  await boot(stub);
  await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
  return stub;
}

/**
 * The invariant, in the only form that is race-free: the executor may
 * legitimately finish a run between two assertions, so the claim is not "an
 * alarm exists" but "an alarm exists unless the work is done".
 */
async function expectScheduledUnlessFinished(
  stub: DurableObjectStub,
  label: string,
): Promise<void> {
  let lastObserved: { alarm: number | null; outstanding: boolean; rows: string } | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    lastObserved = await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      const outstanding = dispatches(state)
        .some((row) => row.state === "queued" || row.state === "running");
      return { alarm, outstanding, rows: JSON.stringify(dispatches(state)) };
    });
    if (!lastObserved.outstanding) return;
    if (lastObserved.alarm !== null) {
      expect(lastObserved.alarm, `${label} slept past the sweep interval`)
        .toBeLessThanOrEqual(Date.now() + 60_000);
      return;
    }
    // A due alarm can be consumed between the SQL and alarm reads. Give that
    // serialized callback a bounded chance to either finish or re-arm.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(lastObserved?.alarm, `${label} left outstanding work with no wake-up: ${lastObserved?.rows}`)
    .not.toBeNull();
}

const RUN_A = "00000000-0000-7000-8000-0000000004b1";
const RUN_B = "00000000-0000-7000-8000-0000000004b2";

describe("admitting a run dispatch", () => {
  it("accepts a dispatch and schedules the object to execute it", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => seedRun(state, RUN_A));

    const response = await post(stub, "/internal/run-dispatch", runInput(RUN_A));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: true });
    await runInDurableObject(stub, (_instance, state) => {
      expect(dispatches(state)).toHaveLength(1);
    });
    // Admission that does not schedule is the whole class of bug this
    // subsystem exists to prevent.
    await expectScheduledUnlessFinished(stub, "an accepted dispatch");
  });

  it("admits a repeated dispatch of the same run only once", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => seedRun(state, RUN_A));

    const first = await post(stub, "/internal/run-dispatch", runInput(RUN_A));
    const repeat = await post(stub, "/internal/run-dispatch", runInput(RUN_A));

    // Both must be accepted. A caller that retries because it never saw the
    // first response has to be able to stop retrying, so the redelivery is
    // absorbed rather than rejected — and it must not become a second run.
    expect(first.status).toBe(202);
    expect(repeat.status).toBe(202);
    await runInDurableObject(stub, (_instance, state) => {
      expect(dispatches(state)).toHaveLength(1);
    });
  });

  it("refuses a dispatch addressed to a different work stream", async () => {
    const stub = await readyAgent();

    const response = await post(stub, "/internal/run-dispatch", runInput(RUN_A, {
      workstreamId: "00000000-0000-7000-8000-0000000004ff",
    }));

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "substream_run_identity_mismatch" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(dispatches(state)).toHaveLength(0);
    });
  });

  it("refuses a block dashboard run, which belongs to its own agent", async () => {
    const stub = await readyAgent();

    const response = await post(stub, "/internal/run-dispatch", runInput(RUN_A, {
      reason: "block_dashboard_block",
    }));

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "block_dashboard_runs_require_block_agent" });
  });

  it("refuses a dispatch it cannot validate rather than storing it", async () => {
    const stub = await readyAgent();

    const response = await post(stub, "/internal/run-dispatch", { nonsense: true });

    expect(response.status).toBe(400);
    await runInDurableObject(stub, (_instance, state) => {
      expect(dispatches(state)).toHaveLength(0);
    });
  });
});

describe("executing an admitted run", () => {
  it("starts the run and settles the dispatch", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => seedRun(state, RUN_A));
    await dispatchWithoutDraining(stub, RUN_A);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const [row] = dispatches(state);
      expect(row!.attempt).toBeGreaterThan(0);
      expect(row!.started_at).not.toBeNull();
      // The run left `admitted`: the object took ownership of it.
      expect(runStatus(state, RUN_A)).not.toBe("admitted");
    });
  });

  it("releases the lease on whatever outcome the run reaches", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => seedRun(state, RUN_A));
    await dispatchWithoutDraining(stub, RUN_A);

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, (_instance, state) => {
      const [row] = dispatches(state);
      // A lease outliving its run is what makes a successor wait for nothing.
      expect(row!.lease_token).toBeNull();
      expect(row!.lease_expires_at).toBeNull();
    });
  });

  it("takes the older of two queued runs first", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => {
      seedRun(state, RUN_A);
      seedRun(state, RUN_B);
    });
    await dispatchWithoutDraining(stub, RUN_A);
    await dispatchWithoutDraining(stub, RUN_B);

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, (_instance, state) => {
      const rows = dispatches(state);
      const first = rows.find((row) => row.run_id === RUN_A)!;
      expect(first.attempt).toBeGreaterThan(0);
    });
  });
});

describe("a work stream wedged by an earlier build", () => {
  const PHANTOM = "00000000-0000-7000-8000-0000000004c1";

  // The production incident, end to end and through the real endpoint: a run
  // imported mid-cutover holds the substream's one mutating slot, so every
  // later run fails as it starts and the work stream reads as permanently busy.
  it("heals on the next message rather than needing an operator", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => {
      seedRun(state, PHANTOM, "running");
      seedRun(state, RUN_A);
    });

    await post(stub, "/internal/run-dispatch", runInput(RUN_A));
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 600_000));
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, (_instance, state) => {
      expect(runStatus(state, PHANTOM)).toBe("failed");
      expect(runStatus(state, RUN_A)).not.toBe("admitted");
    });
  });

  // A crash between a run's commit and its dispatch insert leaves an admitted
  // run nothing will ever execute. It does not hold the mutating slot, but the
  // member sees it "Scheduled" forever — so once its grace lapses it is reaped
  // like any other abandoned run.
  it("reaps an admitted run whose dispatch never landed, after its grace", async () => {
    const stub = await readyAgent();
    const ORPHAN = "00000000-0000-7000-8000-0000000004d1";
    await runInDurableObject(stub, (_instance, state) => {
      seedRun(state, ORPHAN);
      state.storage.sql.exec(
        `UPDATE runs SET updated_at = ? WHERE run_id = ?`,
        Date.now() - 5 * 60_000,
        ORPHAN,
      );
      seedRun(state, RUN_A);
    });
    await post(stub, "/internal/run-dispatch", runInput(RUN_A));
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 600_000));

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, (_instance, state) => {
      expect(runStatus(state, ORPHAN)).toBe("failed");
    });
  });

  it("leaves a freshly admitted run alone while its dispatch is still being written", async () => {
    const stub = await readyAgent();
    const FRESH = "00000000-0000-7000-8000-0000000004d2";
    await runInDurableObject(stub, (_instance, state) => {
      seedRun(state, FRESH, "admitted", Date.now());
      seedRun(state, RUN_A, "admitted", Date.now());
    });
    await dispatchWithoutDraining(stub, RUN_A);

    await runInDurableObject(stub, (instance, state) => {
      const product = (instance as unknown as {
        product: { reapAbandonedSubstreamRuns(substreamId: string, now: number): string[] };
      }).product;
      expect(product.reapAbandonedSubstreamRuns("0", Date.now())).toEqual([]);
      expect(runStatus(state, FRESH)).toBe("admitted");
    });
  });

  it("does not disturb a run that still has a dispatch behind it", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => {
      seedRun(state, RUN_B, "running");
      seedRun(state, RUN_A, "admitted", Date.now());
    });
    // RUN_B is mid-flight with work still prepared for it, so it is not
    // abandoned however long it has held the slot.
    await dispatchWithoutDraining(stub, RUN_B);

    await runInDurableObject(stub, (instance, state) => {
      const product = (instance as unknown as {
        product: { reapAbandonedSubstreamRuns(substreamId: string, now: number): string[] };
      }).product;
      expect(product.reapAbandonedSubstreamRuns("0", Date.now())).toEqual([]);
      expect(runStatus(state, RUN_B)).toBe("running");
    });
  });
});

describe("surviving the runtime", () => {
  it("resumes an admitted run after the object is evicted before it starts", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => seedRun(state, RUN_A));
    await post(stub, "/internal/run-dispatch", runInput(RUN_A));

    await evictDurableObject(stub);
    await boot(stub);

    await runInDurableObject(stub, (_instance, state) => {
      expect(dispatches(state)).toHaveLength(1);
    });
    // The new isolate inherits nothing in memory. Only the rows carry the run,
    // and they must be enough to schedule it.
    await expectScheduledUnlessFinished(stub, "a run that survived eviction");
  });

  it("never leaves an outstanding run without a wake-up, whatever its shape", async () => {
    // Every shape is parked in the future. A row that is *due* would be
    // executed by the alarm the constructor arms, and `getAlarm()` reads null
    // while a handler is mid-delivery — so a due row tests the executor's
    // timing rather than the property. The due path is covered deterministically
    // by the `runDurableObjectAlarm` tests above.
    const parked = Date.now() + 60 * 60_000;
    const shapes = [
      { name: "queued", state: "queued", availableAt: parked, lease: null },
      { name: "claimed with a live lease", state: "running", availableAt: parked, lease: Date.now() + 6e5 },
      { name: "claimed with a lapsed lease", state: "running", availableAt: parked, lease: Date.now() - 1 },
      { name: "claimed with no lease at all", state: "running", availableAt: parked, lease: null },
    ] as const;

    for (const shape of shapes) {
      const stub = await readyAgent();
      await runInDurableObject(stub, async (_instance, state) => {
        seedRun(state, RUN_A);
        state.storage.sql.exec(
          `INSERT INTO agent_run_dispatches
             (run_id, input_json, state, attempt, available_at, started_at,
              lease_token, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, 1, ?, ?, 1, 1)`,
          RUN_A,
          JSON.stringify(runInput(RUN_A)),
          shape.state,
          shape.availableAt,
          shape.lease === null ? null : "held",
          shape.lease,
        );
        await state.storage.deleteAlarm();
      });

      await evictDurableObject(stub);
      await boot(stub);

      await expectScheduledUnlessFinished(stub, shape.name);
    }
  });

  it("stops waking for a run that has already finished", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, async (_instance, state) => {
      seedRun(state, RUN_A);
      state.storage.sql.exec(
        `INSERT INTO agent_run_dispatches
           (run_id, input_json, state, attempt, available_at, started_at, completed_at,
            created_at, updated_at)
         VALUES (?, ?, 'completed', 1, 1, 1, 1, 1, 1)`,
        RUN_A,
        JSON.stringify(runInput(RUN_A)),
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      // An object that keeps waking with nothing to do bills for nothing.
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe("waking for reasons other than a run", () => {
  it("schedules for a pending agent timer", async () => {
    const stub = await readyAgent();
    const dueAt = Date.now() + 5 * 60_000;
    await runInDurableObject(stub, async (_instance, state) => {
      seedRun(state, RUN_A);
      state.storage.sql.exec(
        `INSERT INTO workstream_wakeups
           (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
            status, idempotency_key, version, created_at, updated_at)
         VALUES ('wake-1', ?, '{"type":"system"}', 'follow up', ?, 'pending', 'k1', 1, 1, 1)`,
        RUN_A,
        dueAt,
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(dueAt);
  });

  it("prefers the soonest reason when several are outstanding", async () => {
    const stub = await readyAgent();
    const timerAt = Date.now() + 30 * 60_000;
    await runInDurableObject(stub, async (_instance, state) => {
      seedRun(state, RUN_A);
      state.storage.sql.exec(
        `INSERT INTO workstream_wakeups
           (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
            status, idempotency_key, version, created_at, updated_at)
         VALUES ('wake-2', ?, '{"type":"system"}', 'later', ?, 'pending', 'k2', 1, 1, 1)`,
        RUN_A,
        timerAt,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_run_dispatches
           (run_id, input_json, state, attempt, available_at, started_at, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, ?, NULL, 1, 1)`,
        RUN_A,
        JSON.stringify(runInput(RUN_A)),
        Date.now() + 5 * 60_000,
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    // The due run outranks the timer half an hour out.
    expect(alarm!).toBeLessThan(timerAt);
  });
});
