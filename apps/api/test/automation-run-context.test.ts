import {
  asHarnessRunId,
  asUserId,
  asWorkspaceId,
  type AutomationRunContextV1,
  asAutomationId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const { loadRunPromptContext } = __integrationTesting;

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const OWNER = "00000000-0000-7000-8000-000000000002";
const WORKSTREAM = asWorkstreamId("00000000-0000-7000-8000-000000000003");
const RUN = asHarnessRunId("00000000-0000-7000-8000-000000000004");
const TEMPLATE = "00000000-0000-7000-8000-000000000005";
const VERSION = "00000000-0000-7000-8000-000000000006";
const SUBSCRIPTION = asAutomationId("00000000-0000-7000-8000-000000000007");
const TARGET = "00000000-0000-7000-8000-000000000008";
const CONNECTION = "00000000-0000-7000-8000-000000000009";
const LINK = "00000000-0000-7000-8000-00000000000a";
const ATTEMPT = "attempt-1";
const LEASE_OWNER = "lease-owner-1";

const databases: DatabaseSync[] = [];
let objectStores = new Map<string, DatabaseSync>();
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function envFor(database: DatabaseSync, appEnv: "production" | "test" = "production"): Env {
  const base = createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    AUTOMATION_AGENTS: testSubstreamAgentsBinding(database, {
      extra: { readMemoryBootstrap: async () => ({ tables: [] }) },
    }),
    AVALON_REGION: "global",
    APP_ENV: appEnv,
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    // Keep Terminal configured so this fixture exercises the external-delivery
    // tie-breaker against the standing document policy.
    TERMINAL_REGION_CAPABILITY: "supported",
    DAYTONA_API_KEY: "daytona-key",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    TERMINAL_EMERGENCY_DISABLED: "false",
  });
  return base;
}

/**
 * One personal automation, run by its schedule, with a delivery target frozen
 * on it — the shape behind the duplicate this test exists for.
 *
 * The frozen memory context is pre-inserted so `loadRunPromptContext` returns
 * from its cached branch: this test is about what reaches the model, and
 * memory retrieval would otherwise decide whether it runs at all.
 *
 * **What this cannot prove.** The automation tables live in WorkspaceDO, and
 * migration 0090 dropped their regional copies; this seeds the pre-retirement
 * SQLite shape and reaches it through the work-stream runtime port, so it
 * proves the statement and the mapping but not that the read routes to
 * WorkspaceDO in production. That routing is `WORKSPACE_LOCAL_TABLES`' job and
 * is exercised by the subscription read in the same function; a test that
 * proved it here would have to run against a real object, in `test-workers/`.
 */
function seededDatabase(options: { targets?: string } = {}): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Alex', 'Europe/London', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       next_sequence_number, last_activity_at, created_at, updated_at, scope)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Competitor briefing · 2026-08-22',
            'Produce the daily competitor briefing.', 'automation', '${OWNER}', 'running',
            1, '2026-08-22', '2026-08-22', '2026-08-22', 'personal');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES ('${TEMPLATE}', '${WORKSPACE}', '${OWNER}', 'Daily competitor briefing',
            'Brief', 'private', 1, '2026-01-01', '2026-01-01');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json,
       expected_outputs_json, default_behavior_json, memory_tables_json, created_by_user_id, created_at)
    VALUES ('${VERSION}', '${TEMPLATE}', 1, 'Write the briefing.', '[]',
            '["Competitor briefing"]', '{}', '[]', '${OWNER}', '2026-01-01');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, status, email_address, email_route_status, created_at, updated_at)
    VALUES ('${SUBSCRIPTION}', '${WORKSPACE}', '${TEMPLATE}', '${VERSION}', 'personal', '${OWNER}',
            '{"type":"user","userId":"${OWNER}"}', 'active',
            'calm-bright-gentle-otter@automation.with-avalon.com', 'active', '2026-01-01', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, model_plugin_id, scope, owner_user_id, display_name,
       status, granted_scopes_json, created_at, updated_at)
    VALUES ('${CONNECTION}', '${WORKSPACE}', 'slack', 'plugin_slack_acme', 'workspace', NULL,
            'Acme', 'healthy', '[]', '2026-01-01', '2026-01-01');
    INSERT INTO slack_user_links
      (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status,
       created_at, updated_at)
    VALUES ('${LINK}', '${WORKSPACE}', '${CONNECTION}', '${OWNER}', 'T1', 'U1', 'active',
            '2026-01-01', '2026-01-01');
    ${options.targets ?? `
    INSERT INTO automation_delivery_targets
      (id, workspace_id, automation_subscription_id, target_type, user_id, email_address,
       status, created_at, updated_at)
    VALUES ('${TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'email', '${OWNER}',
            'alex@example.com', 'active', '2026-01-01', '2026-01-01');`}
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM,
    workspaceId: WORKSPACE,
    title: "Competitor briefing · 2026-08-22",
    description: "Produce the daily competitor briefing.",
    originType: "automation",
    createdByUserId: OWNER,
    exactState: "running",
    scope: "personal",
  });
  objectStores = new Map([[WORKSTREAM as string, objectStore]]);

  seedWorkstreamRun(objectStore, { id: RUN, origin: "automation",
    executionPrincipalJson: JSON.stringify({ type: "user", userId: OWNER }),
    attemptId: ATTEMPT, leaseOwner: LEASE_OWNER,
    leaseExpiresAt: Date.parse("2099-01-01T00:00:00.000Z") });
  // The object's own table rather than the retired `harness_run_memory_contexts`
  // view: slice 6 dropped it, so this is the real column set — no `workspace_id`
  // or `workstream_id` the object already knows, and `created_at` in unix
  // milliseconds rather than the view's ISO-8601.
  workstreamObjectRun(
    objectStore,
    `INSERT INTO run_memory_contexts
       (run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
        results_json, memory_context_hash, created_at)
     VALUES (?, ?, '[]', 'automation', 'fts_only', '[]', 'hash', ?)`,
    RUN,
    ATTEMPT,
    Date.parse("2026-08-22T00:00:00.000Z"),
  );
  return database;
}

