/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Behavioural proof that a dispatched agent run is never orphaned.
 *
 * These run on workerd through `@cloudflare/vitest-pool-workers`, so the
 * alarms, the SQLite storage, and the eviction below are the real ones rather
 * than doubles. That matters here more than usual: the defect these tests exist
 * for was invisible to every unit test because it lived in the interaction
 * between an in-memory flag, a real alarm being deleted, and a real invocation
 * being cancelled. Only the runtime can show that.
 *
 * The invariant under test is one sentence:
 *
 *   **If a dispatch row is non-terminal, an alarm is armed.**
 *
 * Everything else — leases, claims, sweep floors — is machinery in service of
 * it. Each test therefore ends by asserting the invariant directly rather than
 * asserting that some particular mechanism fired.
 */

import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { asBlockId, asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { blockDashboardAgentName, substreamAgentName } from "../src/durable-objects/names";
import { seedOpenWorkstreamAuthority, seedWorkstreamRoot } from "./helpers/substream-fixture";

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000002a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000002a2");
const USER_ID = "00000000-0000-7000-8000-0000000002a4";

interface DispatchRow extends Record<string, SqlStorageValue> {
  run_id: string;
  state: string;
  attempt: number;
  available_at: number;
  started_at: number | null;
  lease_token: string | null;
  lease_expires_at: number | null;
}

let unique = 0;
/**
 * A fresh object per test: this file never calls `reset()`, so a reused id would
 * carry the last test's dispatch rows. Both factories share one module-level
 * counter for that reason — one per `describe` would collide across blocks.
 */
function substreamStub(): DurableObjectStub {
  unique += 1;
  const name = substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`));
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(name));
}

function blockStub(): DurableObjectStub {
  unique += 1;
  const name = blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, asBlockId(`00000000-0000-7000-8000-${String(unique).padStart(11, "0")}1`));
  return env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(name));
}

async function boot(stub: DurableObjectStub, path: string): Promise<void> {
  const response = await stub.fetch(path);
  await response.clone().arrayBuffer();
}

async function activeDrainHeartbeatOutcome(
  stub: DurableObjectStub,
  release: () => void,
): Promise<"returned" | "joined"> {
  return runInDurableObject(stub, async (instance) => {
    const heartbeatDrain = (instance as unknown as {
      drainRunsToCompletion(): Promise<"drained" | "deferred">;
    }).drainRunsToCompletion();
    let returned = false;
    void heartbeatDrain.then(() => { returned = true; });
    // Stay in one object event: provider scheduling latency cannot turn this
    // behavior assertion into a machine-speed race.
    await Promise.resolve();
    await Promise.resolve();
    const joined = !returned;
    if (joined) release();
    await heartbeatDrain;
    return joined ? "joined" : "returned";
  });
}

/** Writes the rows a dispatch needs, without going through the product API. */
function seedSubstreamDispatch(
  state: DurableObjectState,
  runId: string,
  row: {
    state?: string;
    availableAt?: number;
    startedAt?: number | null;
    leaseToken?: string | null;
    leaseExpiresAt?: number | null;
  } = {},
): void {
  // Dispatch execution mutates the authoritative product row. Scheduling-only
  // assertions used to pass without it, masking failures behind the exact
  // production authority gate that this real-worker suite is meant to prove.
  seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
  state.storage.sql.exec(
    `INSERT INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  state.storage.sql.exec(
    `INSERT INTO runs (
       run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
       model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
       active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
       tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
       created_at, updated_at
     ) VALUES (?, '0', NULL, 'admitted', '{}', 0, 0, '', 0, 0, 1,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
    runId,
  );
  state.storage.sql.exec(
    `INSERT INTO agent_run_dispatches
       (run_id, input_json, state, attempt, available_at, started_at,
        lease_token, lease_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, 1)`,
    runId,
    JSON.stringify({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: runId,
      substreamId: "0",
      region: "global",
      triggerMessageId: null,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    }),
    row.state ?? "queued",
    row.availableAt ?? 1,
    row.startedAt ?? null,
    row.leaseToken ?? null,
    row.leaseExpiresAt ?? null,
  );
}

function dispatchRow(state: DurableObjectState, runId: string): DispatchRow | undefined {
  return state.storage.sql.exec<DispatchRow>(
    `SELECT run_id, state, attempt, available_at, started_at, lease_token, lease_expires_at
       FROM agent_run_dispatches WHERE run_id = ?`,
    runId,
  ).toArray()[0];
}

const RUN_ID = "00000000-0000-7000-8000-0000000002b1";

/** The whole point: a non-terminal row implies a scheduled wake-up. */
function assertInvariant(row: DispatchRow, alarm: number | null): boolean {
  const outstanding = row.state === "queued" || row.state === "running";
  return !outstanding || alarm !== null;
}

describe("a dispatched agent run is never orphaned", () => {
  it("arms an alarm for a queued run and keeps one armed after the run is claimed", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID);
      await state.storage.setAlarm(Date.now() + 600_000);
    });

    // The alarm handler claims the run and, whatever it then decides, must
    // leave the object woken again while the row is non-terminal.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      const row = dispatchRow(state, RUN_ID)!;
      expect(row.attempt).toBeGreaterThan(0);
      expect(row.started_at).not.toBeNull();
      expect(assertInvariant(row, await state.storage.getAlarm())).toBe(true);
    });
  });

  // The production stall, reproduced through the runtime: a claim whose owner
  // is gone. Nothing in the object knows the owner died; only the rows do.
  it("recovers a run whose owner vanished mid-flight", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID, {
        state: "running",
        startedAt: 1,
        // Held off the executor so the recovery *scheduling* is observable on
        // its own; the reclaim itself is asserted below.
        availableAt: Date.now() + 60 * 60_000,
        leaseToken: "owner-that-died",
        leaseExpiresAt: Date.now() + 10 * 60_000,
      });
      // The exact end state of the outage: work outstanding, nothing scheduled.
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      const row = dispatchRow(state, RUN_ID)!;
      // A successor may not honour a lease issued by an isolate that is gone.
      expect(row.lease_token).toBeNull();
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 60_000);
      state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET available_at = 1 WHERE run_id = ?`,
        RUN_ID,
      );
      await state.storage.setAlarm(Date.now() + 600_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      // Reclaimed and carried forward, not restarted: the member already saw
      // this run begin, so `started_at` must survive.
      const row = dispatchRow(state, RUN_ID)!;
      expect(row.attempt).toBeGreaterThan(0);
      expect(row.started_at).toBe(1);
    });
  });

  it("makes the vanished instance's harness attempt immediately resumable", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");
    const oldLeaseExpiresAt = Date.now() + 10 * 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID, {
        state: "running",
        startedAt: 1,
        availableAt: Date.now() + 60 * 60_000,
        leaseToken: "dispatch-owner-that-died",
        leaseExpiresAt: oldLeaseExpiresAt,
      });
      state.storage.sql.exec(
        `UPDATE runs
            SET status = 'running', legacy_attempt_id = 'attempt-that-survived',
                attempt_epoch = 1, lease_owner = 'instance-that-died',
                lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
          WHERE run_id = ?`,
        oldLeaseExpiresAt,
        Date.now(),
        Date.now(),
        RUN_ID,
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, (instance, state) => {
      const run = state.storage.sql.exec<{
        lease_owner: string | null;
        lease_expires_at: number | null;
      }>(
        `SELECT lease_owner, lease_expires_at FROM runs WHERE run_id = ?`,
        RUN_ID,
      ).one();
      expect(run.lease_owner).toBe("instance-that-died");
      expect(run.lease_expires_at).not.toBeNull();
      expect(run.lease_expires_at!).toBeLessThanOrEqual(Date.now());
      expect(run.lease_expires_at).not.toBe(oldLeaseExpiresAt);
      const recoverable = (instance as unknown as {
        recoverableHarnessAttempts: Map<string, string>;
      }).recoverableHarnessAttempts;
      expect(recoverable.get(RUN_ID)).toBe("attempt-that-survived");
    });
  });

  it("keeps an alarm armed across an eviction while work is outstanding", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");
    await runInDurableObject(stub, (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID, { availableAt: Date.now() + 60 * 60_000 });
    });

    await evictDurableObject(stub);
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      // Even a run that is not due for an hour is swept for, so a scheduling
      // defect costs an interval rather than the run.
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 60_000);
    });
  });

  it("stops waking once no dispatch is left to run", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID, { state: "completed", startedAt: 1 });
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  // Repeated alarms are what the sweep floor produces. If each one re-claimed,
  // a run would be replayed every interval for as long as it took.
  it("does not re-claim a run it is already executing", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");
    await runInDurableObject(stub, (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID);
    });

    await runDurableObjectAlarm(stub);
    const first = await runInDurableObject(stub, (_instance, state) => dispatchRow(state, RUN_ID)!);
    await runDurableObjectAlarm(stub);
    const second = await runInDurableObject(stub, (_instance, state) => dispatchRow(state, RUN_ID)!);

    // A second attempt is only legitimate once the first has been given back.
    if (second.attempt > first.attempt) {
      expect(first.lease_token).toBeNull();
    }
  });

  it("returns without busy-looping when a heartbeat sees an active drain", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    await runInDurableObject(stub, (instance, state) => {
      seedSubstreamDispatch(state, RUN_ID, {
        state: "running",
        startedAt: 1,
        availableAt: 1,
        leaseToken: "active-drain",
        leaseExpiresAt: 1,
      });
      const drain = (instance as unknown as {
        agentDrain: {
          resume(operation: () => Promise<void>, settled: () => void): Promise<void>;
        };
      }).agentDrain;
      void drain.resume(() => held, () => undefined);
    });

    const outcome = await activeDrainHeartbeatOutcome(stub, release);
    if (outcome === "joined") {
      expect(outcome).toBe("returned");
      return;
    }

    const heartbeatStartedAt = Date.now();
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const nextAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm());
    release();

    // An alarm is a distinct request context. Awaiting a drain promise that
    // belongs to the request already executing the run can strand both events
    // and invalidates any request-scoped I/O the run performs afterward.
    expect(outcome).toBe("returned");
    // A due dispatch cannot make progress while the other invocation owns the
    // drain. Re-arming it at now + 1 turns that row into hundreds of alarms and
    // authority reads per second; the active owner gets one heartbeat horizon.
    expect(nextAlarm).not.toBeNull();
    expect(nextAlarm!).toBeGreaterThanOrEqual(heartbeatStartedAt + 20_000);
  });
});

