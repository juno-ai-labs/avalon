import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSocketEventSchema } from "@avalon/contracts";
import { DatabaseSync } from "node:sqlite";

import {
  calculateNextOccurrence,
  runIsolatedSchedulerMaintenance,
  schedulerRetryDelay,
  type ScheduleTiming,
  WorkspaceScheduler,
  workspaceSchedulerName
} from "../src/durable-objects/workspace-scheduler";
import {
  applyActiveStreamCheckpointEvent,
  distinctNonParticipantViewers,
  isPersonalEventAudience,
  planSocketReplay,
  splitActiveStreamCheckpointText,
  substreamAgentName,
} from "../src/durable-objects/substream-agent";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import {
  assertDurableObjectJurisdiction,
  deriveWorkspacePlacementAffinity,
  durableObjectStubForRegion,
  durableObjectStubForWorkspace,
} from "../src/lib/durable-object-namespace";
import type { Env } from "../src/env";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
  createTestJurisdictionalDurableObjectId,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

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
  it("isolates scheduler maintenance failures so later work still runs", async () => {
    const later = vi.fn(async () => undefined);
    const rejected = vi.fn();

    await runIsolatedSchedulerMaintenance([
      () => { throw new Error("reaper_failed"); },
      later,
    ], rejected);

    expect(later).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: "reaper_failed" }), 0);
  });

  it.each([
    ["global", "-122.4194", "wnam"],
    ["global", "-73.9857", "enam"],
    ["eu", "-0.1276", "weur"],
    ["eu", "30.5234", "eeur"],
  ] as const)("derives %s workspace affinity from request longitude %s", (region, longitude, expected) => {
    expect(deriveWorkspacePlacementAffinity(region, { longitude })).toEqual({
      affinity: expected,
      source: "request_longitude",
    });
  });

  it.each([
    ["global", undefined, "wnam"],
    ["eu", { longitude: "not-a-coordinate" }, "weur"],
  ] as const)("uses the %s migration/background fallback when request metadata is absent", (
    region,
    metadata,
    expected,
  ) => {
    expect(deriveWorkspacePlacementAffinity(region, metadata)).toEqual({
      affinity: expected,
      source: "missing_request_metadata",
    });
  });

  it("uses a region/workspace/work-stream stable room name", () => {
    expect(substreamAgentName(
      "eu",
      asWorkspaceId("00000000-0000-4000-8000-00000000000a"),
      asWorkstreamId("00000000-0000-4000-8000-00000000000b"),
    )).toBe(
      "eu:00000000-0000-4000-8000-00000000000a:00000000-0000-4000-8000-00000000000b"
    );
    expect(workspaceSchedulerName("global", "workspace-id")).toBe("global:workspace-id");
  });

  it("delivers personal room events only to the authenticated target user", () => {
    expect(isPersonalEventAudience("user-one", "user-one")).toBe(true);
    expect(isPersonalEventAudience("user-two", "user-one")).toBe(false);
  });

  it("locks Durable Object IDs and first placement to the product region", () => {
    const usStub = {};
    const euStub = {};
    const usId = createTestDurableObjectId("us-id");
    const euId = createTestDurableObjectId("eu-id");
    const usGet = vi.fn(() => usStub);
    const euGet = vi.fn(() => euStub);
    const usIdFromName = vi.fn(() => usId);
    const euIdFromName = vi.fn(() => euId);
    const usNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get: usGet,
      idFromName: usIdFromName,
    });
    const euNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get: euGet,
      idFromName: euIdFromName,
    });
    const jurisdiction = vi.fn((value: DurableObjectJurisdiction) => (
      value === "us" ? usNamespace : euNamespace
    ));
    const namespace = createCloudflareTestBinding<DurableObjectNamespace>({ jurisdiction });

    expect(durableObjectStubForRegion(
      namespace,
      "global",
      "workspace-one",
      "production",
      "wnam",
    )).toBe(usStub);
    expect(durableObjectStubForRegion(
      namespace,
      "eu",
      "workspace-two",
      "production",
      "weur",
    )).toBe(euStub);
    expect(jurisdiction.mock.calls).toEqual([["us"], ["eu"]]);
    expect(usIdFromName).toHaveBeenCalledWith("workspace-one");
    expect(euIdFromName).toHaveBeenCalledWith("workspace-two");
    expect(usGet).toHaveBeenCalledWith(usId, { locationHint: "wnam" });
    expect(euGet).toHaveBeenCalledWith(euId, { locationHint: "weur" });
  });

  it("uses one persisted workspace affinity for every child lookup", async () => {
    const first = vi.fn(async () => ({ placement_affinity: "enam" }));
    const bind = vi.fn();
    const statement = createTestD1PreparedStatement({
      bind,
      first,
    });
    bind.mockReturnValue(statement);
    const database = createTestD1Database({ prepare: vi.fn(() => statement) });
    const get = vi.fn(() => ({}));
    const regionalNamespace = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get,
    });
    const namespace = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      jurisdiction: vi.fn(() => regionalNamespace),
    });
    const env = createTestEnv({
      APP_ENV: "production",
      AVALON_REGION: "global",
      DB: database,
    });

    await durableObjectStubForWorkspace(env, namespace, "workspace-east", "child-one");
    await durableObjectStubForWorkspace(env, namespace, "workspace-east", "child-two");

    expect(first).toHaveBeenCalledOnce();
    expect(get).toHaveBeenNthCalledWith(1, expect.anything(), { locationHint: "enam" });
    expect(get).toHaveBeenNthCalledWith(2, expect.anything(), { locationHint: "enam" });
  });

  it("omits unsupported jurisdiction and location options in local workerd", () => {
    const stub = {};
    const id = createTestDurableObjectId("local-id");
    const get = vi.fn(() => stub);
    const idFromName = vi.fn(() => id);
    const jurisdiction = vi.fn();
    const namespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get,
      idFromName,
      jurisdiction,
    });

    expect(durableObjectStubForRegion(namespace, "eu", "local", "test", "eeur")).toBe(stub);
    expect(jurisdiction).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(id);
  });

  it("fails closed when a production object was created outside its jurisdiction", () => {
    expect(() => assertDurableObjectJurisdiction(
      createTestJurisdictionalDurableObjectId("us-object", "us"),
      "global",
      "production",
    )).not.toThrow();
    expect(() => assertDurableObjectJurisdiction(
      createTestJurisdictionalDurableObjectId("eu-object", "eu"),
      "global",
      "production",
    )).toThrow("durable_object_jurisdiction_mismatch:us:eu");
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

  it("checkpoints the exact active stream for subscribers joining mid-response", () => {
    const messageId = "00000000-0000-7000-8000-000000000010";
    const harnessRunId = "00000000-0000-7000-8000-000000000011";
    const at = "2026-01-01T00:00:00.000Z";
    expect(applyActiveStreamCheckpointEvent([], ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 9,
      occurredAt: at,
      messageId,
      harnessRunId,
      turnId: "turn-one",
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: "Missing prefix",
    }))).toEqual([]);
    let checkpoints = applyActiveStreamCheckpointEvent([], ServerSocketEventSchema.parse({
      type: "stream_started",
      sequence: 10,
      occurredAt: at,
      messageId,
      harnessRunId,
      turnId: "turn-one",
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 11,
      occurredAt: at,
      messageId,
      turnId: "turn-one",
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: "First answer.",
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_started",
      sequence: 12,
      occurredAt: at,
      messageId,
      harnessRunId,
      turnId: "turn-two",
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 13,
      occurredAt: at,
      messageId,
      turnId: "turn-two",
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: " Discard this attempt.",
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 14,
      occurredAt: at,
      messageId,
      turnId: "turn-two",
      epoch: 1,
      streamSeq: 2,
      reset: true,
      delta: " Final continuation.",
    }));

    expect(checkpoints).toEqual([expect.objectContaining({
      messageId,
      harnessRunId,
      text: "First answer. Final continuation.",
      turnStartOffset: "First answer.".length,
      roomSequence: 14,
      seenTurnIds: ["turn-one", "turn-two"],
    })]);

    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "harness_status_changed",
      sequence: 15,
      occurredAt: at,
      status: "running",
    }));
    expect(checkpoints).toHaveLength(1);

    const completed = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "harness_status_changed",
      sequence: 16,
      occurredAt: at,
      status: "completed",
    }));
    expect(completed).toEqual([]);
  });

  it("segments checkpoints before one Durable Object value can exceed its limit", () => {
    const text = `${"a".repeat(2_100_000)}😀${"z".repeat(35_000)}`;
    const chunks = splitActiveStreamCheckpointText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 60 * 1024)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => {
      const last = chunk.charCodeAt(chunk.length - 1);
      return !(last >= 0xD800 && last <= 0xDBFF);
    })).toBe(true);
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

  it("parks workspace alarms without reading due work during maintenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const setAlarm = vi.fn(async () => undefined);
    const objectDatabase = new DatabaseSync(":memory:");
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      setAlarm,
      transactionSync: <T>(body: () => T) => body(),
      sql: createTestSqlStorage(objectDatabase),
    });
    const first = vi.fn(async () => ({
      phase: "maintenance_draining",
      generation: 2,
      required_serving_contract_version: 1,
      serving_contract_version: 0,
    }));
    const prepare = vi.fn(() => ({ first }));
    const scheduler = new WorkspaceScheduler(
      createCloudflareTestBinding<DurableObjectState>({
        blockConcurrencyWhile: async (body: () => Promise<unknown>) => body(),
        storage,
      }),
      { DB: { prepare } } as never,
    );
    storage.sql.exec(
      `INSERT INTO workspace_scheduler_state(id, workspace_id, created_at, updated_at)
       VALUES (1, ?, 0, 0)`,
      "00000000-0000-7000-8000-000000000001",
    );

    await scheduler.alarm();

    expect(prepare).toHaveBeenCalledOnce();
    expect(setAlarm).toHaveBeenCalledWith(Date.now() + 5 * 60_000);
    objectDatabase.close();
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
    const objectDatabase = new DatabaseSync(":memory:");
    const setAlarm = vi.fn(async (at: number) => { void at; });
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      setAlarm,
      deleteAlarm: vi.fn(async () => undefined),
      transactionSync: <T>(body: () => T) => body(),
      sql: createTestSqlStorage(objectDatabase),
    });
    let auditWrites = 0;
    const prepare = vi.fn((sql: string) => ({
      first: async () => {
        if (sql.includes("FROM workstream_authority_control")) {
          return {
            phase: "durable_object_open",
            generation: 1,
            required_serving_contract_version: 1,
            serving_contract_version: 1,
          };
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
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
      createCloudflareTestBinding<DurableObjectState>({
        blockConcurrencyWhile: async (body: () => Promise<unknown>) => body(),
        storage,
      }),
      { DB: { prepare } } as never,
    );
    (scheduler as unknown as {
      workspaceDirectory: () => Promise<{
        dueWorkstreamDirectory: () => Promise<string[]>;
        workstreamScheduleTargets: () => Promise<{ items: [] }>;
      }>;
    }).workspaceDirectory = async () => ({
      dueWorkstreamDirectory: async () => [],
      workstreamScheduleTargets: async () => ({ items: [] }),
    });
    storage.sql.exec(
      `INSERT INTO workspace_scheduler_state(id, workspace_id, created_at, updated_at)
       VALUES (1, ?, 0, 0)`,
      workspaceId,
    );

    await scheduler.alarm();
    const firstAlarm = setAlarm.mock.calls.at(-1)?.[0];
    expect(firstAlarm).toBe(Date.now() + 30_000);
    expect(auditWrites).toBe(1);

    await scheduler.alarm();
    expect(setAlarm.mock.calls.at(-1)?.[0]).toBe(firstAlarm);
    expect(auditWrites).toBe(1);
    objectDatabase.close();
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
    const database = new DatabaseSync(":memory:");
    const values = new Map<string, unknown>();
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      get: async (key: string | string[]) => Array.isArray(key)
        ? new Map(key.flatMap((entry) => values.has(entry) ? [[entry, values.get(entry)]] : []))
        : values.get(key),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map(
        [...values].filter(([key]) => key.startsWith(prefix)),
      ),
      delete: async (key: string | string[]) => {
        if (Array.isArray(key)) {
          let deleted = 0;
          for (const entry of key) if (values.delete(entry)) deleted += 1;
          return deleted;
        }
        return values.delete(key);
      },
      transactionSync: (callback: () => unknown) => callback(),
      sql: createTestSqlStorage(database),
    });
    const store = new WorkstreamObjectStore(storage, "test", "global");
    await store.waitUntilReady();

    expect(store.consumeSocketTicket("ticket-1", 2_000, 1_000)).toBe(true);
    expect(store.consumeSocketTicket("ticket-1", 2_000, 1_000)).toBe(false);
    database.close();
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