type DeliveryTarget = AutomationRunContextV1["deliveryTargets"][number];

function workflowInput(deliveryTargets: DeliveryTarget[] = [{
  type: "email",
  emailAddress: "alex@example.com",
}]): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE,
    workstreamId: WORKSTREAM,
    loopId: `workstream:${WORKSTREAM}:substream:0:loop`,
    harnessRunId: RUN,
    triggerMessageId: null,
    automationSubscriptionId: SUBSCRIPTION,
    activityId: null,
    executionPrincipal: { type: "user", userId: asUserId(OWNER) },
    reason: "automation",
    automationRunContext: {
      schemaVersion: 1,
      automationId: SUBSCRIPTION,
      workspaceId: WORKSPACE,
      runId: "00000000-0000-7000-8000-00000000000b",
      authorityGeneration: 1,
      definitionRevision: 1,
      definition: {
        name: "Daily competitor briefing",
        description: "Brief",
        overview: "Produce the daily competitor briefing.",
        instructions: "Write the briefing.",
        requiredCapabilities: [],
        expectedOutputs: ["Competitor briefing"],
        defaultBehavior: {},
        recommendedPlugins: [],
        memoryTables: [],
      },
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      connectorBindings: {},
      deliveryTargets,
      modelOverride: null,
      executionPrincipal: { type: "user", userId: asUserId(OWNER) },
      trigger: { kind: "manual", requestedByUserId: asUserId(OWNER) },
      opening: null,
      memoryScope: { automationId: SUBSCRIPTION, authorityGeneration: 1 },
    },
  };
}

const lease = { attemptId: ATTEMPT, owner: LEASE_OWNER } as Parameters<typeof loadRunPromptContext>[2];
const workstream = {
  title: "Competitor briefing · 2026-08-22",
  objective: "Produce the daily competitor briefing.",
};

