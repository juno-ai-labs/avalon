/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The multi-alarm capability, on the runtime that actually has alarms.
 *
 * Every assertion here is about `setAlarm`/`getAlarm`/`deleteAlarm` semantics
 * or object-local SQLite, neither of which a Node double reproduces: a fake
 * `setAlarm` cannot tell you that the armed instant moved, only that a function
 * was called. `docs/durable-object-alarms.md` is the module document.
 */
import { env } from "cloudflare:workers";
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { substreamAgentName, workspaceDOName } from "../src/durable-objects/names";
import {
  ScheduledAlarmStore,
  scheduledAlarmRetryDelay,
  type ScheduledAlarm,
} from "../src/durable-objects/scheduled-alarms";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000a2");

/**
 * The base's protected surface.
 *
 * Arming is deliberately not public — nothing outside an object may point its
 * alarm anywhere — so a test that wants to prove the arming rules has to reach
 * through the type rather than around the object.
 */
interface AlarmScheduling {
  scheduleAlarm(input: {
    kind: string;
    key: string;
    dueAt: number;
    repeatEveryMs?: number | null;
  }): Promise<void>;
  cancelScheduledAlarm(kind: string, key: string): Promise<boolean>;
  armNextAlarm(): Promise<number | null>;
  drainDueScheduledAlarms(now: number): Promise<number>;
  runScheduledAlarm(alarm: ScheduledAlarm): Promise<void>;
}

function scheduling(instance: WorkspaceDO): AlarmScheduling {
  return instance as unknown as AlarmScheduling;
}

async function seedOpenAuthority(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY,
      phase TEXT NOT NULL,
      generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_user_id TEXT,
      workstream_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
  ]);
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

async function initializedWorkspace() {
  const stub = workspaceStub();
  await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
  return stub;
}

beforeEach(async () => {
  await reset();
});

