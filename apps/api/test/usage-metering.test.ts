import "../../../tests/isolated-region";
import type { UsageEvent } from "@rally/contracts/usage";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeUsageQueue } from "../src/queues/usage-consumer";
import { applyUsageBatch, readOrganizationUsage, setWorkspacePlan } from "../src/services/usage-metering";
import type { Env } from "../src/env";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, migratedUsageSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const OWNER = "01900000-0000-7000-8000-000000000001";
const WORKSPACE = "01900000-0000-7000-8000-0000000000aa";
// A Thursday at 9:00 AM UTC; weeks reset Thursdays at 9:00, periods on the 1st.
const CREATED = "2026-10-01T09:00:00.000Z";
const RECEIVED = "2026-11-02T00:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

/** The regional database holds the workspace; the usage database holds the ledger. */
function seed(): { database: DatabaseSync; usage: DatabaseSync; env: { DB: D1Database; USAGE_DB: D1Database; AVALON_REGION: string } } {
  const database = migratedSqliteDatabase();
  const usage = migratedUsageSqliteDatabase();
  databases.push(database, usage);
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'google-owner', 'owner@example.test', 'Owner', ?, ?)`,
  ).run(OWNER, CREATED, CREATED);
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Juno Labs', 'juno', 'global', ?, ?, ?)`,
  ).run(WORKSPACE, OWNER, CREATED, CREATED);
  return { database, usage, env: { DB: sqliteD1(database), USAGE_DB: sqliteD1(usage), AVALON_REGION: "global" } };
}

function event(eventId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    v: 1,
    eventId,
    workspaceId: WORKSPACE,
    region: "global",
    activity: "agent_run",
    occurredAt: "2026-10-02T12:00:00.000Z",
    costMicrousd: 1_000_000,
    model: "test/model",
    refs: { workstreamId: "ws-1" },
    ...overrides,
  };
}

function rollups(database: DatabaseSync): unknown[] {
  return database.prepare(
    `SELECT week_start, period_start, quota_microusd, organization_microusd, rally_microusd
       FROM usage_rollups ORDER BY week_start, period_start`,
  ).all();
}

describe("applyUsageBatch", () => {
  it("counts an event once when two copies arrive in one batch and again later", async () => {
    const { usage, env } = seed();
    const first = await applyUsageBatch(env, [event("inf:a"), event("inf:a"), event("inf:b")], RECEIVED);
    const replay = await applyUsageBatch(env, [event("inf:a")], RECEIVED);

    expect(first).toMatchObject({ applied: 2, duplicates: 1 });
    expect(replay).toMatchObject({ applied: 0, duplicates: 1 });
    expect(usage.prepare(`SELECT COUNT(*) AS count FROM usage_events`).get()).toEqual({ count: 2 });
    expect(rollups(usage)).toEqual([{
      week_start: "2026-10-01T09:00:00.000Z",
      period_start: "2026-10-01T09:00:00.000Z",
      quota_microusd: 50_000_000,
      organization_microusd: 2_000_000,
      rally_microusd: 0,
    }]);
  });

  it("splits a week that crosses the monthly anniversary into two rows", async () => {
    const { usage, env } = seed();
    await applyUsageBatch(env, [
      event("inf:before", { occurredAt: "2026-10-30T12:00:00.000Z", costMicrousd: 40_000_000 }),
      event("inf:after", { occurredAt: "2026-11-01T12:00:00.000Z", costMicrousd: 20_000_000 }),
    ], RECEIVED);

    expect(rollups(usage)).toEqual([
      { week_start: "2026-10-29T09:00:00.000Z", period_start: "2026-10-01T09:00:00.000Z", quota_microusd: 50_000_000, organization_microusd: 40_000_000, rally_microusd: 0 },
      { week_start: "2026-10-29T09:00:00.000Z", period_start: "2026-11-01T09:00:00.000Z", quota_microusd: 50_000_000, organization_microusd: 20_000_000, rally_microusd: 0 },
    ]);
  });
});

