import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { WorkspaceScheduler } from "../src/durable-objects/workspace-scheduler";
import { AutomationService } from "../src/services/automation-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";

const ensureAutomationAddress = vi.hoisted(() => vi.fn(async () => ({ emailAddress: null })));

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async backfillAutomationAddresses() {
      return [];
    }
    ensureAutomationAddress = ensureAutomationAddress;
  },
}));

const auth: AuthContext = {
  sessionId: "session-1",
  userId: "00000000-0000-7000-8000-000000000002",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  region: "global",
  role: "member",
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  ensureAutomationAddress.mockClear();
});

function serviceFor(database: DatabaseSync): AutomationService {
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    WORKSPACE_SCHEDULERS: {
      idFromName: () => createTestDurableObjectId("scheduler"),
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      jurisdiction: () => ({ idFromName: () => createTestDurableObjectId("scheduler"), get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) }),
    },
  });
  return new AutomationService(env, auth);
}

/** The scheduler Durable Object, wired to the same database, with storage and
 * alarms captured so a test can see whether the workspace timer is still armed. */
function serviceWithBrokenScheduler(database: DatabaseSync): AutomationService {
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    WORKSPACE_SCHEDULERS: {
      idFromName: () => createTestDurableObjectId("scheduler"),
      get: () => ({ fetch: async () => { throw new Error("scheduler unreachable"); } }),
    },
  });
  return new AutomationService(env, auth);
}

function schedulerFor(database: DatabaseSync) {
  const values = new Map<string, unknown>();
  const setAlarm = vi.fn(async (at: number) => { void at; });
  const deleteAlarm = vi.fn(async () => undefined);
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    getAlarm: async () => null,
    setAlarm,
    deleteAlarm,
  });
  const scheduler = new WorkspaceScheduler(
    createCloudflareTestBinding<DurableObjectState>({ storage }),
    createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" }),
  );
  return { scheduler, setAlarm, deleteAlarm };
}

function runCount(database: DatabaseSync): number {
  return Number((database.prepare(
    "SELECT COUNT(*) AS count FROM automation_runs WHERE automation_subscription_id = ?",
  ).get("00000000-0000-7000-8000-000000000007") as { count: number }).count);
}