describe("the shared Durable Object alarm list", () => {
  it("arms the one alarm at the earliest entry and pulls it in for a nearer one", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const later = Date.now() + 600_000;
      await scheduling(instance).scheduleAlarm({ kind: "schedule", key: "later", dueAt: later });
      expect(await state.storage.getAlarm()).toBe(later);

      // The whole point of re-arming on every mutation: an entry added after
      // the alarm was set, for an earlier instant, must move it.
      const sooner = Date.now() + 60_000;
      await scheduling(instance).scheduleAlarm({ kind: "schedule", key: "sooner", dueAt: sooner });
      expect(await state.storage.getAlarm()).toBe(sooner);
    });
  });

  it("pushes the alarm back out when the earliest entry is cancelled, and deletes the last one", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const sooner = Date.now() + 60_000;
      const later = Date.now() + 600_000;
      await scheduling(instance).scheduleAlarm({ kind: "schedule", key: "sooner", dueAt: sooner });
      await scheduling(instance).scheduleAlarm({ kind: "schedule", key: "later", dueAt: later });
      expect(await state.storage.getAlarm()).toBe(sooner);

      // A lowering-only helper would leave the alarm at `sooner` here, waking
      // the object for a row that no longer exists.
      expect(await scheduling(instance).cancelScheduledAlarm("schedule", "sooner")).toBe(true);
      expect(await state.storage.getAlarm()).toBe(later);

      await scheduling(instance).cancelScheduledAlarm("schedule", "later");
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("floors an entry due in the past at the next millisecond rather than arming behind now", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const before = Date.now();
      await scheduling(instance).scheduleAlarm({
        kind: "schedule",
        key: "overdue",
        dueAt: before - 600_000,
      });
      const armed = await state.storage.getAlarm();
      expect(armed).not.toBeNull();
      expect(armed!).toBeGreaterThan(before);
    });
  });

  it("runs every entry due at one instant, holding only the one that threw", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      store.schedule({ kind: "test_ok", key: "first", dueAt: now - 1_000 }, now);
      store.schedule({ kind: "test_fail", key: "second", dueAt: now - 1_000 }, now);
      store.schedule({ kind: "test_ok", key: "third", dueAt: now - 1_000 }, now);
      const ran: string[] = [];
      // Substituting the dispatch is what lets one entry fail on demand; the
      // drain, the settle, and the gate below are the real implementations.
      scheduling(instance).runScheduledAlarm = (alarm: ScheduledAlarm) => {
        if (alarm.kind === "test_fail") return Promise.reject(new Error("target_failed"));
        ran.push(alarm.key);
        return Promise.resolve();
      };

      expect(await scheduling(instance).drainDueScheduledAlarms(now)).toBe(2);
      expect(ran).toEqual(["first", "third"]);
      expect(store.get("test_ok", "first")).toBeNull();
      expect(store.get("test_ok", "third")).toBeNull();
      const failed = store.get("test_fail", "second");
      expect(failed?.attempt).toBe(1);
      expect(failed!.retryAt).toBeGreaterThan(now);
      expect(failed!.retryAt - now).toBeLessThanOrEqual(scheduledAlarmRetryDelay(1, () => 1));

      // The gate holds on the very next drain: this is the loop the retry
      // states were introduced to prevent.
      expect(await scheduling(instance).drainDueScheduledAlarms(Date.now())).toBe(0);
    });
  });

  it("advances a repeating entry past every occurrence it slept through", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      const dueAt = now - 60 * 60_000;
      store.schedule({ kind: "sweep", key: "hourly", dueAt, repeatEveryMs: 5 * 60_000 }, now);

      store.settle({ kind: "sweep", key: "hourly", dueAt, repeatEveryMs: 5 * 60_000 }, now);

      const next = store.get("sweep", "hourly");
      expect(next?.dueAt).toBeGreaterThan(now);
      expect(next!.dueAt - now).toBeLessThanOrEqual(5 * 60_000);
      expect((next!.dueAt - dueAt) % (5 * 60_000)).toBe(0);
    });
  });

  it("keeps a failing target's gate across a reconcile and drops what vanished", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      store.schedule({ kind: "schedule", key: "kept", dueAt: now + 60_000 }, now);
      store.schedule({ kind: "schedule", key: "gone", dueAt: now + 60_000 }, now);
      store.defer({ kind: "schedule", key: "kept", dueAt: now + 60_000, attempt: 2 }, now);

      store.reconcile("schedule", [{ key: "kept", dueAt: now + 60_000 }], now);

      expect(store.get("schedule", "gone")).toBeNull();
      // Same due time, so the gate earned by two failures survives. Resetting
      // it would hand a broken target a free attempt on every sibling write.
      expect(store.get("schedule", "kept")?.attempt).toBe(3);
    });
  });

  it("clears a gate when the entry is rescheduled to a different instant", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      store.schedule({ kind: "schedule", key: "moved", dueAt: now + 60_000 }, now);
      store.defer({ kind: "schedule", key: "moved", dueAt: now + 60_000, attempt: 1 }, now);
      expect(store.get("schedule", "moved")?.attempt).toBe(2);

      store.reconcile("schedule", [{ key: "moved", dueAt: now + 120_000 }], now);

      expect(store.get("schedule", "moved")).toMatchObject({ attempt: 0, retryAt: 0 });
    });
  });
});

describe("a workspace's schedule", () => {
  it("reconciles a due schedule into the alarm and takes the alarm back when it is disabled", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();
    const dueAt = new Date(Date.now() + 90_000).toISOString();
    await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000000b1",
      statements: [{
        sql: `INSERT INTO schedules
                (id, workspace_id, connector_connection_id, schedule_type, interval_seconds,
                 timezone, next_run_at, enabled, version, created_at, updated_at)
              VALUES (?, ?, ?, 'interval', 300, 'UTC', ?, 1, 1, ?, ?)`,
        params: [
          "00000000-0000-7000-8000-0000000000b2",
          WORKSPACE_ID,
          "00000000-0000-7000-8000-0000000000b3",
          dueAt,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      }],
    });

    expect(await stub.refreshSchedule(WORKSPACE_ID)).toEqual({ alarmAt: dueAt });
    await runInDurableObject(stub, async (_instance: WorkspaceDO, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.parse(dueAt));
    });

    await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000000b4",
      statements: [{
        sql: `UPDATE schedules SET enabled = 0 WHERE id = ?`,
        params: ["00000000-0000-7000-8000-0000000000b2"],
      }],
    });

    expect(await stub.refreshSchedule(WORKSPACE_ID)).toEqual({ alarmAt: null });
    await runInDurableObject(stub, async (_instance: WorkspaceDO, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = 'schedule'`,
      ).one().count).toBe(0);
    });
  });

  it("holds every due target while the region is closed, then keeps its due times", async () => {
    await seedOpenAuthority();
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'maintenance_draining'`,
    ).run();
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const now = Date.now();
      new ScheduledAlarmStore(state.storage.sql)
        .schedule({ kind: "maintenance", key: "memory_index", dueAt: now - 60_000 }, now);
      let ran = 0;
      scheduling(instance).runScheduledAlarm = () => {
        ran += 1;
        return Promise.resolve();
      };

      await instance.alarm();

      expect(ran).toBe(0);
      // Pushed out, not left at the overdue instant: an alarm that stays in the
      // past re-fires immediately and spins for as long as the region is closed.
      const armed = await state.storage.getAlarm();
      expect(armed!).toBeGreaterThan(now + 60_000);
      expect(new ScheduledAlarmStore(state.storage.sql).get("maintenance", "memory_index")?.dueAt)
        .toBe(now - 60_000);
    });
  });
});