describe("what an automation run is told about its own delivery", () => {
  it("names the frozen destination Avalon will mail the result to", async () => {
    const env = envFor(seededDatabase());

    const context = await loadRunPromptContext(env, workflowInput(), lease, workstream);

    // The whole defect this test exists for: a run that is not told Avalon
    // delivers the result sends it itself through the mail connector, and the
    // owner receives the same briefing twice, from two different senders.
    expect(context.systemPrompt).toContain('"channel": "email"');
    expect(context.systemPrompt).toContain('"destination": "alex@example.com"');
    expect(context.systemPrompt).toContain("# Result delivery");
    expect(context.systemPrompt).toContain("# External delivery output");
    expect(context.systemPrompt).toContain("put the complete usable result in the final message");
    expect(context.systemPrompt).toContain(
      "drop every recipient — to, cc, channel, or DM target — that matches one of those destinations",
    );
  });

  it("lists nothing when the automation has no destination beyond Avalon", async () => {
    const env = envFor(seededDatabase({ targets: "" }));

    const context = await loadRunPromptContext(env, workflowInput([]), lease, workstream);

    // A run with no frozen destination is free to do the sending the task asks
    // for, so the context must not imply somebody else already sent it.
    expect(context.systemPrompt).toContain('"resultDelivery": []');
  });

  it("names a Slack destination by the id a tool call can be matched against", async () => {
    const env = envFor(seededDatabase({
      targets: `
        INSERT INTO automation_delivery_targets
          (id, workspace_id, automation_subscription_id, target_type, connection_id, user_id,
           slack_team_id, slack_user_id, status, created_at, updated_at)
        VALUES ('${TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'slack_agent_dm', '${CONNECTION}',
                '${OWNER}', 'T1', 'U1', 'active', '2026-01-01', '2026-01-01');`,
    }));

    const context = await loadRunPromptContext(env, workflowInput([{
      type: "slack_agent_dm",
      connectionId: CONNECTION,
      slackTeamId: "T1",
      slackUserId: "U1",
    }]), lease, workstream);

    // The rule the run applies is "does this recipient match one of these", so
    // a description is not something a tool argument can be compared against.
    expect(context.systemPrompt).toContain('"channel": "slack_agent_dm"');
    expect(context.systemPrompt).toContain('"destination": "U1"');
  });

  it("lists a Slack target that failed once, because Avalon still delivers to it", async () => {
    const env = envFor(seededDatabase({
      targets: `
        INSERT INTO automation_delivery_targets
          (id, workspace_id, automation_subscription_id, target_type, connection_id, user_id,
           slack_team_id, slack_user_id, status, created_at, updated_at)
        VALUES ('${TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'slack_agent_dm', '${CONNECTION}',
                '${OWNER}', 'T1', 'U1', 'needs_input', '2026-01-01', '2026-01-01');`,
    }));

    const context = await loadRunPromptContext(env, workflowInput([{
      type: "slack_agent_dm",
      connectionId: CONNECTION,
      slackTeamId: "T1",
      slackUserId: "U1",
    }]), lease, workstream);

    // The Slack sender deliberately attempts a `needs_input` target rather than
    // trusting a stale belief. Filtering it out here would tell the run nothing
    // is sending and put the duplicate back for the targets most likely to be
    // in that state.
    expect(context.systemPrompt).toContain('"destination": "U1"');
  });

  it("leaves out a Slack target whose owner turned both notifications off", async () => {
    const env = envFor(seededDatabase({
      targets: `
        INSERT INTO automation_delivery_targets
          (id, workspace_id, automation_subscription_id, target_type, connection_id, user_id,
           slack_team_id, slack_user_id, status, created_at, updated_at)
        VALUES ('${TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'slack_agent_dm', '${CONNECTION}',
                '${OWNER}', 'T1', 'U1', 'active', '2026-01-01', '2026-01-01');
        INSERT INTO slack_delivery_preferences
          (connection_id, user_id, slack_user_id, notify_automation_completed, notify_needs_input,
           updated_at)
        VALUES ('${CONNECTION}', '${OWNER}', 'U1', 0, 0, '2026-01-01');`,
    }));

    const context = await loadRunPromptContext(env, workflowInput([]), lease, workstream);

    // Avalon sends nothing to it, so telling the run to stand down on its
    // account would deliver the result nowhere.
    expect(context.systemPrompt).toContain('"resultDelivery": []');
  });

  it("orders destinations so two renders of one run are the same bytes", async () => {
    const env = envFor(seededDatabase({
      targets: `
        INSERT INTO automation_delivery_targets
          (id, workspace_id, automation_subscription_id, target_type, connection_id, user_id,
           slack_team_id, slack_user_id, status, created_at, updated_at)
        VALUES ('${TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'slack_agent_dm', '${CONNECTION}',
                '${OWNER}', 'T1', 'U1', 'active', '2026-01-01', '2026-01-01');
        INSERT INTO automation_delivery_targets
          (id, workspace_id, automation_subscription_id, target_type, user_id, email_address,
           status, created_at, updated_at)
        VALUES ('${LINK}', '${WORKSPACE}', '${SUBSCRIPTION}', 'email', '${OWNER}',
                'alex@example.com', 'active', '2026-01-01', '2026-01-01');`,
    }));

    const context = await loadRunPromptContext(env, workflowInput([
      { type: "slack_agent_dm", connectionId: CONNECTION, slackTeamId: "T1", slackUserId: "U1" },
      { type: "email", emailAddress: "alex@example.com" },
    ]), lease, workstream);

    // The prefix is re-rendered every turn and must survive a retry unchanged,
    // and nothing constrains the order two rows come back in.
    const start = context.systemPrompt.indexOf('"resultDelivery"');
    const delivery = context.systemPrompt.slice(start, context.systemPrompt.indexOf("]", start));
    expect(delivery).toContain("alex@example.com");
    expect(delivery).toContain("U1");
    expect(delivery.indexOf("alex@example.com")).toBeLessThan(delivery.indexOf("U1"));
  });

  it("does not claim an email destination outside production", async () => {
    const env = envFor(seededDatabase(), "test");

    const context = await loadRunPromptContext(env, workflowInput(), lease, workstream);

    // `sendResendEmail` refuses to send outside production, so a run told
    // Avalon has the email covered stands down and nobody gets the briefing —
    // which is every staging automation, going quiet with nothing to explain
    // it now that the compiler no longer writes a provider send.
    expect(context.systemPrompt).toContain('"resultDelivery": []');
    expect(context.systemPrompt).not.toContain("alex@example.com");
  });

  it("ignores a destination that is not delivering", async () => {
    const env = envFor(seededDatabase({
      targets: `
        INSERT INTO automation_delivery_targets
          (id, workspace_id, automation_subscription_id, target_type, user_id, email_address,
           status, created_at, updated_at)
        VALUES ('${TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'email', '${OWNER}',
                'alex@example.com', 'disabled', '2026-01-01', '2026-01-01');`,
    }));

    const context = await loadRunPromptContext(env, workflowInput([]), lease, workstream);

    // A disabled or failed target sends nothing, so the run must not be told to
    // stand down on its account.
    expect(context.systemPrompt).not.toContain("alex@example.com");
    expect(context.systemPrompt).toContain('"resultDelivery": []');
  });
});
