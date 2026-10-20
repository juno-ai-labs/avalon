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
import { asSubstreamId, asWorkspaceId, asWorkstreamId, conversationEffectHash } from "@rally/contracts";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  conversationObjectName,
  workspaceDOName,
} from "../src/durable-objects/names";
import {
  SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
  SCHEDULED_ALARM_DRAIN_LIMIT,
  ScheduledAlarmStore,
  scheduledAlarmRetryDelay,
  type ScheduledAlarm,
  type ScheduledAlarmOutcome,
  type ScheduledAlarmRun,
} from "../src/durable-objects/scheduled-alarms";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { ensureAuditSchema } from "./helpers/audit-fixture";

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
  armAlarmBeforeDueWork(now: number): Promise<unknown>;
  armAlarmDuringRunDrain(now: number): Promise<void>;
  drainDueScheduledAlarms(now: number): Promise<ScheduledAlarmRun[]>;
  gateStalledScheduledAlarms(ran: readonly ScheduledAlarmRun[], now: number): void;
  runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome>;
  onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void;
}

function scheduling(instance: unknown): AlarmScheduling {
  return instance as unknown as AlarmScheduling;
}

async function seedAuthority(
  phase: "durable_object_open" | "maintenance_draining",
): Promise<void> {
  await ensureAuditSchema();
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
      VALUES (1, ?, 1, 1, 1)`).bind(phase),
  ]);
}

async function seedOpenAuthority(): Promise<void> {
  await seedAuthority("durable_object_open");
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

async function initializedWorkspace() {
  const stub = workspaceStub();
  await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
  // Close the Space cutover, the way the path that opens a new Organization
  // does before its first session. A `pending` one is due at the epoch — that
  // is how the fleet migration starts without anybody signing in — so every
  // assertion below about *which* instant the alarm is armed at would be
  // measuring the cutover instead of the entry it scheduled.
  await stub.finalizeSpaceBootstrap({ workspaceId: WORKSPACE_ID });
  // And take back the wake-up the pending cutover armed on the way through.
  // The platform was told about it while the object was constructing, so it is
  // delivered as a real `alarm()` — a second run of the whole handler, racing
  // whichever one a case is about.
  await runInDurableObject(stub, (_instance: WorkspaceDO, state) => state.storage.deleteAlarm());
  return stub;
}

beforeEach(async () => {
  await reset();
});

afterEach(async () => {
  // Every test here shares one workspace object, and several arm its alarm at
  // an instant already past. A wake-up left behind is delivered by workerd as a
  // real `alarm()` that runs the full handler — draining and writing storage
  // through the next test's `reset()`. Disarm unconditionally, whichever path
  // the test armed through.
  try {
    await runInDurableObject(workspaceStub(), (_instance: WorkspaceDO, state) =>
      state.storage.deleteAlarm());
  } catch {
    // The object may never have been created, or may already be gone.
  }
  try {
    const agent = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(agent, (_instance, state) => state.storage.deleteAlarm());
  } catch {
    // The root conversation may never have been created, or may be gone.
  }
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

  it("re-arms due work at a recovery horizon before running it", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      store.schedule({ kind: "schedule", key: "overdue", dueAt: now - 60_000 }, now);

      await scheduling(instance).armAlarmBeforeDueWork(now);

      // The source entry stays durable until the handler settles it, so this
      // later wake recovers a cancelled continuation. The old exact pre-arm
      // used `now + 1`, creating a second alarm invocation that the successful
      // handler's final re-arm immediately replaced and Cloudflare cancelled.
      expect(await state.storage.getAlarm()).toBe(
        now + SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
      );
      expect(store.get("schedule", "overdue")?.dueAt).toBe(now - 60_000);
    });
  });

  it("routes workspace alarm work through content-free phase instrumentation", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const phases: Array<{ phase: string; alarmKind: string | undefined }> = [];
      let finished = 0;
      const instrumentPhase = async <T>(
        phase: string,
        alarmKind: string | undefined,
        run: () => Promise<T>,
      ): Promise<T> => {
        phases.push({ phase, alarmKind });
        return run();
      };
      (instance as unknown as {
        instrumentWorkspaceAlarmPhase: typeof instrumentPhase;
        finishWorkspaceAlarmInstrumentation: () => void;
      }).instrumentWorkspaceAlarmPhase = instrumentPhase;
      (instance as unknown as { finishWorkspaceAlarmInstrumentation: () => void })
        .finishWorkspaceAlarmInstrumentation = () => {
          finished += 1;
        };

      new ScheduledAlarmStore(state.storage.sql).schedule({
        kind: "schedule_bootstrap",
        key: "workspace",
        dueAt: Date.now() - 1,
      });
      // Every derived lane answers "due" while the due work runs, so this case
      // pins the order of all of them; which lanes run on a quieter wake is
      // the next describe's subject. Only for the pass itself: a lane that
      // stayed due would arm the real alarm at the next millisecond.
      const lanes = instance as unknown as {
        derivedAlarmLanes(): Record<string, () => number | null>;
        runDueAlarmWork(now: number): Promise<void>;
      };
      const realLanes = lanes.derivedAlarmLanes.bind(instance);
      const realRun = lanes.runDueAlarmWork.bind(instance);
      let everyLaneDue = false;
      lanes.derivedAlarmLanes = () => everyLaneDue
        ? Object.fromEntries(Object.keys(realLanes()).map((lane) => [lane, () => 0]))
        : realLanes();
      lanes.runDueAlarmWork = async (now) => {
        everyLaneDue = true;
        try {
          await realRun(now);
        } finally {
          everyLaneDue = false;
        }
      };

      await instance.alarm();

      expect(phases).toEqual([
        { phase: "recovery_rearm", alarmKind: undefined },
        { phase: "authority_check", alarmKind: undefined },
        { phase: "stored_target", alarmKind: "schedule_bootstrap" },
        // Hosted parents' outbox runs first: a row there is a directory update
        // somebody is waiting on.
        { phase: "parent_outbox", alarmKind: undefined },
        { phase: "parent_breakouts", alarmKind: undefined },
        // Post-commit work a directory write recorded and did not finish.
        { phase: "directory_followup", alarmKind: undefined },
        // The Space authority's publishing phases sit before the sweep: each
        // publishes onto the activity Queue, and a rejected send has to leave
        // its rows claimed and pending rather than spin this alarm.
        { phase: "space_default_publish", alarmKind: undefined },
        { phase: "space_bootstrap", alarmKind: undefined },
        { phase: "channel_color_sync", alarmKind: undefined },
        { phase: "thread_backfill", alarmKind: undefined },
        { phase: "import_reservation_reclaim", alarmKind: undefined },
        { phase: "memory_digest_sync", alarmKind: undefined },
        { phase: "activity_reap", alarmKind: undefined },
        { phase: "connector_event_reap", alarmKind: undefined },
        { phase: "schedule_reconcile", alarmKind: undefined },
        // Interrupted Space operations last: each step waits on a Channel's
        // conversation, and one step per intent per alarm keeps the phases
        // above from waiting behind a large Space.
        { phase: "space_intent_resume", alarmKind: undefined },
        { phase: "final_rearm", alarmKind: undefined },
      ]);
      expect(finished).toBe(1);
    });
  });

  it("finishes phase instrumentation when authority defers alarm work", async () => {
    await seedAuthority("maintenance_draining");
    const stub = await initializedWorkspace();
    // Setting the workspace up arms a real alarm. Left in place it can fire
    // while the patched hooks below are installed and count as a second
    // finish, so it runs now and is then removed.
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      await state.storage.deleteAlarm();
      const phases: string[] = [];
      let finished = 0;
      const instrumentPhase = async <T>(
        phase: string,
        _alarmKind: string | undefined,
        run: () => Promise<T>,
      ): Promise<T> => {
        phases.push(phase);
        return run();
      };
      (instance as unknown as {
        instrumentWorkspaceAlarmPhase: typeof instrumentPhase;
        finishWorkspaceAlarmInstrumentation: () => void;
      }).instrumentWorkspaceAlarmPhase = instrumentPhase;
      (instance as unknown as { finishWorkspaceAlarmInstrumentation: () => void })
        .finishWorkspaceAlarmInstrumentation = () => {
          finished += 1;
        };

      await instance.alarm();

      expect(phases).toEqual(["recovery_rearm", "authority_check"]);
      expect(finished).toBe(1);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });

  it("cancels by key prefix only in the kinds named, matching the prefix as text", async () => {
    const stub = await initializedWorkspace();

    const remaining = await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      const dueAt = now + 60_000;
      // `_` and `%` are `LIKE` wildcards; as text they match only themselves.
      for (const key of ["abc:1", "abc:2", "a_c:1", "a%:1", "abcd:1"]) {
        store.schedule({ kind: "automation_schedule", key, dueAt }, now);
      }
      store.schedule({ kind: "automation_run", key: "abc:3", dueAt }, now);
      store.schedule({ kind: "schedule", key: "abc:4", dueAt }, now);

      // Each wildcard prefix first, while the keys a `LIKE` would also match
      // are still there.
      expect(store.cancelByKeyPrefix(["automation_schedule"], "a_c:")).toBe(1);
      expect(store.cancelByKeyPrefix(["automation_schedule"], "a%:")).toBe(1);
      expect(store.cancelByKeyPrefix(["automation_schedule", "automation_run"], "abc:")).toBe(3);
      return store.list().map((alarm) => `${alarm.kind}/${alarm.key}`).sort();
    });

    // A longer key sharing the prefix's letters, and the same prefix in a kind
    // not named, stay.
    expect(remaining).toEqual(["automation_schedule/abcd:1", "schedule/abc:4"]);
  });

  it("keeps an earlier future deadline while parking already-due work for recovery", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      const future = now + SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS / 2;
      store.schedule({ kind: "schedule", key: "overdue", dueAt: now - 60_000 }, now);
      store.schedule({ kind: "schedule", key: "future", dueAt: future }, now);

      await scheduling(instance).armAlarmBeforeDueWork(now);

      expect(await state.storage.getAlarm()).toBe(future);
    });
  });

  it("parks an overdue workspace retention sweep instead of normalizing it to now", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_activity_events
           (event_id, event_type, subject_type, subject_id, subject_sequence_number,
            actor_type, actor_user_id, actor_label, title, body, canonical_url,
            audience_kind, audience_user_id, audience_workstream_id, digestible,
            occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json)
         VALUES ('expired-retention', 'test', 'workspace', NULL, NULL,
                 'system', NULL, '', 'Expired', '', NULL,
                 'workspace', NULL, NULL, 0,
                 0, 0, 'test', NULL, 'expired-retention', '{}')`,
      );
      const now = Date.now();

      await scheduling(instance).armAlarmBeforeDueWork(now);

      expect(await state.storage.getAlarm()).toBe(
        now + SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
      );
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

      expect(await scheduling(instance).drainDueScheduledAlarms(now)).toHaveLength(2);
      expect(ran).toEqual(["first", "third"]);
      expect(store.get("test_ok", "first")).toBeNull();
      expect(store.get("test_ok", "third")).toBeNull();
      const failed = store.get("test_fail", "second");
      expect(failed?.attempt).toBe(1);
      expect(failed!.retryAt).toBeGreaterThan(now);
      expect(failed!.retryAt).toBeLessThanOrEqual(Date.now() + scheduledAlarmRetryDelay(1, () => 1));

      // The gate holds on the very next drain: this is the loop the retry
      // states were introduced to prevent.
      expect(await scheduling(instance).drainDueScheduledAlarms(Date.now())).toHaveLength(0);
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
        .toHaveLength(SCHEDULED_ALARM_DRAIN_LIMIT);
      // The overflow is not stranded until something else comes due: everything
      // left is already past, so the re-arm asks for the next millisecond.
      const armed = await scheduling(instance).armNextAlarm();
      expect(armed).not.toBeNull();
      expect(armed!).toBeLessThanOrEqual(Date.now() + 1);
      // Park the wake-up this arming just bought, for the reason the `afterEach`
      // above gives: it is already past, and nothing else here wants it.
      await state.storage.setAlarm(Date.now() + 600_000);

      expect(await scheduling(instance).drainDueScheduledAlarms(now))
        .toHaveLength(SCHEDULED_ALARM_DRAIN_LIMIT);
      expect(await scheduling(instance).drainDueScheduledAlarms(now)).toHaveLength(5);

      // The ordering is what makes the slices partition the tie: without a
      // total order the same rows can come back while others never do.
      expect(ran).toEqual(keys);
      expect(store.list("test_ok")).toEqual([]);
    });
  });

  it("wakes again for an entry that came due while the previous one was still running", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const started = Date.now();
      store.schedule({ kind: "test_slow", key: "first", dueAt: started }, started);
      // Due five milliseconds later — inside the first entry's own runtime. A
      // handler that overruns it is the case one alarm cannot represent, so the
      // second entry either survives to a later wake or is lost silently.
      store.schedule({ kind: "test_slow", key: "second", dueAt: started + 5 }, started);
      const ran: string[] = [];
      scheduling(instance).runScheduledAlarm = async (alarm: ScheduledAlarm) => {
        ran.push(alarm.key);
        // The overrun itself. Sleeping here is only safe because nothing is
        // armed yet — `drainDueScheduledAlarms` does not arm, and the object
        // starts with no alarm. Sleep with one armed in the past and the
        // runtime delivers a real `alarm()` mid-test that drains these entries
        // out from under the assertions.
        if (alarm.key === "first") await new Promise((resolve) => setTimeout(resolve, 40));
      };
      expect(await state.storage.getAlarm()).toBeNull();

      // The drain reads the entries due at the instant the alarm *started*, so
      // however long the first handler runs, the second is not pulled into its
      // pass and keeps its own due time.
      expect(await scheduling(instance).drainDueScheduledAlarms(started)).toHaveLength(1);
      expect(ran).toEqual(["first"]);
      expect(store.get("test_slow", "second")?.dueAt).toBe(started + 5);
      expect(Date.now()).toBeGreaterThan(started + 5);

      // What the alarm leaves behind is the whole answer. The skipped entry is
      // overdue by the time the handler returns, so the re-arm floors it at the
      // next millisecond and the runtime re-enters immediately, rather than at
      // whatever unrelated target happens to come next.
      const armed = await scheduling(instance).armNextAlarm();
      expect(armed).not.toBeNull();
      expect(armed!).toBeGreaterThan(started + 5);
      expect(armed!).toBeLessThanOrEqual(Date.now() + 1);
      // Park it before going any further, for the reason given above.
      await state.storage.setAlarm(Date.now() + 600_000);

      // The wake that re-arm buys.
      expect(await scheduling(instance).drainDueScheduledAlarms(Date.now())).toHaveLength(1);
      expect(ran).toEqual(["first", "second"]);
      expect(store.get("test_slow", "second")).toBeNull();
    });
  });

  it("gates only an entry that is back at the identical instant, not one that moved itself", async () => {
    // Driven directly — drain, gate, arm — so nothing is armed while the test
    // runs and the armed instant is read from `armNextAlarm` itself. Three
    // entries, all due at the same past instant, each answering differently.
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const now = Date.now();
      const dueAt = now - 1_000;
      store.schedule({ kind: "test_stall", key: "stuck", dueAt }, now);
      store.schedule({ kind: "test_stall", key: "moved", dueAt }, now);
      store.schedule({ kind: "test_stall", key: "progressed", dueAt }, now);
      store.schedule({ kind: "test_stall", key: "waiting", dueAt }, now);
      store.schedule({ kind: "test_stall", key: "bad-wait", dueAt }, now);
      const stalled: string[] = [];
      scheduling(instance).onScheduledAlarmStalled = (alarm: ScheduledAlarm) => { stalled.push(alarm.key); };
      scheduling(instance).runScheduledAlarm = (alarm: ScheduledAlarm) => {
        // `moved` reschedules itself to a *different* past instant — the idiom
        // for "run again at once" — which the settle's due_at guard keeps.
        if (alarm.key === "moved") store.schedule({ kind: alarm.kind, key: alarm.key, dueAt: dueAt - 1 }, now);
        if (alarm.key === "progressed") return Promise.resolve({ progressed: true } as const);
        if (alarm.key === "waiting") return Promise.resolve({ waitMs: 45_000 });
        // A wait nobody could have meant: not a hold, the stall rule.
        if (alarm.key === "bad-wait") return Promise.resolve({ waitMs: Number.NaN });
        return Promise.resolve();
      };

      const ran = await scheduling(instance).drainDueScheduledAlarms(now);
      expect(ran.map((run) => run.alarm.key)).toEqual(["bad-wait", "moved", "progressed", "stuck", "waiting"]);
      // The re-derive a workspace does in `runDueAlarmWork`, for the four
      // one-shots the settle deleted: each comes back at the identical instant.
      for (const key of ["stuck", "progressed", "waiting", "bad-wait"]) {
        store.schedule({ kind: "test_stall", key, dueAt }, now);
      }

      const gatedAt = Date.now();
      scheduling(instance).gateStalledScheduledAlarms(ran, gatedAt);

      // In drain order — the store orders a tie by key.
      expect(stalled).toEqual(["bad-wait", "stuck"]);
      const stuck = store.get("test_stall", "stuck");
      expect(stuck?.attempt).toBe(1);
      expect(stuck!.retryAt).toBeGreaterThanOrEqual(gatedAt + scheduledAlarmRetryDelay(1, () => 0));
      expect(stuck!.retryAt).toBeLessThanOrEqual(gatedAt + scheduledAlarmRetryDelay(1, () => 1));
      // Moved to a different instant: untouched, and still the earliest thing.
      expect(store.get("test_stall", "moved")).toMatchObject({ dueAt: dueAt - 1, attempt: 0, retryAt: 0 });
      // Reported progress: untouched.
      expect(store.get("test_stall", "progressed")).toMatchObject({ dueAt, attempt: 0, retryAt: 0 });
      // Asked to wait: held for exactly that long, and not counted.
      expect(store.get("test_stall", "waiting")).toMatchObject({ dueAt, attempt: 0, retryAt: gatedAt + 45_000 });

      const armed = await scheduling(instance).armNextAlarm();
      expect(armed).not.toBeNull();
      expect(armed!).toBeLessThanOrEqual(Date.now() + 1);
      // Park it before the callback returns, for the reason the other tests give.
      await state.storage.setAlarm(Date.now() + 600_000);
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

describe("a workspace's derived alarm lanes", () => {
  /** Record each instrumented phase the next `alarm()` runs, as it runs it. */
  function recordPhases(instance: WorkspaceDO): string[] {
    const phases: string[] = [];
    (instance as unknown as {
      instrumentWorkspaceAlarmPhase: <T>(phase: string, alarmKind: string | undefined, run: () => Promise<T>) => Promise<T>;
    }).instrumentWorkspaceAlarmPhase = async (phase, _alarmKind, run) => {
      phases.push(phase);
      return run();
    };
    return phases;
  }

  function insertActivityEvent(sql: SqlStorage, eventId: string, createdAt: number): void {
    sql.exec(
      `INSERT INTO workspace_activity_events
         (event_id, event_type, subject_type, subject_id, subject_sequence_number,
          actor_type, actor_user_id, actor_label, title, body, canonical_url,
          audience_kind, audience_user_id, audience_workstream_id, digestible,
          occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json)
       VALUES (?, 'test', 'workspace', NULL, NULL,
               'system', NULL, '', 'Event', '', NULL,
               'workspace', NULL, NULL, 0,
               ?, ?, 'test', NULL, ?, '{}')`,
      eventId, createdAt, createdAt, eventId,
    );
  }

  it("runs a lane that is due, skips every lane that is not, and arms for the one it skipped", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const sql = state.storage.sql;
      const now = Date.now();
      // Past retention: the activity sweep is due.
      insertActivityEvent(sql, "expired", 0);
      // Inside retention, so the sweep must leave it.
      insertActivityEvent(sql, "recent", now);
      // A directory update waiting out a backoff: its lane is not due yet.
      const outboxDueAt = now + 10 * 60_000;
      sql.exec(
        `INSERT INTO parent_outbox
           (parent_id, message_id, partition_key, source_version, source_epoch, effect_kind,
            payload_json, payload_hash, state, attempts, not_before, created_at)
         VALUES (?, 'waiting', 'partition', 1, 1, 'directory_common', '{}', 'hash', 'pending', 1, ?, ?)`,
        WORKSTREAM_ID, outboxDueAt, now,
      );
      const phases = recordPhases(instance);

      await instance.alarm();

      expect(phases).toEqual([
        "recovery_rearm",
        "authority_check",
        "activity_reap",
        // The one phase with no due time of its own.
        "schedule_reconcile",
        "final_rearm",
      ]);
      expect(sql.exec<{ event_id: string }>("SELECT event_id FROM workspace_activity_events").toArray())
        .toEqual([{ event_id: "recent" }]);
      expect(sql.exec<{ message_id: string; attempts: number }>(
        "SELECT message_id, attempts FROM parent_outbox",
      ).toArray()).toEqual([{ message_id: "waiting", attempts: 1 }]);
      // Skipped, not dropped: the alarm now points at the row it skipped.
      expect(await state.storage.getAlarm()).toBe(outboxDueAt);
    });
  });

  it("re-arms a register call only when it queued a delivery", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();
    const known = "00000000-0000-7000-8000-0000000000b1";
    const added = "00000000-0000-7000-8000-0000000000b2";
    const deliveryDueAt = Date.now() + 10 * 60_000;
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      // A child already registered, with its delivery waiting out a backoff,
      // and no alarm armed: whatever arms it next is this call.
      state.storage.sql.exec(
        "INSERT INTO authorization_backfill_children(parent_id, substream_id) VALUES (?, ?)", WORKSTREAM_ID, known,
      );
      state.storage.sql.exec(
        "INSERT INTO authorization_delivery(job_key, payload_json, not_before) VALUES (?, '{}', ?)",
        JSON.stringify([WORKSTREAM_ID, known]), deliveryDueAt,
      );
      return state.storage.deleteAlarm();
    });

    // Held in one block so the alarm this arms cannot fire, flush the new
    // delivery and re-arm for the waiting one before the read.
    const registerThenReadAlarm = (substreamIds: string[]) =>
      runInDurableObject(stub, (instance: WorkspaceDO, state) => state.blockConcurrencyWhile(async () => {
        await instance.registerAuthorizationChildren({
          workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamIds, refreshExisting: false,
        });
        return state.storage.getAlarm();
      }));

    // Every child is known and `refreshExisting: false` skips it: nothing queued.
    expect(await registerThenReadAlarm([known])).toBeNull();

    // A new child queues its discovery, due at once.
    const armed = await registerThenReadAlarm([known, added]);
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThan(deliveryDueAt);
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

  it("gates an entry that ran but came back due at the same instant, instead of re-waking for it", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();
    const scheduleId = "00000000-0000-7000-8000-0000000000e1";
    await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000000e2",
      statements: [{
        sql: `INSERT INTO schedules
                (id, workspace_id, connector_connection_id, schedule_type, interval_seconds,
                 timezone, next_run_at, enabled, version, created_at, updated_at)
              VALUES (?, ?, ?, 'interval', 300, 'UTC', ?, 1, 1, ?, ?)`,
        params: [
          scheduleId,
          WORKSPACE_ID,
          "00000000-0000-7000-8000-0000000000e3",
          new Date(Date.now() + 600_000).toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      }],
    });

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      const stuckAt = new Date(Date.now() - 1_000).toISOString();
      state.storage.sql.exec(
        `UPDATE schedules SET next_run_at = ? WHERE id = ? AND workspace_id = ?`,
        stuckAt,
        scheduleId,
        WORKSPACE_ID,
      );
      // A handler that returns without moving its row. Before the stall gate
      // the re-derive put the same past instant straight back and the re-arm
      // floored it at the next millisecond: one wake per handler duration,
      // for as long as the row stayed put.
      scheduling(instance).runScheduledAlarm = () => Promise.resolve();
      await instance.refreshSchedule(WORKSPACE_ID);

      const first = Date.now();
      await instance.alarm();

      const gated = store.get("schedule", scheduleId);
      expect(gated?.dueAt).toBe(Date.parse(stuckAt));
      expect(gated?.attempt).toBe(1);
      expect(gated!.retryAt).toBeGreaterThanOrEqual(first + scheduledAlarmRetryDelay(1, () => 0));
      expect(gated!.retryAt).toBeLessThanOrEqual(Date.now() + scheduledAlarmRetryDelay(1, () => 1));
      expect(await state.storage.getAlarm()).toBe(gated!.retryAt);

      // The attempt carries across the settle-and-reinsert, so the delay keeps
      // growing toward the ceiling instead of restarting at its first step on
      // every wake. The gate is opened by hand rather than waited out.
      state.storage.sql.exec(
        `UPDATE _internal_durable_alarms SET retry_at = 0 WHERE kind = 'schedule' AND alarm_key = ?`,
        scheduleId,
      );
      const second = Date.now();
      await instance.alarm();

      const again = store.get("schedule", scheduleId);
      expect(again?.attempt).toBe(2);
      expect(again!.retryAt).toBeGreaterThanOrEqual(second + scheduledAlarmRetryDelay(2, () => 0));
      expect(again!.retryAt).toBeLessThanOrEqual(Date.now() + scheduledAlarmRetryDelay(2, () => 1));
      expect(await state.storage.getAlarm()).toBe(again!.retryAt);
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
    // Inspect in the same event, before an immediate mutation-push alarm can fire.
    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      await instance.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [{
          kind: "parent_effect" as const,
          contractVersion: 1 as const,
          region: "global" as const,
          workspaceId: WORKSPACE_ID,
          parentKind: "workstream" as const, parentId: WORKSTREAM_ID,
          generation: 1,
          messageId: "00000000-0000-7000-8000-0000000000e9",
          partitionKey: "common",
          sourceVersion: 1,
          requiredProjectionVersion: null,
          payloadHash: conversationEffectHash(effect),
          effect,
        }],
      });

      const entries = new ScheduledAlarmStore(state.storage.sql).list("terminal");
      expect(entries.map((entry) => entry.key)).toEqual([WORKSTREAM_ID]);
      expect(entries[0]!.dueAt).toBe(dueAt);
      // The directory mutation may also have an earlier authorization push.
      // Its shared alarm must still wake in time for the registered deadline.
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(dueAt);
    });
  });

  it("reconciles itself once from the entry its alarm migration leaves behind", async () => {
    await seedOpenAuthority();
    const stub = await initializedWorkspace();
    const dueAt = new Date(Date.now() + 90_000).toISOString();
    await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000000c1",
      statements: [{
        sql: `INSERT INTO schedules
                (id, workspace_id, connector_connection_id, schedule_type, interval_seconds,
                 timezone, next_run_at, enabled, version, created_at, updated_at)
              VALUES (?, ?, ?, 'interval', 300, 'UTC', ?, 1, 1, ?, ?)`,
        params: [
          "00000000-0000-7000-8000-0000000000c2",
          WORKSPACE_ID,
          "00000000-0000-7000-8000-0000000000c3",
          dueAt,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      }],
    });

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const store = new ScheduledAlarmStore(state.storage.sql);
      // An object carried over from before the alarm index existed: the row is
      // there, nothing has ever reconciled it, and the object that used to hold
      // its alarm has been deleted. This is the state the migration's one-shot
      // entry exists for. The entry is written directly here — that migration 5
      // writes it, and only for a carried-over object, is proved against the
      // ledger itself in `test/workspace-do-schema.test.ts`; what needs the real
      // runtime is what the alarm does when it finds one.
      store.cancelKind("schedule");
      store.schedule({ kind: "schedule_bootstrap", key: "workspace", dueAt: Date.now() - 1 });

      await instance.alarm();

      expect(store.list("schedule").map((entry) => entry.key))
        .toEqual(["00000000-0000-7000-8000-0000000000c2"]);
      // One-shot: a second wake must not spend another reconcile on it.
      expect(store.list("schedule_bootstrap")).toEqual([]);
      expect(await state.storage.getAlarm()).toBe(Date.parse(dueAt));
    });
  });

  it("leaves a workspace created after the migration nothing to bootstrap", async () => {
    const stub = await initializedWorkspace();

    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      // The ledger runs before this object has an identity, so a new workspace
      // never pays for a reconcile that can only find zero targets.
      expect(new ScheduledAlarmStore(state.storage.sql).list("schedule_bootstrap")).toEqual([]);
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
        .schedule({ kind: "maintenance", key: "resource_slugs", dueAt: now - 60_000 }, now);
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
      expect(new ScheduledAlarmStore(state.storage.sql).get("maintenance", "resource_slugs")?.dueAt)
        .toBe(now - 60_000);
    });
  });
});

