import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSocketEventSchema } from "@avalon/contracts";

import {
  calculateNextOccurrence,
  schedulerRetryDelay,
  type ScheduleTiming,
  WorkspaceScheduler,
  workspaceSchedulerName
} from "../src/durable-objects/workspace-scheduler";
import {
  consumeSocketTicket,
  distinctNonParticipantViewers,
  isPersonalEventAudience,
  planSocketReplay,
  workstreamRoomName,
} from "../src/durable-objects/workstream-room";
import { durableObjectNamespaceForRegion } from "../src/lib/durable-object-namespace";

function timing(overrides: Partial<ScheduleTiming> = {}): ScheduleTiming {
  return {
    next_run_at: "2026-01-01T00:00:00.000Z",
    interval_seconds: null,
    rrule: null,
    timezone: "UTC",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime component invariants", () => {
  it("uses a region/workspace/work-stream stable room name", () => {
    expect(workstreamRoomName("eu", "workspace-id", "workstream-id")).toBe(
      "eu:workspace-id:workstream-id"
    );
    expect(workspaceSchedulerName("global", "workspace-id")).toBe("global:workspace-id");
  });

  it("delivers personal room events only to the authenticated target user", () => {
    expect(isPersonalEventAudience("user-one", "user-one")).toBe(true);
    expect(isPersonalEventAudience("user-two", "user-one")).toBe(false);
  });

  it("pins EU Durable Object IDs to the EU jurisdiction namespace", () => {
    const euNamespace = {} as DurableObjectNamespace;
    const jurisdiction = vi.fn(() => euNamespace);
    const namespace = { jurisdiction } as unknown as DurableObjectNamespace;

    expect(durableObjectNamespaceForRegion(namespace, "eu")).toBe(euNamespace);
    expect(jurisdiction).toHaveBeenCalledWith("eu");
    expect(durableObjectNamespaceForRegion(namespace, "global")).toBe(namespace);
    expect(durableObjectNamespaceForRegion(namespace, "eu", "development")).toBe(namespace);
  });

  it("replays an available in-memory window and explicitly resyncs after hibernation", () => {
    const event = ServerSocketEventSchema.parse({
      type: "harness_status_changed",
      sequence: 12,
      occurredAt: "2026-01-01T00:00:00.000Z",
      status: "running",
    });

    expect(planSocketReplay(11, 12, 11, [event])).toEqual({ type: "replay", events: [event] });
    expect(planSocketReplay(11, 12, null, [])).toEqual({
      type: "resync_required",
      reason: "history_unavailable",
    });
    expect(planSocketReplay(13, 12, 11, [event])).toEqual({
      type: "resync_required",
      reason: "sequence_ahead",
    });
    expect(planSocketReplay(0, 12, null, [])).toEqual({ type: "snapshot" });
    const firstEvent = { ...event, sequence: 1 };
    expect(planSocketReplay(0, 1, 0, [firstEvent], false)).toEqual({
      type: "replay",
      events: [firstEvent],
    });
  });

  it("skips missed interval ticks without creating a catch-up storm", () => {
    expect(
      calculateNextOccurrence(
        timing({ interval_seconds: 300 }),
        new Date("2026-01-01T00:12:00.000Z")
      )
    ).toBe("2026-01-01T00:15:00.000Z");
  });

  it("calculates the next RRULE occurrence after the claimed due time", () => {
    expect(
      calculateNextOccurrence(
        timing({ rrule: "FREQ=DAILY;COUNT=3" }),
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("bounds scheduler retry backoff with equal jitter", () => {
    expect(schedulerRetryDelay(1, () => 0)).toBe(30_000);
    expect(schedulerRetryDelay(2, () => 0)).toBe(60_000);
    expect(schedulerRetryDelay(99, () => 0.999)).toBeLessThanOrEqual(30 * 60_000);
  });

  it("persists a retry gate so a failed due target cannot create a one-second alarm loop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);

    const workspaceId = "00000000-0000-7000-8000-000000000001";
    const scheduleId = "00000000-0000-7000-8000-000000000002";
    const schedule = {
      id: scheduleId,
      workspace_id: workspaceId,
      automation_subscription_id: null,
      connector_connection_id: null,
      schedule_type: "interval",
      rrule: null,
      interval_seconds: 300,
      timezone: "UTC",
      next_run_at: "2025-12-31T23:59:00.000Z",
      last_run_at: null,
      enabled: 1,
      version: 1,
      created_at: "2025-12-31T23:54:00.000Z",
      updated_at: "2025-12-31T23:54:00.000Z",
    };
    const values = new Map<string, unknown>([["workspaceId", workspaceId]]);
    const setAlarm = vi.fn(async (at: number) => { void at; });
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key),
      setAlarm,
      deleteAlarm: vi.fn(async () => undefined),
    } as unknown as DurableObjectStorage;
    let auditWrites = 0;
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        all: async () => {
          // The alarm-target union names every due-dated table, so it has to be
          // matched before the per-table due scans that share those names.
          if (sql.includes("AS target_kind")) {
            return {
              results: [{ target_kind: "schedule", id: scheduleId, due_at: schedule.next_run_at }],
            };
          }
          if (sql.includes("SELECT *") && sql.includes("FROM schedules")) {
            return { results: [schedule] };
          }
          if (sql.includes("SELECT id, workspace_id, connection_id, next_poll_at")) {
            return { results: [] };
          }
          if (sql.includes("FROM workstream_wakeups")) {
            return { results: [] };
          }
          throw new Error(`Unexpected all query: ${sql}`);
        },
        run: async () => {
          if (sql.includes("INSERT INTO audit_events")) auditWrites += 1;
          return { meta: { changes: 1 } };
        },
      })),
    }));
    const scheduler = new WorkspaceScheduler(
      { storage } as unknown as DurableObjectState,
      { DB: { prepare } } as never,
    );

    await scheduler.alarm();
    const firstAlarm = setAlarm.mock.calls.at(-1)?.[0];
    expect(firstAlarm).toBe(Date.now() + 30_000);
    expect(auditWrites).toBe(1);

    await scheduler.alarm();
    expect(setAlarm.mock.calls.at(-1)?.[0]).toBe(firstAlarm);
    expect(auditWrites).toBe(1);
  });

  it("keeps a local calendar hour across the daylight-saving boundary", () => {
    expect(
      calculateNextOccurrence(
        timing({
          next_run_at: "2026-03-07T17:00:00.000Z",
          created_at: "2026-03-07T17:00:00.000Z",
          timezone: "America/Los_Angeles",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        }),
        new Date("2026-03-07T17:00:00.000Z"),
      ),
    ).toBe("2026-03-08T16:00:00.000Z");
  });

  it("consumes each signed socket ticket identity only once", async () => {
    const values = new Map<string, unknown>();
    type Transaction = {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    };
    const transaction: Transaction = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
    };
    const storage = {
      transaction: async (callback: (value: Transaction) => Promise<boolean>) => callback(transaction),
      list: async () => new Map(values) as Map<string, number>,
      delete: async (keys: string[]) => {
        for (const key of keys) values.delete(key);
        return true;
      },
    } as unknown as DurableObjectStorage;

    await expect(consumeSocketTicket(storage, "ticket-1", 2_000, 1_000)).resolves.toBe(true);
    await expect(consumeSocketTicket(storage, "ticket-1", 2_000, 1_000)).resolves.toBe(false);
  });

  it("keeps active participants out of the ephemeral viewer list", () => {
    const viewers = distinctNonParticipantViewers([
      { userId: "participant", connectedAt: "2026-01-01T00:00:00.000Z" },
      { userId: "viewer", connectedAt: "2026-01-01T00:01:00.000Z" },
      { userId: "viewer", connectedAt: "2026-01-01T00:02:00.000Z" },
    ], new Set(["participant"]));
    expect(viewers).toEqual([
      { userId: "viewer", connectedAt: "2026-01-01T00:01:00.000Z" },
    ]);
  });

  it("disables a one-shot schedule after it runs", () => {
    expect(calculateNextOccurrence(timing(), new Date("2026-01-01T00:00:00.000Z"))).toBeNull();
  });
});
