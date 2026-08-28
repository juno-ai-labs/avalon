import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import type * as AgentModelFlags from "../src/services/agent-model-flags";
import { __testing } from "../src/queues/activity-consumer";
import { AutomationService } from "../src/services/automation-service";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import { openWorkstreamAuthorityForTest, testSubstreamAgentsBinding, testWorkstreamObjectStore } from "./helpers/durable-authority";

const createWorkflow = vi.hoisted(() => vi.fn(async () => ({ status: 200, bodyJson: "{}" })));

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async reserve() {
      return { emailAddress: "calm-bright-gentle-otter@automation.with-avalon.com" };
    }
    async ensureWorkstreamAddress() {
      return { emailAddress: "calm-bright-gentle-otter@automation.with-avalon.com" };
    }
    async ensureAutomationAddress() {
      return { emailAddress: null };
    }
    async backfillAutomationAddresses() {
      return [];
    }
  },
}));
vi.mock("../src/services/agent-model-flags", async (importOriginal) => ({
  // Only the flag lookups are stubbed. `agentModelOverride` is pure validation
  // against the contract's list, and replacing it here would let a subscription
  // pin something the real one rejects.
  ...(await importOriginal<typeof AgentModelFlags>()),
  resolveAgentModelRouting: vi.fn(async () => ({ model: "test-model" })),
  scheduledWorkstreamModel: vi.fn(async () => "test-model"),
}));

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000002");
const SUBSCRIPTION_ID = "00000000-0000-7000-8000-000000000007";
const CONNECTION_ID = "00000000-0000-7000-8000-00000000000c";
const ACTIVITY_ID = "00000000-0000-7000-8000-00000000000d";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  // The automation is workspace-scoped, so only an administrator can delete it.
  role: "owner",
};

const activity = {
  id: ACTIVITY_ID,
  workspace_id: WORKSPACE_ID,
  workspace_region: "global",
  connection_id: CONNECTION_ID,
  connector_type: "github",
  connection_scope: "workspace",
  connection_owner_user_id: null,
  provider: "github",
  provider_event_id: "event-1",
  event_type: "github.pull_request.merged",
  resource_type: "github_pull_request",
  provider_resource_id: "juno-ai-labs/avalon#42",
  occurred_at: "2026-01-01T00:00:00.000Z",
  received_at: "2026-01-01T00:00:00.000Z",
  title: "Pull request merged",
  summary: "A pull request merged",
  text_snippet: "A pull request merged",
  visibility_json: "{}",
  target_user_ids_json: "[]",
  entity_keys_json: "[]",
  metadata_json: "{}",
  processing_status: "pending",
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  createWorkflow.mockClear();
});

function envFor(database: DatabaseSync, objectStore: DatabaseSync): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, {
      extra: { activateLoop: createWorkflow },
    }),
  });
}

describe("activity triggers after an automation is deleted", () => {
  it("starts a run while the automation is visible and none once it is deleted", async () => {
    const database = seededDatabase();
    const objectStore = testWorkstreamObjectStore();
    databases.push(objectStore);
    const env = envFor(database, objectStore);

    // Control: the trigger matches this activity today, so matching opens
    // exactly one run. Without this the deleted case would prove nothing.
    const created = await __testing.runMatchingAutomations(env, activity as never);
    expect(created.size).toBe(1);
    expect(createWorkflow).toHaveBeenCalledTimes(1);

    await new AutomationService(env, auth).deleteAutomation(SUBSCRIPTION_ID);
    createWorkflow.mockClear();
    // A second, distinct activity from the same connector: matching must now
    // find no subscription at all.
    const afterDelete = await __testing.runMatchingAutomations(
      env,
      { ...activity, id: "00000000-0000-7000-8000-00000000000e", provider_event_id: "event-2" } as never,
    );

    expect(afterDelete.size).toBe(0);
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM automation_runs WHERE automation_subscription_id = ?",
    ).get(SUBSCRIPTION_ID)).toEqual({ count: 1 });
  });
});

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // Connector-activity runs launch through the Durable-Object authority now;
  // open it before any product rows exist, the way a fresh stack does.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Avalon Studio', 'avalon-studio', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'owner', 'active', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name,
       granted_scopes_json, model_plugin_id, status, created_at, updated_at)
    VALUES ('${CONNECTION_ID}', '${WORKSPACE_ID}', 'github', 'workspace', NULL, 'GitHub',
            '[]', 'plugin_github', 'healthy', '2026-01-01', '2026-01-01');
    INSERT INTO activities
      (id, workspace_id, connection_id, connection_scope, connection_owner_user_id, provider,
       provider_event_id, event_type, resource_type, provider_resource_id, occurred_at, received_at,
       title, dedupe_key, processing_status)
    VALUES
      ('${ACTIVITY_ID}', '${WORKSPACE_ID}', '${CONNECTION_ID}', 'workspace', NULL, 'github',
       'event-1', 'github.pull_request.merged', 'github_pull_request', 'juno-ai-labs/avalon#42',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'Pull request merged', 'dedupe-1', 'pending'),
      ('00000000-0000-7000-8000-00000000000e', '${WORKSPACE_ID}', '${CONNECTION_ID}', 'workspace', NULL, 'github',
       'event-2', 'github.pull_request.merged', 'github_pull_request', 'juno-ai-labs/avalon#43',
       '2026-01-01T00:05:00.000Z', '2026-01-01T00:05:00.000Z', 'Pull request merged', 'dedupe-2', 'pending');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES ('00000000-0000-7000-8000-000000000003', '${WORKSPACE_ID}', '${USER_ID}',
            'Merged pull requests', 'Follow merged pull requests', 'private', 1, '2026-01-01', '2026-01-01');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
    VALUES ('00000000-0000-7000-8000-000000000005', '00000000-0000-7000-8000-000000000003', 1,
            'Summarize the pull request',
            '[{"type":"connector_activity","connectorType":"github","eventTypes":["github.pull_request.merged"],"deterministicFilters":{}}]',
            '${USER_ID}', '2026-01-01');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, connector_bindings_json, status, email_address,
       email_route_status, created_at, updated_at)
    VALUES ('${SUBSCRIPTION_ID}', '${WORKSPACE_ID}', '00000000-0000-7000-8000-000000000003',
            '00000000-0000-7000-8000-000000000005', 'workspace', NULL,
            '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}',
            '{"plugin_github":"${CONNECTION_ID}"}', 'active',
            'calm-bright-gentle-otter@automation.with-avalon.com', 'active', '2026-01-01', '2026-01-01');
  `);
  return database;
}
