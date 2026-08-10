import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async backfillAutomationAddresses() {
      return [];
    }
    async ensureAutomationAddress() {
      return { emailAddress: null };
    }
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
});

describe("draft automation archiving", () => {
  it("drops an archived draft from the automation list and from every read of it", async () => {
    const database = seededDatabase();
    const service = new AutomationService({ DB: sqliteD1(database) } as unknown as Env, auth);

    await service.archiveDraft("subscription-draft");

    expect((await service.list()).items.map((item) => item.id)).toEqual(["subscription-active"]);
    expect(database.prepare(
      "SELECT archived_at IS NOT NULL AS archived, status FROM automation_subscriptions WHERE id = ?",
    ).get("subscription-draft")).toEqual({ archived: 1, status: "draft" });
    await expect(service.get("subscription-draft")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to archive an automation that still runs", async () => {
    const database = seededDatabase();
    const service = new AutomationService({ DB: sqliteD1(database) } as unknown as Env, auth);

    await expect(service.archiveDraft("subscription-active")).rejects.toMatchObject({
      status: 409,
      code: "automation_not_draft",
    });
    expect((await service.list()).items.map((item) => item.id))
      .toEqual(["subscription-active", "subscription-draft"]);
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
  `);
  return database;
}