describe("automation lifecycle", () => {
  it("drops an archived draft from the automation list and from every read of it", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await service.archiveDraft("00000000-0000-7000-8000-000000000008");

    expect((await service.list()).items.map((item) => item.id)).toEqual(["00000000-0000-7000-8000-000000000007"]);
    expect(database.prepare(
      "SELECT lifecycle_state, status FROM automation_subscriptions WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000008")).toEqual({ lifecycle_state: "archived", status: "draft" });
    await expect(service.get("00000000-0000-7000-8000-000000000008")).rejects.toMatchObject({ status: 404 });
  });

  it("disables any schedule a draft carries when it is archived", async () => {
    const database = seededDatabase();
    // Drafts are created without schedules today. If that ever changes, an
    // archived draft must not keep firing from a schedule nobody can see.
    database.exec(`
      INSERT INTO schedules
        (id, workspace_id, automation_subscription_id, schedule_type, rrule, timezone,
         next_run_at, enabled, version, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-00000000000c', '00000000-0000-7000-8000-000000000001',
              '00000000-0000-7000-8000-000000000008', 'calendar', 'FREQ=DAILY', 'America/Los_Angeles',
              '2026-01-02T16:00:00.000Z', 1, 1, '2026-01-01', '2026-01-01');
    `);

    await serviceFor(database).archiveDraft("00000000-0000-7000-8000-000000000008");

    expect(database.prepare(
      "SELECT enabled FROM schedules WHERE automation_subscription_id = ?",
    ).get("00000000-0000-7000-8000-000000000008")).toEqual({ enabled: 0 });
    const { scheduler } = schedulerFor(database);
    expect(await scheduler.refresh("00000000-0000-7000-8000-000000000001"))
      .toMatchObject({ alarmAt: expect.any(String) });
    await scheduler.alarm();
    expect(Number((database.prepare(
      "SELECT COUNT(*) AS count FROM automation_runs WHERE automation_subscription_id = ?",
    ).get("00000000-0000-7000-8000-000000000008") as { count: number }).count)).toBe(0);
  });

  it("refuses to archive an automation that still runs", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await expect(service.archiveDraft("00000000-0000-7000-8000-000000000007")).rejects.toMatchObject({
      status: 409,
      code: "automation_not_draft",
    });
    expect((await service.list()).items.map((item) => item.id))
      .toEqual(["00000000-0000-7000-8000-000000000007", "00000000-0000-7000-8000-000000000008"]);
  });

  it("deletes a running automation, disabling its schedule and closing its address", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await service.deleteAutomation("00000000-0000-7000-8000-000000000007");

    expect(database.prepare(
      "SELECT lifecycle_state FROM automation_subscriptions WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000007")).toEqual({ lifecycle_state: "deleted" });
    expect(database.prepare(
      "SELECT enabled FROM schedules WHERE automation_subscription_id = ?",
    ).get("00000000-0000-7000-8000-000000000007")).toEqual({ enabled: 0 });
    // The route transition is reconciled through the routing service, which
    // derives "disabled" from the deleted lifecycle state.
    expect(ensureAutomationAddress).toHaveBeenCalledTimes(1);
    expect((await service.list()).items.map((item) => item.id)).toEqual(["00000000-0000-7000-8000-000000000008"]);
    await expect(service.get("00000000-0000-7000-8000-000000000007")).rejects.toMatchObject({ status: 404 });
    await expect(service.runNow("00000000-0000-7000-8000-000000000007", "idempotency-key-1")).rejects.toMatchObject({ status: 404 });
  });

  it("still succeeds when the scheduler cannot be refreshed after the delete", async () => {
    const database = seededDatabase();

    // The write is already committed by the time the refresh runs, and a retry
    // would 404, so a refresh failure must not surface as a failed delete.
    await expect(serviceWithBrokenScheduler(database).deleteAutomation("00000000-0000-7000-8000-000000000007"))
      .resolves.toBeUndefined();

    expect(database.prepare(
      "SELECT lifecycle_state FROM automation_subscriptions WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000007")).toEqual({ lifecycle_state: "deleted" });
    // A stale armed alarm is harmless: the alarm re-reads enabled schedules.
    const { scheduler } = schedulerFor(database);
    await scheduler.alarm();
    expect(runCount(database)).toBe(0);
  });

  it("leaves a deleted automation unreachable to a second delete", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await service.deleteAutomation("00000000-0000-7000-8000-000000000008");

    await expect(service.deleteAutomation("00000000-0000-7000-8000-000000000008")).rejects.toMatchObject({ status: 404 });
    await expect(service.archiveDraft("00000000-0000-7000-8000-000000000008")).rejects.toMatchObject({ status: 404 });
  });

  it("disarms the workspace timer so a calendar or interval trigger stops firing", async () => {
    const database = seededDatabase();
    const { scheduler, setAlarm, deleteAlarm } = schedulerFor(database);

    // The schedule is due, so before the delete the workspace alarm is armed.
    expect(await scheduler.refresh("00000000-0000-7000-8000-000000000001")).toMatchObject({ alarmAt: expect.any(String) });
    expect(setAlarm).toHaveBeenCalledTimes(1);

    await serviceFor(database).deleteAutomation("00000000-0000-7000-8000-000000000007");

    expect(await scheduler.refresh("00000000-0000-7000-8000-000000000001")).toEqual({ alarmAt: null });
    expect(deleteAlarm).toHaveBeenCalled();

    // Firing the alarm anyway must not open a run: the due-target query only
    // sees enabled schedules.
    await scheduler.alarm();
    expect(runCount(database)).toBe(0);
  });

  it("refuses a due schedule that outlived its deleted automation", async () => {
    const database = seededDatabase();
    await serviceFor(database).deleteAutomation("00000000-0000-7000-8000-000000000007");
    // Simulate a schedule row that escaped the disable — a restored backup, or
    // a writer that raced the delete. The alarm must still refuse to run it.
    database.exec("UPDATE schedules SET enabled = 1 WHERE automation_subscription_id = '00000000-0000-7000-8000-000000000007'");

    const { scheduler } = schedulerFor(database);
    await scheduler.refresh("00000000-0000-7000-8000-000000000001");
    await scheduler.alarm();

    expect(runCount(database)).toBe(0);
    const failure = database.prepare(
      "SELECT action, metadata_json FROM audit_events WHERE target_id = ?",
    ).get("00000000-0000-7000-8000-000000000009") as { action: string; metadata_json: string };
    expect(failure.action).toBe("schedule.failed");
    expect(failure.metadata_json).toContain("automation_subscription_unavailable");
  });

  it("leaves the work stream of a run that already started alone", async () => {
    const database = seededDatabase();
    // The scheduler marks a run running when it creates the Workflow instance,
    // but the work stream stays 'scheduled' until the harness claims its
    // attempt. A delete landing inside that window must not archive a work
    // stream the live run is still writing into.
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, automation_subscription_id, automation_run_id,
         planned_for, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-00000000000d', '00000000-0000-7000-8000-000000000001', 'Daily product brief',
              'Write the brief', 'automation', '00000000-0000-7000-8000-000000000007',
              '00000000-0000-7000-8000-00000000000e', '2026-01-02T16:00:00.000Z', 'scheduled', 1,
              '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO automation_runs
        (id, workspace_id, automation_subscription_id, workstream_id, trigger_type, planned_for,
         started_at, status, created_at)
      VALUES ('00000000-0000-7000-8000-00000000000e', '00000000-0000-7000-8000-000000000001',
              '00000000-0000-7000-8000-000000000007', '00000000-0000-7000-8000-00000000000d', 'schedule',
              '2026-01-02T16:00:00.000Z', '2026-01-02T16:00:01.000Z', 'running', '2026-01-01');
    `);

    await serviceFor(database).deleteAutomation("00000000-0000-7000-8000-000000000007");

    expect(database.prepare(
      "SELECT archived_at, harness_status FROM workstreams WHERE id = ?",
    ).get("00000000-0000-7000-8000-00000000000d")).toEqual({ archived_at: null, harness_status: "scheduled" });
    expect(database.prepare(
      "SELECT status, result_summary FROM automation_runs WHERE id = ?",
    ).get("00000000-0000-7000-8000-00000000000e")).toEqual({ status: "running", result_summary: null });
  });

  it("closes a run that was opened ahead of its planned time", async () => {
    const database = seededDatabase();
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, automation_subscription_id, automation_run_id,
         planned_for, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-000000000001', 'Daily product brief', 'Write the brief', 'automation',
              '00000000-0000-7000-8000-000000000007', '00000000-0000-7000-8000-00000000000b', '2026-01-02T16:00:00.000Z', 'scheduled', 1,
              '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO automation_runs
        (id, workspace_id, automation_subscription_id, workstream_id, trigger_type, planned_for,
         started_at, status, created_at)
      VALUES ('00000000-0000-7000-8000-00000000000b', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000007', '00000000-0000-7000-8000-00000000000a', 'schedule',
              '2026-01-02T16:00:00.000Z', NULL, 'scheduled', '2026-01-01');
    `);

    await serviceFor(database).deleteAutomation("00000000-0000-7000-8000-000000000007");

    expect(database.prepare(
      "SELECT status, result_summary FROM automation_runs WHERE id = ?",
    ).get("00000000-0000-7000-8000-00000000000b")).toEqual({
      status: "failed",
      result_summary: "The automation was deleted before this run started",
    });
    expect(database.prepare(
      "SELECT archived_at IS NOT NULL AS archived FROM workstreams WHERE id = ?",
    ).get("00000000-0000-7000-8000-00000000000a")).toEqual({ archived: 1 });
  });

  it("refuses inbound email to a deleted automation's address", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await service.deleteAutomation("00000000-0000-7000-8000-000000000007");

    // Ingestion resolves the subscription before it opens anything, and the
    // resend route query requires the same visible, active subscription.
    await expect(service.runFromInboundEmail("00000000-0000-7000-8000-000000000007", {
      resendEmailId: "resend-1",
      textContent: "Run this please",
      structuredContent: {},
      resourceId: "00000000-0000-7000-8000-00000000000f",
    })).rejects.toMatchObject({ status: 404 });
    expect(database.prepare(
      `SELECT id FROM automation_subscriptions
       WHERE email_address = ? COLLATE NOCASE AND status = 'active' AND lifecycle_state = 'visible'`,
    ).get("calm-bright-gentle-otter@automation.with-avalon.com")).toBeUndefined();
    // The address is not released: its owner keeps it so nobody can claim it.
    expect(database.prepare(
      "SELECT email_address FROM automation_subscriptions WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000007"))
      .toEqual({ email_address: "calm-bright-gentle-otter@automation.with-avalon.com" });
  });
});

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('00000000-0000-7000-8000-000000000002', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('00000000-0000-7000-8000-000000000001', 'Avalon Studio', 'avalon-studio', 'global', '00000000-0000-7000-8000-000000000002', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'owner', 'active', '2026-01-01');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES
      ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Daily product brief', 'Brief', 'private', 1, '2026-01-01', '2026-01-01'),
      ('00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Weekly competitor scan', 'Scan', 'private', 1, '2026-01-01', '2026-01-01');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
    VALUES
      ('00000000-0000-7000-8000-000000000005', '00000000-0000-7000-8000-000000000003', 1, 'Write the brief', '[]', '00000000-0000-7000-8000-000000000002', '2026-01-01'),
      ('00000000-0000-7000-8000-000000000006', '00000000-0000-7000-8000-000000000004', 1, 'Scan competitors', '[]', '00000000-0000-7000-8000-000000000002', '2026-01-01');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, status, email_address, email_route_status, created_at, updated_at)
    VALUES
      ('00000000-0000-7000-8000-000000000007', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000005', 'personal', '00000000-0000-7000-8000-000000000002',
       '{"type":"user","userId":"00000000-0000-7000-8000-000000000002"}', 'active', 'calm-bright-gentle-otter@automation.with-avalon.com',
       'active', '2026-01-01', '2026-01-01'),
      ('00000000-0000-7000-8000-000000000008', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000006', 'personal', '00000000-0000-7000-8000-000000000002',
       '{"type":"user","userId":"00000000-0000-7000-8000-000000000002"}', 'draft', 'quiet-amber-steady-heron@automation.with-avalon.com',
       'disabled', '2026-01-01', '2026-01-01');
    INSERT INTO schedules
      (id, workspace_id, automation_subscription_id, schedule_type, rrule, timezone,
       next_run_at, enabled, version, created_at, updated_at)
    VALUES
      ('00000000-0000-7000-8000-000000000009', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000007', 'calendar', 'FREQ=DAILY', 'America/Los_Angeles',
       '2026-01-02T16:00:00.000Z', 1, 1, '2026-01-01', '2026-01-01');
  `);
  return database;
}