// `runs_mutating_substream_uq` allows one mutating run per substream. A run
// whose executor is gone keeps that slot forever, so every later run fails as
// it starts — and because the failure belongs to the *new* run, the work stream
// reads as permanently busy while nothing executes. This is what a migrated
// mid-flight run leaves behind, and only a run clears it, which no run can
// reach.
describe("a run abandoned by a vanished executor does not wedge the substream", () => {
  const PHANTOM = "00000000-0000-7000-8000-0000000002c1";

  it("reaps the abandoned run and lets the next one start", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID);
      // A run holding the slot with no dispatch behind it: it cannot execute
      // again, and nothing in the object is watching for it.
      state.storage.sql.exec(
        `INSERT INTO runs (
           run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
           model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
           active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
           tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
           created_at, updated_at
         ) VALUES (?, '0', NULL, 'running', '{}', 0, 0, '', 0, 0, 1,
                   0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
        PHANTOM,
      );
      await state.storage.setAlarm(Date.now() + 600_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const phantom = state.storage.sql.exec<{ status: string; terminalized_at: number | null }>(
        `SELECT status, terminalized_at FROM runs WHERE run_id = ?`,
        PHANTOM,
      ).toArray()[0]!;
      expect(phantom.terminalized_at).not.toBeNull();
      expect(phantom.status).toBe("failed");

      // And the run that was waiting behind it actually started.
      const next = state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM runs WHERE run_id = ?`,
        RUN_ID,
      ).toArray()[0]!;
      expect(next.status).not.toBe("admitted");
    });
  });

  it("leaves a run alone while a dispatch is still prepared to execute it", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      // Same shape, except this run has a dispatch: it is going to run, so
      // reaping it would destroy live work.
      seedSubstreamDispatch(state, PHANTOM, {
        state: "running",
        startedAt: 1,
        availableAt: Date.now() + 60 * 60_000,
      });
      state.storage.sql.exec(
        `UPDATE runs SET status = 'running' WHERE run_id = ?`,
        PHANTOM,
      );
    });

    await runInDurableObject(stub, (instance, state) => {
      const product = (instance as unknown as {
        product: { reapAbandonedSubstreamRuns(substreamId: string, now: number): string[] };
      }).product;
      expect(product.reapAbandonedSubstreamRuns("0", Date.now())).toEqual([]);
      const row = state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM runs WHERE run_id = ?`,
        PHANTOM,
      ).toArray()[0]!;
      expect(row.status).toBe("running");
    });
  });
});

// Found by running this suite against workerd rather than by reading the code:
// the payload was parsed *outside* the drain's guard, so a dispatch this build
// cannot decode threw straight out of the loop. The row stayed claimed and
// settled nothing, the lease lapsed, the next alarm reclaimed it, and it threw
// again — a poison pill that consumed the queue forever without one log line.
describe("a dispatch that cannot be decoded does not consume the queue", () => {
  it("fails the undecodable run and carries on to the next one", async () => {
    const stub = substreamStub();
    await boot(stub, "https://object.test/health");
    const NEXT = "00000000-0000-7000-8000-0000000002d1";

    await runInDurableObject(stub, async (_instance, state) => {
      seedSubstreamDispatch(state, RUN_ID);
      state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET input_json = '{"not":"a valid run input"}'
          WHERE run_id = ?`,
        RUN_ID,
      );
      seedSubstreamDispatch(state, NEXT, { availableAt: 2 });
      await state.storage.setAlarm(Date.now() + 600_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      const poison = dispatchRow(state, RUN_ID)!;
      expect(poison.state).toBe("failed");
      expect(poison.lease_token).toBeNull();

      // The queue moved past it rather than stopping on it.
      const next = dispatchRow(state, NEXT)!;
      expect(next.attempt).toBeGreaterThan(0);
      expect(assertInvariant(next, await state.storage.getAlarm())).toBe(true);
    });
  });
});

