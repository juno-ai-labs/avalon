import { asUserId, asWorkspaceId } from "@rally/contracts";
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
const CONNECTION_OLD = "00000000-0000-7000-8000-000000000009";
const CONNECTION_NEW = "00000000-0000-7000-8000-00000000000a";
const SLACK_TARGET = "00000000-0000-7000-8000-00000000000b";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * The live authority for these tables is WorkspaceDO's own schema; this stands
 * them up in the frozen through-0089 D1 dialect instead, which is enough to
 * prove statement order, the unique index, and what survives an edit. What it
 * does not prove is the object table's STRICT typing, its json_valid CHECKs, or
 * its different foreign keys — a constraint that depends on any of those needs
 * `test-workers/`.
 *
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
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, status, cursor_json, config_json,
       created_at, updated_at, model_plugin_id)
    VALUES ('${CONNECTION_OLD}', '${WORKSPACE}', 'slack', 'personal', '${OWNER}', 'T-OLD',
            'Slack · Avalon Studio', '["slack.agent"]', 'disabled', '{}', '{}',
            '2026-01-01', '2026-01-01', 'plugin_slack_personal'),
           ('${CONNECTION_NEW}', '${WORKSPACE}', 'slack', 'personal', '${OWNER}', 'T-NEW',
            'Slack · Avalon Studio', '["slack.agent"]', 'healthy', '{}', '{}',
            '2026-01-01', '2026-01-01', 'plugin_slack_personal');
    INSERT INTO slack_user_links
      (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status,
       created_at, updated_at)
    VALUES ('00000000-0000-7000-8000-0000000000c2', '${WORKSPACE}', '${CONNECTION_NEW}',
            '${OWNER}', 'T-NEW', 'U-NEW', 'active', '2026-01-01', '2026-01-01');
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
    // Without these the Slack connector is not registered at all, so it
    // declares no delivery surface and every Slack destination resolves to
    // "not linked" for a reason that has nothing to do with the link.
    SLACK_CLIENT_ID: "slack-client",
    SLACK_CLIENT_SECRET: "slack-secret",
    SLACK_SIGNING_SECRET: "slack-signing",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: { refreshSchedule: async () => ({ alarmAt: null }) },
    }),
  }), auth);
}

function targets(database: DatabaseSync): Array<Record<string, unknown>> {
  return database.prepare(
    `SELECT id, target_type, connection_id, slack_user_id, email_address, status, last_delivered_workstream_id
       FROM automation_delivery_targets WHERE automation_subscription_id = ?
      ORDER BY target_type`,
  ).all(SUBSCRIPTION) as Array<Record<string, unknown>>;
}

describe("changing where an automation's results are delivered", () => {
  it("turns email delivery off", async () => {
    const database = seeded();

    await serviceFor(database).update(SUBSCRIPTION, { deliveryTargets: [] });

    // The only off switch used to be deleting the automation. Off retires the
    // row rather than removing it — every sender names the statuses it will
    // deliver to and `disabled` is in none of them — so that turning the same
    // destination back on later reuses this row, and with it the fence that
    // stops a retry re-sending a result it already delivered.
    expect(targets(database)).toMatchObject([{
      id: EMAIL_TARGET,
      status: "disabled",
      last_delivered_workstream_id: WORKSTREAM,
    }]);
    expect(await serviceFor(database).get(SUBSCRIPTION))
      .toMatchObject({ deliveryTargets: [] });
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

  it("turns a destination on", async () => {
    const database = seeded();
    await serviceFor(database).update(SUBSCRIPTION, { deliveryTargets: [] });

    await serviceFor(database).update(SUBSCRIPTION, {
      deliveryTargets: [{ type: "slack_agent_dm", connectionId: CONNECTION_NEW }],
    });

    // The branch that adds a destination was the headline of the change that
    // introduced this file and was reached by none of its tests. The retired
    // email row is still on the table and must stay off — turning one
    // destination on is not a reason to resume another.
    expect(targets(database)).toMatchObject([
      { target_type: "email", status: "disabled" },
      { target_type: "slack_agent_dm", connection_id: CONNECTION_NEW, status: "active", slack_user_id: "U-NEW" },
    ]);
    expect(await serviceFor(database).get(SUBSCRIPTION)).toMatchObject({
      deliveryTargets: [{ type: "slack_agent_dm", connectionId: CONNECTION_NEW }],
    });
  });

  it("moves a destination onto a reconnected connection", async () => {
    const database = seeded();
    // Reconnecting Slack disables the old connection and mints a new one, so
    // the frozen row points at a connection that no longer offers delivery.
    database.exec(`
      INSERT INTO automation_delivery_targets
        (id, workspace_id, automation_subscription_id, target_type, connection_id,
         user_id, slack_team_id, slack_user_id, status, created_at, updated_at)
      VALUES ('${SLACK_TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'slack_agent_dm',
              '${CONNECTION_OLD}', '${OWNER}', 'T-OLD', 'U-OLD',
              'active', '2026-01-01', '2026-01-01');
    `);

    await serviceFor(database).update(SUBSCRIPTION, {
      deliveryTargets: [{ type: "email" }, { type: "slack_agent_dm", connectionId: CONNECTION_NEW }],
    });

    // Reconnecting Slack mints a new connection, so re-choosing the destination
    // replaces one row rather than inserting beside it. Written as an insert
    // followed by a delete this violated the unique index inside the batch and
    // failed the whole edit.
    expect(targets(database)).toMatchObject([
      { target_type: "email" },
      { id: SLACK_TARGET, target_type: "slack_agent_dm", connection_id: CONNECTION_NEW, slack_user_id: "U-NEW" },
    ]);
  });

  it("keeps the per-run fence across turning a destination off and on again", async () => {
    const database = seeded();
    const service = serviceFor(database);

    await service.update(SUBSCRIPTION, { deliveryTargets: [] });
    await service.update(SUBSCRIPTION, { deliveryTargets: [{ type: "email" }] });

    // Both dedupe layers are keyed on the target row's id — the fence below and
    // the provider idempotency key derived from it — so a row replaced by an
    // equivalent row re-sends a result already delivered. Off-then-on is the
    // reachable way to ask for that, and it is the duplicate this whole change
    // exists to remove.
    expect(targets(database)).toMatchObject([{
      id: EMAIL_TARGET,
      last_delivered_workstream_id: WORKSTREAM,
      status: "active",
    }]);
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