describe("an agent's own wake-ups", () => {
  it("indexes every pending wake-up so one alarm can fire them all", async () => {
    await seedOpenAuthority();
    const agent = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await agent.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
    });
    const dueAt = Date.now() + 120_000;
    await runInDurableObject(agent, (_instance, state) => {
      for (const [index, id] of ["wake-one", "wake-two"].entries()) {
        state.storage.sql.exec(
          `INSERT INTO workstream_wakeups
             (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at, status,
              idempotency_key, fired_at, cancelled_at, version, created_at, updated_at)
           VALUES (?, NULL, '{"type":"workspace"}', 'Check the build', ?, 'pending', ?,
                   NULL, NULL, 1, ?, ?)`,
          id,
          dueAt + index,
          `idempotency-${id}`,
          Date.now(),
          Date.now(),
        );
      }
    });

    await agent.refreshTimerAlarm({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
    });

    await runInDurableObject(agent, async (_instance, state) => {
      const entries = new ScheduledAlarmStore(state.storage.sql).list("agent_timer");
      expect(entries.map((entry) => entry.key)).toEqual(["wake-one", "wake-two"]);
      // Both are indexed, and the alarm is the earlier of the two — the object
      // used to derive one timestamp and fire a single wake-up per alarm.
      expect(await state.storage.getAlarm()).toBe(dueAt);
    });

    // Cancelling through the same routed port the tool uses takes the entry —
    // and the alarm it justified — with it.
    await runInDurableObject(agent, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE workstream_wakeups SET status = 'cancelled' WHERE wakeup_id = ?`,
        "wake-one",
      );
    });
    await agent.refreshTimerAlarm({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
    });

    await runInDurableObject(agent, async (_instance, state) => {
      expect(new ScheduledAlarmStore(state.storage.sql).list("agent_timer").map((entry) => entry.key))
        .toEqual(["wake-two"]);
      expect(await state.storage.getAlarm()).toBe(dueAt + 1);
    });
  });

  it("leaves nothing armed once its last wake-up is gone", async () => {
    await seedOpenAuthority();
    const agent = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await agent.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
    });
    await runInDurableObject(agent, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO workstream_wakeups
           (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at, status,
            idempotency_key, fired_at, cancelled_at, version, created_at, updated_at)
         VALUES ('only', NULL, '{"type":"workspace"}', 'Check the build', ?, 'pending',
                 'idempotency-only', NULL, NULL, 1, ?, ?)`,
        Date.now() + 120_000,
        Date.now(),
        Date.now(),
      );
    });
    await agent.refreshTimerAlarm({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
    });

    await runInDurableObject(agent, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM workstream_wakeups WHERE wakeup_id = 'only'`);
    });
    await agent.refreshTimerAlarm({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
    });

    await runInDurableObject(agent, async (_instance, state) => {
      expect(new ScheduledAlarmStore(state.storage.sql).list("agent_timer")).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    // Nothing left to wake for: an alarm run here would be the object waking
    // for a row that no longer exists.
    expect(await runDurableObjectAlarm(agent)).toBe(false);
  });
});
