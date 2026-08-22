import {
  asHarnessRunId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
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
const SUBSCRIPTION = "00000000-0000-7000-8000-000000000007";
const TARGET = "00000000-0000-7000-8000-000000000008";
const ATTEMPT = "attempt-1";
const LEASE_OWNER = "lease-owner-1";

const databases: DatabaseSync[] = [];
let objectStores = new Map<string, DatabaseSync>();
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function envFor(database: DatabaseSync): Env {
  const base = createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
  });
  return withWorkstreamRuntimeDatabase(base, WORKSPACE, WORKSTREAM);
}

/**
 * One personal automation, run by its schedule, with the owner's own email
 * address frozen on it as a delivery target — the shape behind the duplicate
 * this test exists for.
 *
 * The frozen memory context is pre-inserted so `loadRunPromptContext` returns
 * from its cached branch: this test is about what reaches the model, and
 * memory retrieval would otherwise decide whether it runs at all.
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
    ${options.targets ?? `
    INSERT INTO automation_delivery_targets
      (id, workspace_id, automation_subscription_id, target_type, user_id, email_address,
       status, created_at, updated_at)
    VALUES ('${TARGET}', '${WORKSPACE}', '${SUBSCRIPTION}', 'email', '${OWNER}',
            'alex@example.com', 'active', '2026-01-01', '2026-01-01');`}
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: WORKSTREAM, workspaceId: WORKSPACE });
  objectStores = new Map([[WORKSTREAM as string, objectStore]]);
  workstreamObjectRun(
    objectStore,
    `INSERT INTO workstreams
       (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
        next_sequence_number, last_activity_at, created_at, updated_at, scope)
     VALUES (?, ?, 'Competitor briefing · 2026-08-22', 'Produce the daily competitor briefing.',
             'automation', ?, 'running', 1, '2026-08-22', '2026-08-22', '2026-08-22', 'personal')`,
    WORKSTREAM,
    WORKSPACE,
    OWNER,
  );
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at,
        attempt_id, lease_owner, lease_expires_at)
     VALUES (?, ?, ?, 'automation', ?, 'running', '2026-08-22', ?, ?, '2099-01-01T00:00:00.000Z')`,
    RUN,
    WORKSPACE,
    WORKSTREAM,
    JSON.stringify({ type: "user", userId: OWNER }),
    ATTEMPT,
    LEASE_OWNER,
  );
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_run_memory_contexts
       (harness_run_id, workspace_id, workstream_id, attempt_id, memory_scope_ids_json,
        query_text, retrieval_mode, results_json, memory_context_hash, created_at)
     VALUES (?, ?, ?, ?, '[]', 'automation', 'fts_only', '[]', 'hash', '2026-08-22')`,
    RUN,
    WORKSPACE,
    WORKSTREAM,
    ATTEMPT,
  );
  return database;
}

const workflowInput: WorkstreamWorkflowInput = {
  region: "global",
  workspaceId: WORKSPACE,
  workstreamId: WORKSTREAM,
  harnessRunId: RUN,
  triggerMessageId: null,
  automationSubscriptionId: SUBSCRIPTION,
  activityId: null,
  executionPrincipal: { type: "user", userId: asUserId(OWNER) },
  reason: "automation",
};

const lease = { attemptId: ATTEMPT, owner: LEASE_OWNER } as Parameters<typeof loadRunPromptContext>[2];
const workstream = {
  title: "Competitor briefing · 2026-08-22",
  objective: "Produce the daily competitor briefing.",
};

describe("what an automation run is told about its own delivery", () => {
  it("names the frozen destination Avalon will mail the result to", async () => {
    const env = envFor(seededDatabase());

    const context = await loadRunPromptContext(env, workflowInput, lease, workstream);

    // The whole defect this test exists for: a run that is not told Avalon
    // delivers the result sends it itself through the mail connector, and the
    // owner receives the same briefing twice, from two different senders.
    expect(context.systemPrompt).toContain('"channel": "email"');
    expect(context.systemPrompt).toContain('"destination": "alex@example.com"');
    expect(context.systemPrompt).toContain(
      "Never send, draft, or post a copy of the result to a destination listed there",
    );
  });

  it("lists nothing when the automation has no destination beyond Avalon", async () => {
    const env = envFor(seededDatabase({ targets: "" }));

    const context = await loadRunPromptContext(env, workflowInput, lease, workstream);

    // A run with no frozen destination is free to do the sending the task asks
    // for, so the context must not imply somebody else already sent it.
    expect(context.systemPrompt).toContain('"resultDelivery": []');
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

    const context = await loadRunPromptContext(env, workflowInput, lease, workstream);

    // A disabled or failed target sends nothing, so the run must not be told to
    // stand down on its account.
    expect(context.systemPrompt).not.toContain("alex@example.com");
    expect(context.systemPrompt).toContain('"resultDelivery": []');
  });
});