describe("an agent's own wake-ups", () => {
  it("keeps a future timer visible behind an overdue timer during a run drain", async () => {
    await seedOpenAuthority();
    const agent = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await agent.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream" as const, parentId: WORKSTREAM_ID,
      generation: 1,
    });

    await runInDurableObject(agent, async (instance, state) => {
      const now = Date.now();
      const future = now + 1_000;
      const store = new ScheduledAlarmStore(state.storage.sql);
      store.schedule({ kind: "agent_timer", key: "overdue", dueAt: now - 60_000 }, now);
      store.schedule({ kind: "agent_timer", key: "future", dueAt: future }, now);

      await scheduling(instance).armAlarmDuringRunDrain(now);

      // The drain-owned recovery wake is later than this real future timer.
      // Collapsing the stored list to its overdue minimum used to floor the
      // result at `now + 1` and hide this deadline.
      expect(await state.storage.getAlarm()).toBe(future);
    });
  });

  it("indexes every pending wake-up so one alarm can fire them all", async () => {
    await seedOpenAuthority();
    const agent = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await agent.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream" as const, parentId: WORKSTREAM_ID,
      generation: 1,
    });
    const dueAt = Date.now() + 120_000;
    await runInDurableObject(agent, (_instance, state) => {
      // Arrange a delivered initial projection so the next alarm belongs to these timers.
      state.storage.sql.exec('DELETE FROM authorization_projection_outbox');
      state.storage.sql.exec('UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL');
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
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await agent.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream" as const, parentId: WORKSTREAM_ID,
      generation: 1,
    });
    await runInDurableObject(agent, (_instance, state) => {
      // This case owns only timer work; initial projections have been delivered.
      state.storage.sql.exec("DELETE FROM authorization_projection_outbox");
      state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
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

  it("fires a Breakout's wake-up from the Breakout's own object, not Main's", async () => {
    await seedOpenAuthority();
    const breakoutId = asSubstreamId("00000000-0000-7000-8000-0000000000b1");
    // Main exists and holds no wake-ups, as in production: a read that reached
    // it got a clean "no such row" rather than an error.
    const main = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const breakout = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, breakoutId),
    ));
    for (const [stub, substreamId] of [[main, undefined], [breakout, breakoutId]] as const) {
      await stub.bootstrapRuntime({
        workspaceId: WORKSPACE_ID,
        parentKind: "workstream" as const, parentId: WORKSTREAM_ID,
        generation: 1,
        ...(substreamId ? { substreamId } : {}),
      });
    }
    await runInDurableObject(breakout, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM authorization_projection_outbox");
      state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
      // A principal of another workspace: the fire claims the row and then
      // declines to run it, so the test stops short of a model.
      state.storage.sql.exec(
        `INSERT INTO workstream_wakeups
           (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at, status,
            idempotency_key, fired_at, cancelled_at, version, created_at, updated_at)
         VALUES ('breakout-wake', NULL, ?, 'Check the build', ?, 'pending',
                 'idempotency-breakout', NULL, NULL, 1, ?, ?)`,
        JSON.stringify({ type: "workspace", workspaceId: "00000000-0000-7000-8000-0000000000ff" }),
        Date.now() - 60_000,
        Date.now() - 120_000,
        Date.now() - 120_000,
      );
    });
    await breakout.refreshTimerAlarm({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      substreamId: breakoutId,
    });

    await runDurableObjectAlarm(breakout);

    await runInDurableObject(breakout, (_instance, state) => {
      // Claimed and settled. A timer that read Main's empty table left this
      // `pending`, and the stall gate held it behind an ever-growing attempt.
      expect(state.storage.sql.exec(
        `SELECT status FROM workstream_wakeups WHERE wakeup_id = 'breakout-wake'`,
      ).toArray()).toEqual([{ status: "fired" }]);
      expect(new ScheduledAlarmStore(state.storage.sql).list("agent_timer")).toEqual([]);
    });
  });
});