describe("the same guarantees hold for a HyperSight block run", () => {
  function seedBlockDispatch(
    state: DurableObjectState,
    row: {
      availableAt?: number;
      leaseToken?: string | null;
      leaseExpiresAt?: number | null;
    } = {},
  ): void {
    state.storage.sql.exec(
      `INSERT INTO agent_run_dispatches
         (block_run_id, dispatch_json, configuration_version_number, trigger_sequence,
          source_created_at, state, attempt, available_at, started_at,
          lease_token, lease_expires_at, created_at, updated_at)
       VALUES ('block-run', '{}', 1, 0, 1, 'running', 1, ?, 1, ?, ?, 1, 1)`,
      row.availableAt ?? 1,
      row.leaseToken ?? null,
      row.leaseExpiresAt ?? null,
    );
  }

  it("recovers a block run whose owner vanished mid-flight", async () => {
    const stub = blockStub();
    await boot(stub, "https://block-dashboard.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      seedBlockDispatch(state, {
        availableAt: Date.now() + 60 * 60_000,
        leaseToken: "owner-that-died",
        leaseExpiresAt: Date.now() + 10 * 60_000,
      });
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub, "https://block-dashboard.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec<{ lease_token: string | null }>(
        `SELECT lease_token FROM agent_run_dispatches WHERE block_run_id = 'block-run'`,
      ).toArray()[0]!;
      expect(row.lease_token).toBeNull();
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 60_000);
    });
  });

  it("stops waking once no block dispatch is left to run", async () => {
    const stub = blockStub();
    await boot(stub, "https://block-dashboard.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO agent_run_dispatches
           (block_run_id, dispatch_json, configuration_version_number, trigger_sequence,
            source_created_at, state, attempt, available_at, started_at, completed_at,
            terminal_outcome_json, settled_at, created_at, updated_at)
         VALUES ('block-done', '{}', 1, 0, 1, 'completed', 1, 1, 1, 1, NULL, 1, 1, 1)`,
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub, "https://block-dashboard.test/health");

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("returns without busy-looping when a block heartbeat sees an active drain", async () => {
    const stub = blockStub();
    await boot(stub, "https://block-dashboard.test/health");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    await runInDurableObject(stub, (instance, state) => {
      seedBlockDispatch(state, {
        availableAt: 1,
        leaseToken: "active-block-drain",
        leaseExpiresAt: 1,
      });
      const drain = (instance as unknown as {
        agentDrain: {
          resume(operation: () => Promise<void>, settled: () => void): Promise<void>;
        };
      }).agentDrain;
      void drain.resume(() => held, () => undefined);
    });

    const outcome = await activeDrainHeartbeatOutcome(stub, release);
    if (outcome === "joined") {
      expect(outcome).toBe("returned");
      return;
    }

    const heartbeatStartedAt = Date.now();
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const nextAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm());
    release();

    expect(outcome).toBe("returned");
    expect(nextAlarm).not.toBeNull();
    expect(nextAlarm!).toBeGreaterThanOrEqual(heartbeatStartedAt + 20_000);
  });
});
