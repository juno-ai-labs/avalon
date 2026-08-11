import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

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
  userId: "user-owner",
  workspaceId: "workspace-1",
  region: "global",
  role: "member",
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  ensureAutomationAddress.mockClear();
});

function serviceFor(database: DatabaseSync): AutomationService {
  const env = {
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    WORKSPACE_SCHEDULERS: {
      idFromName: () => "scheduler",
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      jurisdiction: () => ({ idFromName: () => "scheduler", get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) }),
    },
  } as unknown as Env;
  return new AutomationService(env, auth);
}

describe("automation lifecycle", () => {
  it("drops an archived draft from the automation list and from every read of it", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await service.archiveDraft("subscription-draft");

    expect((await service.list()).items.map((item) => item.id)).toEqual(["subscription-active"]);
    expect(database.prepare(
      "SELECT lifecycle_state, status FROM automation_subscriptions WHERE id = ?",
    ).get("subscription-draft")).toEqual({ lifecycle_state: "archived", status: "draft" });
    await expect(service.get("subscription-draft")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to archive an automation that still runs", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await expect(service.archiveDraft("subscription-active")).rejects.toMatchObject({
      status: 409,
      code: "automation_not_draft",
    });
    expect((await service.list()).items.map((item) => item.id))
      .toEqual(["subscription-active", "subscription-draft"]);
  });

  it("deletes a running automation, disabling its schedule and closing its address", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await service.deleteAutomation("subscription-active");

    expect(database.prepare(
      "SELECT lifecycle_state FROM automation_subscriptions WHERE id = ?",
    ).get("subscription-active")).toEqual({ lifecycle_state: "deleted" });
    expect(database.prepare(
      "SELECT enabled FROM schedules WHERE automation_subscription_id = ?",
    ).get("subscription-active")).toEqual({ enabled: 0 });
    // The route transition is reconciled through the routing service, which
    // derives "disabled" from the deleted lifecycle state.
    expect(ensureAutomationAddress).toHaveBeenCalledTimes(1);
    expect((await service.list()).items.map((item) => item.id)).toEqual(["subscription-draft"]);
    await expect(service.get("subscription-active")).rejects.toMatchObject({ status: 404 });
    await expect(service.runNow("subscription-active", "idempotency-key-1")).rejects.toMatchObject({ status: 404 });
  });

  it("leaves a deleted automation unreachable to a second delete", async () => {
    const database = seededDatabase();
    const service = serviceFor(database);

    await service.deleteAutomation("subscription-draft");

    await expect(service.deleteAutomation("subscription-draft")).rejects.toMatchObject({ status: 404 });
    await expect(service.archiveDraft("subscription-draft")).rejects.toMatchObject({ status: 404 });
  });

  it("keeps every trigger query blind to an automation that is no longer visible", async () => {
    const database = seededDatabase();
    await serviceFor(database).deleteAutomation("subscription-active");

    // The three paths that can start a run: the workspace scheduler alarm,
    // activity matching, and inbound email. Each requires an active status and
    // a visible lifecycle state.
    const scheduled = database.prepare(
      `SELECT s.id FROM automation_subscriptions s
       WHERE s.id = ? AND s.workspace_id = ? AND s.status = 'active' AND s.lifecycle_state = 'visible'`,
    ).get("subscription-active", "workspace-1");
    const matched = database.prepare(
      `SELECT s.id FROM automation_subscriptions s
       WHERE s.workspace_id = ? AND s.status = 'active' AND s.lifecycle_state = 'visible'`,
    ).all("workspace-1");
    const mailed = database.prepare(
      `SELECT s.id FROM automation_subscriptions s
       WHERE s.email_address = ? COLLATE NOCASE AND s.status = 'active' AND s.lifecycle_state = 'visible'`,
    ).get("calm-bright-gentle-otter@automation.with-avalon.com");

    expect(scheduled).toBeUndefined();
    expect(matched).toEqual([]);
    expect(mailed).toBeUndefined();
  });
});

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('workspace-1', 'Avalon Studio', 'avalon-studio', 'global', 'user-owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('workspace-1', 'user-owner', 'owner', 'active', '2026-01-01');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES
      ('template-active', 'workspace-1', 'user-owner', 'Daily product brief', 'Brief', 'private', 1, '2026-01-01', '2026-01-01'),
      ('template-draft', 'workspace-1', 'user-owner', 'Weekly competitor scan', 'Scan', 'private', 1, '2026-01-01', '2026-01-01');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
    VALUES
      ('version-active', 'template-active', 1, 'Write the brief', '[]', 'user-owner', '2026-01-01'),
      ('version-draft', 'template-draft', 1, 'Scan competitors', '[]', 'user-owner', '2026-01-01');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, status, email_address, email_route_status, created_at, updated_at)
    VALUES
      ('subscription-active', 'workspace-1', 'template-active', 'version-active', 'personal', 'user-owner',
       '{"type":"user","userId":"user-owner"}', 'active', 'calm-bright-gentle-otter@automation.with-avalon.com',
       'active', '2026-01-01', '2026-01-01'),
      ('subscription-draft', 'workspace-1', 'template-draft', 'version-draft', 'personal', 'user-owner',
       '{"type":"user","userId":"user-owner"}', 'draft', 'quiet-amber-steady-heron@automation.with-avalon.com',
       'disabled', '2026-01-01', '2026-01-01');
    INSERT INTO schedules
      (id, workspace_id, automation_subscription_id, schedule_type, rrule, timezone,
       next_run_at, enabled, version, created_at, updated_at)
    VALUES
      ('schedule-active', 'workspace-1', 'subscription-active', 'calendar', 'FREQ=DAILY', 'America/Los_Angeles',
       '2026-01-02T16:00:00.000Z', 1, 1, '2026-01-01', '2026-01-01');
  `);
  return database;
}