describe("readOrganizationUsage", () => {
  it("derives the same overage whichever order the events arrive in", async () => {
    const before = event("inf:before", { occurredAt: "2026-10-30T12:00:00.000Z", costMicrousd: 40_000_000 });
    const after = event("inf:after", { occurredAt: "2026-11-01T12:00:00.000Z", costMicrousd: 20_000_000 });
    const readings = [];
    for (const order of [[before, after], [after, before]]) {
      const { env } = seed();
      for (const one of order) await applyUsageBatch(env, [one], RECEIVED);
      readings.push(await readOrganizationUsage(env, WORKSPACE, Date.parse("2026-11-02T00:00:00.000Z")));
    }

    expect(readings[0]).toEqual({
      plan: "starter",
      quotaRemainingPercent: 0,
      weekResetsAt: "2026-11-05T09:00:00.000Z",
      overage: { amountMicrousd: 10_000_000, periodStart: "2026-11-01T09:00:00.000Z", periodEndsAt: "2026-12-01T09:00:00.000Z", billed: false },
    });
    expect(readings[1]).toEqual(readings[0]);
  });

  it("re-prices the current week at once when the plan changes", async () => {
    const { database, env } = seed();
    await applyUsageBatch(env, [event("inf:big", { costMicrousd: 70_000_000 })], RECEIVED);
    const now = Date.parse("2026-10-03T00:00:00.000Z");
    expect(await readOrganizationUsage(env, WORKSPACE, now)).toMatchObject({ quotaRemainingPercent: 0, overage: { amountMicrousd: 20_000_000 } });

    await setWorkspacePlan(env, WORKSPACE, "growth", now);

    expect(await readOrganizationUsage(env, WORKSPACE, now)).toMatchObject({ plan: "growth", quotaRemainingPercent: 44, overage: { amountMicrousd: 0 } });
    expect(database.prepare(`SELECT plan FROM workspaces WHERE id = ?`).get(WORKSPACE)).toEqual({ plan: "growth" });
  });

  it("reads 100% in a new week and nothing for an unknown Organization", async () => {
    const { env } = seed();
    await applyUsageBatch(env, [event("inf:x", { costMicrousd: 40_000_000 })], RECEIVED);

    expect(await readOrganizationUsage(env, WORKSPACE, Date.parse("2026-10-09T00:00:00.000Z")))
      .toMatchObject({ quotaRemainingPercent: 100, weekResetsAt: "2026-10-15T09:00:00.000Z" });
    expect(await readOrganizationUsage(env, "01900000-0000-7000-8000-0000000000bb", Date.now())).toBeNull();
  });
});

describe("consumeUsageQueue", () => {
  it("applies valid events, acks an unreadable one and retries one from another region", async () => {
    const { usage, env } = seed();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const acked: string[] = [];
    const retried: string[] = [];
    const queued = (id: string, body: unknown) => ({
      id,
      timestamp: new Date(RECEIVED),
      body,
      attempts: 1,
      ack: () => { acked.push(id); },
      retry: () => { retried.push(id); },
    }) satisfies Message<unknown>;
    await consumeUsageQueue({
      queue: "avalon-global-usage",
      messages: [
        queued("good", event("inf:good")),
        queued("unreadable", { v: 1, eventId: "inf:bad" }),
        queued("elsewhere", event("inf:eu", { region: "eu" })),
      ],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } satisfies MessageBatch<unknown>, { ...env, AVALON_REGION: "global", APP_ENV: "test", LOG_LEVEL: "error" }, () => Date.parse(RECEIVED));

    expect(acked.sort()).toEqual(["good", "unreadable"]);
    expect(retried).toEqual(["elsewhere"]);
    expect(usage.prepare(`SELECT event_id, activity, organization_pays, workstream_id FROM usage_events`).all())
      .toEqual([{ event_id: "inf:good", activity: "agent_run", organization_pays: 1, workstream_id: "ws-1" }]);
  });

  it("sends the whole batch to the lakehouse before D1, so a failed send leaves D1 untouched", async () => {
    const { usage, env } = seed();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const acked: string[] = [];
    const queued = (id: string, body: unknown) => ({
      id, timestamp: new Date(RECEIVED), body, attempts: 1,
      ack: () => { acked.push(id); }, retry: vi.fn(),
    }) satisfies Message<unknown>;
    const batch = (): MessageBatch<unknown> => ({
      queue: "avalon-global-usage",
      messages: [queued("one", event("inf:one", { costMicrousd: 2_000_000 })), queued("again", event("inf:one", { costMicrousd: 2_000_000 }))],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(), ackAll: vi.fn(),
    });
    const consumerEnv = (send: (records: unknown[]) => Promise<void>) => ({
      ...env, APP_ENV: "test" as const, LOG_LEVEL: "error" as const,
      USAGE_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["USAGE_LAKEHOUSE"]>>({ send }),
    });

    await expect(consumeUsageQueue(batch(), consumerEnv(async () => { throw new Error("pipeline_unavailable"); }), () => Date.parse(RECEIVED)))
      .rejects.toThrow("pipeline_unavailable");
    expect(acked).toEqual([]);
    expect(usage.prepare(`SELECT COUNT(*) AS count FROM usage_events`).get()).toEqual({ count: 0 });

    const sent: unknown[] = [];
    await consumeUsageQueue(batch(), consumerEnv(async (records) => { sent.push(...records); }), () => Date.parse(RECEIVED));
    // Both copies reach R2, where readers deduplicate; D1 counts one.
    expect(sent).toEqual([
      expect.objectContaining({ event_id: "inf:one", workspace_id: WORKSPACE, activity: "agent_run", cost_microusd: 2_000_000, organization_pays: true, received_at: RECEIVED, workstream_id: "ws-1", sidekick_id: null }),
      expect.objectContaining({ event_id: "inf:one" }),
    ]);
    expect(usage.prepare(`SELECT COUNT(*) AS count FROM usage_events`).get()).toEqual({ count: 1 });
  });
});
