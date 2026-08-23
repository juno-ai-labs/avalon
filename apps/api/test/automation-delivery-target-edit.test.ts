import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { AuthContext } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding } from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const OWNER = asUserId("00000000-0000-7000-8000-000000000002");
const OTHER = asUserId("00000000-0000-7000-8000-000000000003");
const TEMPLATE = "00000000-0000-7000-8000-000000000004";
const VERSION = "00000000-0000-7000-8000-000000000005";
const SUBSCRIPTION = "00000000-0000-7000-8000-000000000006";
const EMAIL_TARGET = "00000000-0000-7000-8000-000000000007";
const WORKSTREAM = "00000000-0000-7000-8000-000000000008";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * One personal automation with its owner's email frozen on it, and a run it has
 * already delivered — so the fence that stops a retry re-sending is present and
 * an edit can be shown not to clear it.
 */
function seeded(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
           ('${OTHER}', 'g-other', 'other@example.com', 'Other', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01'),
           ('${WORKSPACE}', '${OTHER}', 'admin', 'active', '2026-01-01');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES ('${TEMPLATE}', '${WORKSPACE}', '${OWNER}', 'Daily briefing', 'Brief', 'private',
            1, '2026-01-01', '2026-01-01');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, overview, instructions, trigger_definitions_json,
       required_capabilities_json, expected_outputs_json, default_behavior_json,
       recommended_plugins_json, memory_tables_json, created_by_user_id, created_at)
    VALUES ('${VERSION}', '${TEMPLATE}', 1, 'Runs daily.', 'Write the briefing.', '[]',
            '[]', '[]', '{}', '[]', '[]', '${OWNER}', '2026-01-01');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, status, created_at, updated_at)
    VALUES ('${SUBSCRIPTION}', '${WORKSPACE}', '${TEMPLATE}', '${VERSION}', 'personal', '${OWNER}',
            '{"type":"user","userId":"${OWNER}"}', 'active', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       next_sequence_number, last_activity_at, created_at, updated_at, scope)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Daily briefing · 2026-08-22', 'Write the briefing.',
            'automation', '${OWNER}', 'idle', 1, '2026-08-22', '2026-08-22', '2026-08-22', 'personal');
    INSERT INTO automation_delivery_targets
      (id, workspace_id, automation_subscription_id, target_type, user_id, email_address,
       status, last_delivered_workstream_id, created_at, updated_at)
    VALUES ('${EMAIL_TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'email', '${OWNER}',
            'owner@example.com', 'needs_input', '${WORKSTREAM}', '2026-01-01', '2026-01-01');
  `);
  return database;
}

function serviceFor(database: DatabaseSync, userId = OWNER, role: AuthContext["role"] = "owner"): AutomationService {
  const auth: AuthContext = {
    sessionId: "session-1",
    userId,
    workspaceId: WORKSPACE,
    region: "global",
    role,
  };
  return new AutomationService(createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    // `get` reconciles the automation's own inbound address at the end of an
    // update, and the allocator needs a key to derive one from.
    SESSION_SIGNING_KEY: "a".repeat(48),
    WORKSTREAM_EMAIL_ADDRESS_KEY: "b".repeat(48),
    WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: { refreshSchedule: async () => ({ alarmAt: null }) },
    }),
  }), auth);
}

function targets(database: DatabaseSync): Array<Record<string, unknown>> {
  return database.prepare(
    `SELECT id, target_type, email_address, status, last_delivered_workstream_id
       FROM automation_delivery_targets WHERE automation_subscription_id = ?
      ORDER BY target_type`,
  ).all(SUBSCRIPTION) as Array<Record<string, unknown>>;
}

describe("changing where an automation's results are delivered", () => {
  it("turns email delivery off", async () => {
    const database = seeded();

    await serviceFor(database).update(SUBSCRIPTION, { deliveryTargets: [] });

    // The only off switch used to be deleting the automation.
    expect(targets(database)).toEqual([]);
  });

  it("keeps the row, and its per-run fence, for a destination that stays", async () => {
    const database = seeded();

    await serviceFor(database).update(SUBSCRIPTION, { deliveryTargets: [{ type: "email" }] });

    // Deleting and reinserting on every edit would clear
    // `last_delivered_workstream_id`, and an edit between a run finishing and
    // its delivery settling would then mail the same result twice — the defect
    // this whole branch exists to remove.
    expect(targets(database)).toMatchObject([{
      id: EMAIL_TARGET,
      email_address: "owner@example.com",
      last_delivered_workstream_id: WORKSTREAM,
      // Choosing it again is a statement that it should deliver, whatever a
      // past failure left on it.
      status: "active",
    }]);
  });

  it("leaves delivery alone when an edit does not mention it", async () => {
    const database = seeded();

    await serviceFor(database).update(SUBSCRIPTION, { overrides: { tone: "brief" } });

    expect(targets(database)).toMatchObject([{ id: EMAIL_TARGET, status: "needs_input" }]);
  });

  it("does not let another member change this owner's destination", async () => {
    const database = seeded();

    // A workspace admin can administer plenty, but a personal automation is not
    // theirs to see — the visibility fence answers before the ownership check
    // in `update` is reached, which is why that check is defence rather than
    // the thing doing the work here.
    await expect(serviceFor(database, OTHER, "admin").update(SUBSCRIPTION, { deliveryTargets: [] }))
      .rejects.toMatchObject({ status: 404 });
    expect(targets(database)).toHaveLength(1);
  });
});
