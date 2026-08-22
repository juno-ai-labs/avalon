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
  SCHEDULED_ALARM_DRAIN_LIMIT,
  ScheduledAlarmStore,
  scheduledAlarmRetryDelay,
  type ScheduledAlarm,
} from "../src/durable-objects/scheduled-alarms";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workstreamRegionalEffectHash } from "../src/durable-objects/workstream-regional-effect";

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

  it("drains every entry sharing one instant across consecutive wakes, each exactly once", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      // More than one wake may drain, all wanting the same millisecond. A
      // workspace whose whole digest fan-out lands on the hour looks like this.
      const total = SCHEDULED_ALARM_DRAIN_LIMIT * 2 + 5;
      const keys = Array.from(
        { length: total },
        (_unused, index) => `wakeup-${String(index).padStart(4, "0")}`,
      );
      state.storage.transactionSync(() => {
        for (const key of keys) {
          store.schedule({ kind: "test_ok", key, dueAt: now - 1_000 }, now);
        }
      });
      const ran: string[] = [];
      scheduling(instance).runScheduledAlarm = (alarm: ScheduledAlarm) => {
        ran.push(alarm.key);
        return Promise.resolve();
      };

      expect(await scheduling(instance).drainDueScheduledAlarms(now))
        .toBe(SCHEDULED_ALARM_DRAIN_LIMIT);
      // The overflow is not stranded until something else comes due: everything
      // left is already past, so the re-arm asks for the next millisecond.
      const armed = await scheduling(instance).armNextAlarm();
      expect(armed).not.toBeNull();
      expect(armed!).toBeLessThanOrEqual(Date.now() + 1);

      expect(await scheduling(instance).drainDueScheduledAlarms(now))
        .toBe(SCHEDULED_ALARM_DRAIN_LIMIT);
      expect(await scheduling(instance).drainDueScheduledAlarms(now)).toBe(5);

      // The ordering is what makes the slices partition the tie: without a
      // total order the same rows can come back while others never do.
      expect(ran).toEqual(keys);
      expect(store.list("test_ok")).toEqual([]);
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

  it("arms the next occurrence of a recurring schedule it just fired", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();
    const scheduleId = "00000000-0000-7000-8000-0000000000d1";
    // Seeded in the future so nothing can fire between here and the invocation
    // below; the row is backdated inside that invocation instead.
    await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000000d2",
      statements: [{
        sql: `INSERT INTO schedules
                (id, workspace_id, connector_connection_id, schedule_type, interval_seconds,
                 timezone, next_run_at, enabled, version, created_at, updated_at)
              VALUES (?, ?, ?, 'interval', 300, 'UTC', ?, 1, 1, ?, ?)`,
        params: [
          scheduleId,
          WORKSPACE_ID,
          "00000000-0000-7000-8000-0000000000d3",
          new Date(Date.now() + 600_000).toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      }],
    });

    // Backdating, arming, and firing all happen without the object's input gate
    // opening, so the runtime cannot land the real handler — which has no
    // Workflow binding here — on the entry first and defer it behind a gate.
    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `UPDATE schedules SET next_run_at = ? WHERE id = ? AND workspace_id = ?`,
        new Date(Date.now() - 1_000).toISOString(),
        scheduleId,
        WORKSPACE_ID,
      );
      const advancedTo = new Date(Date.now() + 300_000).toISOString();
      scheduling(instance).runScheduledAlarm = (alarm: ScheduledAlarm) => {
        if (alarm.kind === "schedule") {
          // Written straight to storage, as the real runner's local executor
          // does — deliberately not through `executeRuntimeSql`, whose
          // auto-refresh would arm the next occurrence and hide the very gap
          // this test exists for.
          state.storage.sql.exec(
            `UPDATE schedules SET next_run_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`,
            advancedTo,
            scheduleId,
            WORKSPACE_ID,
          );
        }
        return Promise.resolve();
      };
      await instance.refreshSchedule(WORKSPACE_ID);

      await instance.alarm();

      // The entry the drain settled has been replaced by one for the occurrence
      // the handler just wrote. Without the end-of-alarm reconcile the schedule
      // fires exactly once and is never armed again.
      const entries = new ScheduledAlarmStore(state.storage.sql).list("schedule");
      expect(entries.map((entry) => entry.key)).toEqual([scheduleId]);
      expect(entries[0]!.dueAt).toBe(Date.parse(advancedTo));
      expect(await state.storage.getAlarm()).toBe(Date.parse(advancedTo));
    });
  });

  it("reconciles more targets than a query can bind parameters for", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      // Comfortably past workerd's bound-variable ceiling. A workspace reaches
      // this on its own: a person's digest is one `schedules` row per delivery
      // time, so a mid-sized workspace has hundreds.
      const targets = Array.from({ length: 250 }, (_value, index) => ({
        key: `schedule-${index}`,
        dueAt: now + index,
      }));

      store.reconcile("schedule", targets, now);
      expect(store.list("schedule")).toHaveLength(250);

      store.reconcile("schedule", targets.slice(0, 200), now);
      expect(store.list("schedule")).toHaveLength(200);
      expect(store.get("schedule", "schedule-249")).toBeNull();
    });
  });

  it("arms a Terminal deadline as soon as the directory effect that wrote it lands", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();
    const dueAt = Date.now() + 300_000;
    const effect = {
      kind: "directory_common" as const,
      title: "Terminal",
      description: "",
      preview: "",
      scope: "workspace" as const,
      state: "idle",
      systemKind: null,
      lastActivityAt: new Date().toISOString(),
      completedAt: null,
      archivedAt: null,
      nextTerminalActionAt: new Date(dueAt).toISOString(),
    };

    // Driven through the real entry point, not the private helper: the failure
    // this guards against is the reconcile not being wired to the only writer
    // of `next_terminal_action_at`, which a direct helper call cannot see.
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [{
        kind: "workstream_regional_effect" as const,
        contractVersion: 1 as const,
        region: "global" as const,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        generation: 1,
        messageId: "00000000-0000-7000-8000-0000000000e9",
        partitionKey: "common",
        sourceVersion: 1,
        requiredProjectionVersion: null,
        payloadHash: workstreamRegionalEffectHash(effect),
        effect,
      }],
    });

    await runInDurableObject(stub, async (_instance: WorkspaceDO, state) => {
      const entries = new ScheduledAlarmStore(state.storage.sql).list("terminal");
      expect(entries.map((entry) => entry.key)).toEqual([WORKSTREAM_ID]);
      expect(entries[0]!.dueAt).toBe(dueAt);
      expect(await state.storage.getAlarm()).toBe(dueAt);
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
