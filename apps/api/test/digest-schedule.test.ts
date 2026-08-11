import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { DigestService, dayMaskFromDays, daysFromDayMask, digestRRule } from "../src/services/digest-service";
import {
  latestActivityEventCursor,
  listActivityEventsForUser,
  recordActivityEventOrThrow,
} from "../src/services/activity-event-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const OWNER = "00000000-0000-7000-8000-000000000002";
const OTHER = "00000000-0000-7000-8000-000000000003";
const WORKSTREAM = "00000000-0000-7000-8000-000000000004";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: OWNER,
  workspaceId: WORKSPACE,
  region: "global",
  role: "owner",
};

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function envFor(database: DatabaseSync): Env {
  return {
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    WORKSPACE_SCHEDULERS: {
      idFromName: () => "scheduler",
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    },
  } as unknown as Env;
}

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${OWNER}', 'google-owner', 'owner@example.com', 'Owner', 'Europe/London', '2026-01-01', '2026-01-01'),
           ('${OTHER}', 'google-other', 'other@example.com', 'Other', 'Europe/London', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01'),
           ('${WORKSPACE}', '${OTHER}', 'member', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Launch', '', 'ad_hoc', '${OTHER}',
            'idle', 1, '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  return database;
}

describe("digest recurrence", () => {
  it("emits one weekly rule per delivery time", () => {
    // A single rule cannot carry a list of times: BYHOUR and BYMINUTE multiply
    // out, so 09:00 plus 12:30 would also fire at 09:30 and 12:00.
    expect(digestRRule([1, 2, 3, 4, 5], 9 * 60)).toBe(
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    );
    expect(digestRRule([0, 6], 12 * 60 + 30)).toBe(
      "FREQ=WEEKLY;BYDAY=SU,SA;BYHOUR=12;BYMINUTE=30;BYSECOND=0",
    );
  });

  it("round-trips a day set through its bit mask", () => {
    for (const days of [[], [0], [1, 2, 3, 4, 5], [0, 6], [0, 1, 2, 3, 4, 5, 6]]) {
      expect(daysFromDayMask(dayMaskFromDays(days))).toEqual(days);
    }
  });
});

describe("digest schedule", () => {
  it("offers an unsaved weekday default in the reader's own timezone", async () => {
    const schedule = await new DigestService(envFor(seededDatabase()), auth).get();

    expect(schedule.enabled).toBe(false);
    expect(schedule.days).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.timezone).toBe("Europe/London");
    expect(schedule.deliveryTargets).toEqual([]);
  });

  it("derives one schedule row per time and freezes the account email", async () => {
    const database = seededDatabase();

    const saved = await new DigestService(envFor(database), auth).replace({
      enabled: true,
      days: [1, 3, 5],
      times: [16 * 60, 9 * 60, 12 * 60],
      timezone: "America/Los_Angeles",
      deliveryTargets: [{ type: "email", connectionId: null }],
    });

    // Times come back sorted regardless of the order they were sent in.
    expect(saved.times).toEqual([9 * 60, 12 * 60, 16 * 60]);
    expect(saved.deliveryTargets).toEqual([expect.objectContaining({
      type: "email",
      displayName: "owner@example.com",
      status: "active",
    })]);
    const rules = database.prepare(
      "SELECT rrule FROM schedules WHERE digest_schedule_id IS NOT NULL ORDER BY rrule",
    ).all() as Array<{ rrule: string }>;
    expect(rules.map((row) => row.rrule)).toEqual([
      "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=12;BYMINUTE=0;BYSECOND=0",
      "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=16;BYMINUTE=0;BYSECOND=0",
      "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    ]);
    expect(saved.nextRunAt).not.toBeNull();
  });

  it("leaves nothing in the scheduler when the digest is switched off", async () => {
    const database = seededDatabase();
    const service = new DigestService(envFor(database), auth);
    await service.replace({
      enabled: true,
      days: [1],
      times: [9 * 60],
      timezone: "America/Los_Angeles",
      deliveryTargets: [{ type: "email", connectionId: null }],
    });

    const disabled = await service.replace({
      enabled: false,
      days: [1],
      times: [9 * 60],
      timezone: "America/Los_Angeles",
      deliveryTargets: [{ type: "email", connectionId: null }],
    });

    // The configuration survives so re-enabling is a save, not a rebuild; only
    // the rows that can actually fire are gone.
    expect(disabled.days).toEqual([1]);
    expect(disabled.times).toEqual([9 * 60]);
    expect(disabled.nextRunAt).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM schedules").get()).toEqual({ count: 0 });
  });

  it("replaces rather than accumulates on a second save", async () => {
    const database = seededDatabase();
    const service = new DigestService(envFor(database), auth);
    const save = (times: number[]) => service.replace({
      enabled: true,
      days: [1, 2],
      times,
      timezone: "America/Los_Angeles",
      deliveryTargets: [{ type: "email", connectionId: null }],
    });

    await save([9 * 60, 12 * 60]);
    const second = await save([17 * 60]);

    expect(second.times).toEqual([17 * 60]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schedules").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM digest_schedules").get()).toEqual({ count: 1 });
  });

  it("refuses a destination the person cannot actually be reached at", async () => {
    const database = seededDatabase();

    await expect(new DigestService(envFor(database), auth).replace({
      enabled: true,
      days: [1],
      times: [9 * 60],
      timezone: "America/Los_Angeles",
      // No Slack connection exists, so the frozen identity cannot be resolved.
      deliveryTargets: [{ type: "slack_agent_dm", connectionId: WORKSTREAM }],
    })).rejects.toMatchObject({ status: 422, code: "delivery_target_unavailable" });
    // Nothing is half-written: the schedule is resolved before anything is saved.
    expect(database.prepare("SELECT COUNT(*) AS count FROM digest_schedules").get()).toEqual({ count: 0 });
  });

  it("recomputes the workspace alarm only after the rows are written", async () => {
    const database = seededDatabase();
    const scheduleCountAtRefresh = vi.fn();
    const env = {
      ...envFor(database),
      WORKSPACE_SCHEDULERS: {
        idFromName: () => "scheduler",
        get: () => ({
          fetch: async () => {
            scheduleCountAtRefresh(database.prepare("SELECT COUNT(*) AS count FROM schedules").get());
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as unknown as Env;

    await new DigestService(env, auth).replace({
      enabled: true,
      days: [1],
      times: [9 * 60],
      timezone: "America/Los_Angeles",
      deliveryTargets: [{ type: "email", connectionId: null }],
    });

    // The Durable Object reads D1, so refreshing early would arm the alarm from
    // the rows the save has just replaced.
    expect(scheduleCountAtRefresh).toHaveBeenCalledWith({ count: 1 });
  });
});

describe("activity event visibility", () => {
  async function record(env: Env, overrides: Partial<Parameters<typeof recordActivityEventOrThrow>[1]>) {
    return await recordActivityEventOrThrow(env, {
      workspaceId: WORKSPACE,
      eventType: "workstream.message.posted",
      subjectType: "workstream",
      subjectId: WORKSTREAM,
      actorType: "user",
      actorUserId: OTHER,
      actorLabel: "Other",
      title: "Launch",
      audience: { kind: "workstream", workstreamId: WORKSTREAM },
      occurredAt: "2026-01-02T09:00:00.000Z",
      sourceKind: "message",
      dedupeKey: `event-${Math.random()}`,
      ...overrides,
    });
  }

  it("keeps a work-stream event from anyone who is not a participant", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await record(env, { dedupeKey: "message:1" });

    const through = await latestActivityEventCursor(env, WORKSPACE);
    const forOwner = await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OWNER, through, limit: 50,
    });
    expect(forOwner).toEqual([]);

    database.exec(`
      INSERT INTO workstream_participants
        (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
      VALUES ('${WORKSTREAM}', '${OWNER}', '${OTHER}', 'explicit', '2026-01-01');
    `);
    const afterJoining = await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OWNER, through, limit: 50,
    });
    // Audience is a rule, not a frozen recipient list, so joining a work stream
    // brings its history with it.
    expect(afterJoining).toHaveLength(1);
  });

  it("keeps a personal connector event to its own owner", async () => {
    const env = envFor(seededDatabase());
    await record(env, {
      dedupeKey: "activity:1",
      audience: { kind: "user", userId: OTHER },
      subjectType: "pull_request",
    });

    const through = await latestActivityEventCursor(env, WORKSPACE);
    expect(await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OWNER, through, limit: 50,
    })).toEqual([]);
    expect(await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OTHER, through, limit: 50,
    })).toHaveLength(1);
  });

  it("marks the reader when they are a named target", async () => {
    const env = envFor(seededDatabase());
    await record(env, {
      dedupeKey: "message:2",
      audience: { kind: "workspace" },
      targets: [{ userId: OWNER, relation: "mentioned" }],
    });

    const through = await latestActivityEventCursor(env, WORKSPACE);
    const [event] = await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OWNER, through, limit: 50,
    });
    expect(event?.is_target).toBe(1);
    expect(event?.target_relations).toBe("mentioned");
  });

  it("writes one row for a replayed producer", async () => {
    const database = seededDatabase();
    const env = envFor(database);

    const first = await record(env, { dedupeKey: "message:3", audience: { kind: "workspace" } });
    const second = await record(env, { dedupeKey: "message:3", audience: { kind: "workspace" } });

    expect(second).toBe(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_events").get()).toEqual({ count: 1 });
  });

  it("excludes everything a cursor has already covered, even within one millisecond", async () => {
    const env = envFor(seededDatabase());
    // Written back to back, so both rows share a `created_at` to the millisecond.
    // Only a strictly monotonic sequence separates them; a timestamp cursor
    // would drop the second one permanently.
    const firstId = await record(env, { dedupeKey: "message:4", audience: { kind: "workspace" } });
    const firstCursor = await latestActivityEventCursor(env, WORKSPACE);
    await record(env, { dedupeKey: "message:5", audience: { kind: "workspace" } });

    const through = await latestActivityEventCursor(env, WORKSPACE);
    const remaining = await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OWNER, from: firstCursor, through, limit: 50,
    });

    expect(remaining.map((event) => event.id)).not.toContain(firstId);
    expect(remaining).toHaveLength(1);
  });

  it("hides a system work stream's events from everyone, including its own participant", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // A digest's hidden work stream holds a brief assembled from one person's
    // private activity. Its own participant must not read it back as activity,
    // and nobody else may reach it at all.
    database.exec(`
      UPDATE workstreams SET system_kind = 'digest' WHERE id = '${WORKSTREAM}';
      INSERT INTO workstream_participants
        (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
      VALUES ('${WORKSTREAM}', '${OWNER}', '${OWNER}', 'creator', '2026-01-01');
    `);
    await recordActivityEventOrThrow(env, {
      workspaceId: WORKSPACE,
      eventType: "workstream.message.posted",
      subjectType: "workstream",
      subjectId: WORKSTREAM,
      actorType: "system",
      actorLabel: "Avalon",
      title: "Digest",
      audience: { kind: "workstream", workstreamId: WORKSTREAM },
      occurredAt: "2026-01-02T09:00:00.000Z",
      sourceKind: "message",
      dedupeKey: "digest-brief:1",
    });

    const through = await latestActivityEventCursor(env, WORKSPACE);
    expect(await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OWNER, through, limit: 50,
    })).toEqual([]);
  });

  it("stops the log the moment a membership stops being active", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await record(env, { dedupeKey: "message:6", audience: { kind: "workspace" } });
    database.exec(`UPDATE workspace_members SET status = 'suspended' WHERE user_id = '${OWNER}'`);

    const through = await latestActivityEventCursor(env, WORKSPACE);
    expect(await listActivityEventsForUser(env, {
      workspaceId: WORKSPACE, userId: OWNER, through, limit: 50,
    })).toEqual([]);
  });
});
