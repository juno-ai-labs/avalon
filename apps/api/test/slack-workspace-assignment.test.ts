import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Env } from "../src/env";
import { encryptString, sha256 } from "../src/lib/crypto";
import { __slackAgentTesting, SlackAgentService } from "../src/services/slack-agent-service";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import {
  runWorkspaceScheduleTarget,
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
  type WorkspaceScheduleTarget,
} from "../src/services/workspace-schedule-execution";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createWorkspaceObjectTable } from "./helpers/workspace-object-tables";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamContract,
  testWorkstreamObjectStore,
  workstreamObjectAll,
  workstreamObjectGet,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const databases: DatabaseSync[] = [];

/**
 * Open a fixture work stream's own object database and mirror its D1 product
 * row into it. Creator and participant writes route to this store since the
 * cutover — the D1 `workstreams` row is only the regional directory copy.
 */
function seedWorkstreamObject(
  objectStores: Map<string, DatabaseSync>,
  ids: { workstreamId: string; workspaceId: string },
  row: { title: string; objective: string; createdByUserId: string | null; harnessStatus: string },
): DatabaseSync {
  const store = testWorkstreamObjectStore();
  databases.push(store);
  seedWorkstreamObjectRoot(store, ids);
  workstreamObjectRun(
    store,
    `INSERT INTO workstreams
       (id, workspace_id, title, objective, origin_type, created_by_user_id,
        harness_status, last_activity_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ad_hoc', ?, ?, '2026-01-01', '2026-01-01', '2026-01-01')`,
    ids.workstreamId,
    ids.workspaceId,
    row.title,
    row.objective,
    row.createdByUserId,
    row.harnessStatus,
  );
  objectStores.set(ids.workstreamId, store);
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("Slack workspace workstream assignment", () => {
  it("assigns ownerless Slack workstreams when a verified-email member joins", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const encrypted = await encryptString(
      JSON.stringify({ botAccessToken: "xoxb-test" }),
      credentialsKey,
      "connection-slack",
    );
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
        ('a352221e-2577-4ad0-8889-5b24421f63fb', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('3f88f9ca-d7b3-4714-828e-b22187914524', 'Slack Workspace', 'slack-workspace', 'global',
              'user-owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES
        ('3f88f9ca-d7b3-4714-828e-b22187914524', 'user-owner', 'owner', 'active', '2026-01-01'),
        ('3f88f9ca-d7b3-4714-828e-b22187914524', 'a352221e-2577-4ad0-8889-5b24421f63fb', 'member', 'active', '2026-02-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('7a000000-0000-4000-8000-000000000001', '3f88f9ca-d7b3-4714-828e-b22187914524', 'Investigate', 'Investigate',
              'ad_hoc', NULL, 'completed', 2, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-ownerless', '3f88f9ca-d7b3-4714-828e-b22187914524', 'connection-slack', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:ownerless', '7a000000-0000-4000-8000-000000000001',
              'app_mention', 'public', '{}', '2026-01-01', '2026-01-01');
    `);
    const objectStores = new Map<string, DatabaseSync>();
    const objectStore = seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-000000000001", workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524" },
      { title: "Investigate", objective: "Investigate", createdByUserId: null, harnessStatus: "completed" },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toContain("users.lookupByEmail");
      return new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U456",
          team_id: "T123",
          deleted: false,
          is_bot: false,
          profile: { email: "taylor@example.com" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
      CONNECTOR_CREDENTIALS_KEY: credentialsKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing",
    });

    await expect(new SlackAgentService(env).assignWorkspaceWorkstreamsForMember(
      "3f88f9ca-d7b3-4714-828e-b22187914524",
      "a352221e-2577-4ad0-8889-5b24421f63fb",
      "taylor@example.com",
    )).resolves.toBe(1);

    expect(database.prepare(
      `SELECT assigned_user_id, assignment_method, execution_scope, linked_user_id
       FROM slack_agent_sessions WHERE id = 'session-ownerless'`,
    ).get()).toEqual({
      assigned_user_id: "a352221e-2577-4ad0-8889-5b24421f63fb",
      assignment_method: "verified_email",
      execution_scope: "workspace",
      linked_user_id: null,
    });
    // Creator and participant state lives in the work stream's object.
    expect(workstreamObjectGet(
      objectStore,
      `SELECT user_id, participation_reason FROM workstream_participants
       WHERE workstream_id = '7a000000-0000-4000-8000-000000000001'`,
    )).toEqual({ user_id: "a352221e-2577-4ad0-8889-5b24421f63fb", participation_reason: "creator" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT created_by_user_id FROM workstreams WHERE id = '7a000000-0000-4000-8000-000000000001'",
    )).toEqual({ created_by_user_id: "a352221e-2577-4ad0-8889-5b24421f63fb" });
  });

  it("keeps an existing creator when a later Slack assignment resolves the same session", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const encrypted = await encryptString(
      JSON.stringify({ botAccessToken: "xoxb-test" }),
      credentialsKey,
      "connection-slack",
    );
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
        ('a352221e-2577-4ad0-8889-5b24421f63fb', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('3f88f9ca-d7b3-4714-828e-b22187914524', 'Slack Workspace', 'slack-workspace', 'global',
              'user-owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES
        ('3f88f9ca-d7b3-4714-828e-b22187914524', 'user-owner', 'owner', 'active', '2026-01-01'),
        ('3f88f9ca-d7b3-4714-828e-b22187914524', 'a352221e-2577-4ad0-8889-5b24421f63fb', 'member', 'active', '2026-02-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('7a000000-0000-4000-8000-000000000002', '3f88f9ca-d7b3-4714-828e-b22187914524', 'Investigate', 'Investigate',
              'ad_hoc', 'user-owner', 'completed', 2, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-owned', '3f88f9ca-d7b3-4714-828e-b22187914524', 'connection-slack', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:owned', '7a000000-0000-4000-8000-000000000002',
              'app_mention', 'public', '{}', '2026-01-01', '2026-01-01');
    `);
    const objectStores = new Map<string, DatabaseSync>();
    const objectStore = seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-000000000002", workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524" },
      { title: "Investigate", objective: "Investigate", createdByUserId: "user-owner", harnessStatus: "completed" },
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      user: {
        id: "U456",
        team_id: "T123",
        deleted: false,
        is_bot: false,
        profile: { email: "taylor@example.com" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
      CONNECTOR_CREDENTIALS_KEY: credentialsKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing",
    });

    await expect(new SlackAgentService(env).assignWorkspaceWorkstreamsForMember(
      "3f88f9ca-d7b3-4714-828e-b22187914524",
      "a352221e-2577-4ad0-8889-5b24421f63fb",
      "taylor@example.com",
    )).resolves.toBe(1);

    expect(workstreamObjectGet(
      objectStore,
      "SELECT created_by_user_id FROM workstreams WHERE id = '7a000000-0000-4000-8000-000000000002'",
    )).toEqual({ created_by_user_id: "user-owner" });
  });

  it("does not answer the next external elicitation when a Slack event is retried", async () => {
    const database = migratedDatabase();
    const objectStores = new Map<string, DatabaseSync>();
    const objectStore = testWorkstreamObjectStore();
    databases.push(objectStore);
    seedWorkstreamObjectRoot(objectStore, {
      workstreamId: "7a000000-0000-4000-8000-000000000005",
      workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524",
    });
    objectStores.set("7a000000-0000-4000-8000-000000000005", objectStore);
    seedElicitationRetry(database, objectStore, "system", null, JSON.stringify({
      provider: "slack",
      providerAccountId: "T123",
      providerUserId: "U456",
      displayName: "Taylor",
      avatarUrl: null,
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
    });

    await expect(new SlackWorkspaceWorkstreamService(env, asWorkspaceId("3f88f9ca-d7b3-4714-828e-b22187914524")).answerOpenElicitation(
      "7a000000-0000-4000-8000-000000000005",
      {
        actor: {
          provider: "slack",
          providerAccountId: "T123",
          providerUserId: "U456",
          displayName: "Taylor",
          avatarUrl: null,
        },
        text: "stale answer",
        clientMessageId: "event:retry",
        slackOrigin: {
          teamId: "T123",
          channelId: "C123",
          channelName: "general",
          threadTs: "123.456",
          invocationType: "app_mention",
          channelType: "public",
          matchedAvalonUserId: null,
          nearbyMessagesStatus: "available",
          nearbyMessages: [],
          attachments: [],
        },
      },
    )).resolves.toEqual({ elicitation: null, harnessRunId: null });

    expect(workstreamObjectAll(
      objectStore,
      "SELECT id, status, answer_json FROM elicitations ORDER BY created_at",
    )).toEqual([
      { id: "elicitation-a", status: "open", answer_json: null },
      { id: "elicitation-b", status: "open", answer_json: null },
    ]);
  });

  it("lets an explicit account link correct a creator its own email guess produced", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const encrypted = await encryptString(
      JSON.stringify({ botAccessToken: "xoxb-test" }),
      credentialsKey,
      "connection-slack",
    );
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
        ('a352221e-2577-4ad0-8889-5b24421f63fb', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01'),
        ('user-jordan', 'google-jordan', 'jordan@example.com', 'Jordan', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('3f88f9ca-d7b3-4714-828e-b22187914524', 'Slack Workspace', 'slack-workspace', 'global',
              'user-owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES
        ('3f88f9ca-d7b3-4714-828e-b22187914524', 'user-owner', 'owner', 'active', '2026-01-01'),
        ('3f88f9ca-d7b3-4714-828e-b22187914524', 'a352221e-2577-4ad0-8889-5b24421f63fb', 'member', 'active', '2026-01-01'),
        ('3f88f9ca-d7b3-4714-828e-b22187914524', 'user-jordan', 'member', 'active', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES
        ('7a000000-0000-4000-8000-000000000003', '3f88f9ca-d7b3-4714-828e-b22187914524', 'Guessed', 'Slack task', 'ad_hoc', 'user-jordan',
         'completed', 2, '2026-01-01', '2026-01-01', '2026-01-01'),
        ('7a000000-0000-4000-8000-000000000004', '3f88f9ca-d7b3-4714-828e-b22187914524', 'Elsewhere', 'Slack task', 'ad_hoc', 'user-owner',
         'completed', 2, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO workstream_participants
        (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
      VALUES ('7a000000-0000-4000-8000-000000000003', 'user-jordan', 'user-jordan', 'creator', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         assigned_user_id, assigned_at, assignment_method, context_json, created_at, updated_at)
      VALUES
        ('session-guessed', '3f88f9ca-d7b3-4714-828e-b22187914524', 'connection-slack', NULL, 'workspace',
         'T123', 'U456', 'C123', '1.0', 'event:guessed', '7a000000-0000-4000-8000-000000000003',
         'app_mention', 'public', 'user-jordan', '2026-01-01', 'verified_email', '{}',
         '2026-01-01', '2026-01-01'),
        ('session-elsewhere', '3f88f9ca-d7b3-4714-828e-b22187914524', 'connection-slack', NULL, 'workspace',
         'T123', 'U456', 'C123', '2.0', 'event:elsewhere', '7a000000-0000-4000-8000-000000000004',
         'app_mention', 'public', 'user-owner', '2026-01-01', 'explicit_link', '{}',
         '2026-01-01', '2026-01-01');
      INSERT INTO slack_link_challenges
        (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, created_at)
      VALUES ('${await sha256("link-token")}', 'connection-slack', 'T123', 'U456',
              '2099-01-01T00:00:00.000Z', '2026-01-01');
      INSERT INTO slack_installation_routes
        (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
      VALUES ('T123', 'global', '3f88f9ca-d7b3-4714-828e-b22187914524',
              'connection-slack', 'active', '2026-01-01', '2026-01-01');
    `);
    const objectStores = new Map<string, DatabaseSync>();
    const guessedStore = seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-000000000003", workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524" },
      { title: "Guessed", objective: "Slack task", createdByUserId: "user-jordan", harnessStatus: "completed" },
    );
    workstreamObjectRun(
      guessedStore,
      `INSERT INTO workstream_participants
         (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
       VALUES ('7a000000-0000-4000-8000-000000000003', 'user-jordan', 'user-jordan', 'creator', '2026-01-01', NULL)`,
    );
    const elsewhereStore = seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-000000000004", workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524" },
      { title: "Elsewhere", objective: "Slack task", createdByUserId: "user-owner", harnessStatus: "completed" },
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      // App Home reads the member's recent work streams from the WorkspaceDO
      // directory after cutover; an empty page keeps the link flow moving.
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: { recentWorkstreamDirectory: vi.fn(async () => ({ items: [] })) },
      }),
      AVALON_REGION: "global",
      CONNECTOR_CREDENTIALS_KEY: credentialsKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing",
    });

    await expect(new SlackAgentService(env).linkUser({
      sessionId: "session-taylor",
      userId: asUserId("a352221e-2577-4ad0-8889-5b24421f63fb"),
      workspaceId: asWorkspaceId("3f88f9ca-d7b3-4714-828e-b22187914524"),
      region: "global",
      role: "member",
    }, "link-token")).resolves.toMatchObject({ linked: true, slackUserId: "U456" });

    // The link is a stronger statement about who this Slack member is than the
    // address its own earlier assignment matched on.
    expect(workstreamObjectGet(
      guessedStore,
      "SELECT created_by_user_id FROM workstreams WHERE id = '7a000000-0000-4000-8000-000000000003'",
    )).toEqual({ created_by_user_id: "a352221e-2577-4ad0-8889-5b24421f63fb" });
    expect(workstreamObjectAll(
      guessedStore,
      `SELECT user_id, participation_reason FROM workstream_participants
       WHERE workstream_id = '7a000000-0000-4000-8000-000000000003' ORDER BY user_id`,
    )).toEqual([
      { user_id: "a352221e-2577-4ad0-8889-5b24421f63fb", participation_reason: "creator" },
      { user_id: "user-jordan", participation_reason: "explicit" },
    ]);
    // A creator recorded by anything other than that guess still stands.
    expect(workstreamObjectGet(
      elsewhereStore,
      "SELECT created_by_user_id FROM workstreams WHERE id = '7a000000-0000-4000-8000-000000000004'",
    )).toEqual({ created_by_user_id: "user-owner" });
  });
});


async function seedLinkedSlackMember(database: DatabaseSync, credentialsKey: string): Promise<void> {
  await seedSlackInstallation(database, credentialsKey);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('019fc4e0-4444-7000-8000-000000000044', 'google-linked',
            'linked@example.com', 'Linked User',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('22222222-2222-4222-8222-222222222222',
            '019fc4e0-4444-7000-8000-000000000044', 'member', 'active', '2026-01-01');
    INSERT INTO slack_user_links
      (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
       status, created_at, updated_at)
    VALUES ('33333333-3333-4333-8333-333333333333',
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            '019fc4e0-4444-7000-8000-000000000044', 'T123', 'U456',
            'active', '2026-01-01', '2026-01-01');
    INSERT INTO slack_installation_routes
      (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
    VALUES ('T123', 'global', '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111', 'active', '2026-01-01', '2026-01-01');
  `);
}

describe("Slack connector principal delivery", () => {
  // The regression these pin (2026-08-22): a linked member's ingress carried a
  // synthesized `slack:{team}:{user}` session id with no principal marker, the
  // object looked it up in `sessions`, and every mention died as
  // `session_revoked`. The product stubs here fabricate the object's answers,
  // so what these prove is the Worker's half of the contract — the marker on
  // the wire and the classification of the object's refusal. The object's
  // half, verifying the principal, is proved in
  // `workstream-room-authorization.test.ts`.
  const connectorAuth = {
    sessionId: "slack:T123:U456",
    userId: "019fc4e0-4444-7000-8000-000000000044",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    region: "global",
    role: "member",
    principal: "connector",
  };

  function deliveryEnv(
    database: DatabaseSync,
    credentialsKey: string,
    substreamAgents: DurableObjectNamespace,
  ): Env {
    return createTestEnv({
      ...slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
      SUBSTREAM_AGENTS: substreamAgents,
      WORKSTREAM_DOS: testSubstreamAgentsBinding(database, {
        extra: { flushWorkspaceDirectoryEffects: vi.fn(async () => ({ status: 200, bodyJson: "{}" })) },
      }),
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: { hasWorkstreamDirectory: vi.fn(async () => true) },
      }),
    });
  }

  it("presents the connector principal to the work-stream object, not a login session", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedLinkedSlackMember(database, credentialsKey);
    insertSlackEventJob(database, "event:principal", appMention("EvPrincipal"));
    const { fetcher } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    let initializeAuth: unknown = null;
    const env = deliveryEnv(database, credentialsKey, testSubstreamAgentsBinding(database, {
        product: {
          initialize: (request) => {
            initializeAuth = request.auth;
            const input = request.input as Record<string, unknown>;
            return {
              workstream: testWorkstreamContract({
                id: input.workstreamId,
                workspaceId: input.workspaceId,
                title: input.title,
                objective: input.objective,
                titleStatus: input.titleStatus,
                createdByUserId: input.creatorUserId,
                emailAddress: input.emailAddress,
              }),
              messageId: crypto.randomUUID(),
              harnessRunId: crypto.randomUUID(),
            };
          },
          attach_resource: (request) => ({
            id: request.resourceId,
            workspaceId: "22222222-2222-4222-8222-222222222222",
            connectionId: null,
            resourceType: "slack_thread",
            provider: "slack",
            providerResourceId: null,
            title: "Slack thread",
            mimeType: null,
            canonicalUrl: null,
            watchEnabled: false,
            watchStatus: "unsupported",
            lastHydratedAt: null,
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          }),
      },
    }));

    await new SlackAgentService(env).processQueuedIngress(
      "22222222-2222-4222-8222-222222222222",
      "event:principal",
    );

    // `toEqual`, not `toMatchObject`: the payload the object authorizes on is
    // exactly this — nothing weaker, and no extra field the strict schema
    // would refuse.
    expect(initializeAuth).toEqual(connectorAuth);
  });

  it("keeps a refused connector principal retryable and the installation healthy", async () => {
    // `connector_member_revoked` is reachable only as a race — a membership or
    // role change landing between the ingress's link read and the object's
    // re-check — so the durable retry is its resolution. Before this was
    // pinned, the 401 was read as an installation-grant failure: the job was
    // made terminal at the attempt ceiling, an operator was paged, and the
    // whole workspace's connection flipped to `needs_reconnect`.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedLinkedSlackMember(database, credentialsKey);
    insertSlackEventJob(database, "event:race", appMention("EvRace"));
    const { fetcher } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    const env = deliveryEnv(database, credentialsKey, testSubstreamAgentsBinding(database, {
        extra: {
          handleProductRequest: vi.fn(() => ({
            status: 401,
            bodyJson: JSON.stringify({
              error: "connector_member_revoked",
              message: "You are no longer an active member of this workspace",
            }),
          })),
      },
    }));

    await expect(new SlackAgentService(env).processQueuedIngress(
      "22222222-2222-4222-8222-222222222222",
      "event:race",
    )).rejects.toMatchObject({ code: "connector_member_revoked" });

    // Failed but retryable: the attempt count stays where the claim put it
    // rather than being jumped to the ceiling.
    expect(database.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:race'",
    ).get()).toEqual({ status: "failed", attempt_count: 1, error_code: "connector_member_revoked" });
    // One member's refusal says nothing about the installation's grant.
    expect(database.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: "healthy" });
  });

  it("carries the connector principal on a reply into an existing thread", async () => {
    // The reply branch builds its own WorkstreamService, separately from the
    // create branch — and the reply is the symptom the incident was reported
    // under.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedLinkedSlackMember(database, credentialsKey);
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('7a000000-0000-4000-8000-0000000000aa', '22222222-2222-4222-8222-222222222222',
              'Investigate', 'Investigate', 'ad_hoc', NULL, 'completed', 2,
              '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-reply', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:opening',
              '7a000000-0000-4000-8000-0000000000aa', 'app_mention', 'public',
              '{}', '2026-01-01', '2026-01-01');
    `);
    const objectStores = new Map<string, DatabaseSync>();
    seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-0000000000aa", workspaceId: "22222222-2222-4222-8222-222222222222" },
      { title: "Investigate", objective: "Investigate", createdByUserId: null, harnessStatus: "completed" },
    );
    insertSlackEventJob(database, "event:reply", appMention("EvReply", { threadTs: "1.0", ts: "2.0" }));
    const { fetcher } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    const captured: Array<{ operation: string; auth: unknown }> = [];
    const env = deliveryEnv(database, credentialsKey, testSubstreamAgentsBinding(database, {
        objectStores,
        product: {
          create_message: (request) => {
            captured.push(request as { operation: string; auth: unknown });
            return {
              message: {
                id: "019fc4e0-5555-7000-8000-000000000055",
                clientMessageId: "slack:reply",
                workspaceId: "22222222-2222-4222-8222-222222222222",
                workstreamId: "7a000000-0000-4000-8000-0000000000aa",
                author: { type: "agent" },
                messageType: "text",
                textContent: "which domains are available",
                structuredContent: null,
                mentions: [],
                attachments: [],
                sequenceNumber: 2,
                createdAt: "2026-01-02T00:00:00.000Z",
                editedAt: null,
              },
              agentInvoked: true,
              harnessRunId: "019fc4e0-6666-7000-8000-000000000066",
            };
          },
      },
    }));

    await new SlackAgentService(env).processQueuedIngress(
      "22222222-2222-4222-8222-222222222222",
      "event:reply",
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]!.auth).toEqual(connectorAuth);
  });
});

describe("Slack public channel membership", () => {
  it("durably schedules a full public-channel sync after workspace authorization", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const send = vi.fn(async () => { throw new Error("queue unavailable"); });
    const env = slackMembershipEnvironment(database, credentialsKey, send);

    await new SlackAgentService(env).schedulePublicChannelSync("11111111-1111-4111-8111-111111111111");

    const job = database.prepare(
      "SELECT id, team_id, kind, payload_json, status FROM slack_ingress_jobs",
    ).get() as Record<string, unknown>;
    expect(job).toMatchObject({ team_id: "T123", kind: "event", status: "queued" });
    expect(JSON.parse(String(job.payload_json))).toMatchObject({
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event: { type: "avalon_public_channel_sync" },
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "slack_ingress",
      region: "global",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      jobId: job.id,
    }));
  });

  it("continues a rate-limited full sync with Slack's requested queue delay", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(slackMembershipEnvironment(database, credentialsKey, send));
    await service.schedulePublicChannelSync("11111111-1111-4111-8111-111111111111");
    const initial = database.prepare("SELECT id FROM slack_ingress_jobs").get() as { id: string };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.list")) return new Response(JSON.stringify({
        ok: true,
        channels: [{ id: "CNEW", is_private: false, is_archived: false, is_member: false }],
        response_metadata: { next_cursor: "" },
      }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: "ratelimited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "9" },
      });
    }));

    await service.processQueuedIngress(initial.id);

    const jobs = database.prepare(
      "SELECT id, status FROM slack_ingress_jobs ORDER BY received_at, id",
    ).all() as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(2);
    expect(jobs).toContainEqual({ id: initial.id, status: "completed" });
    const continuation = jobs.find((job) => job.id !== initial.id)!;
    expect(continuation.status).toBe("queued");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      jobId: continuation.id,
    }), { delaySeconds: 9 });
  });

  it("joins a newly created public channel from its durable Slack event", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    seedSlackActivitySubscription(database, "slack.channel.created");
    database.prepare(
      `INSERT INTO slack_ingress_jobs
       (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
        status, attempt_count, received_at, updated_at)
       VALUES (?, '22222222-2222-4222-8222-222222222222',
               '11111111-1111-4111-8111-111111111111', 'T123', 'hash', 'event', ?,
               'queued', 0, '2026-01-01', '2026-01-01')`,
    ).run("event:EvChannelCreated", JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvChannelCreated",
      event: { type: "channel_created", channel: { id: "CNEW", name: "new-channel" } },
    }));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/api/conversations.join");
      expect(JSON.parse(String(init?.body))).toEqual({ channel: "CNEW" });
      return new Response(JSON.stringify({ ok: true, channel: { id: "CNEW" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const activityQueueSend = vi.fn(async () => undefined);
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      activityQueueSend,
    )).processQueuedIngress("event:EvChannelCreated");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(database.prepare(
      `SELECT event_type, resource_type, provider_resource_id, title, metadata_json,
              visibility_json, raw_content_hash
       FROM activities WHERE provider_event_id = 'EvChannelCreated'`,
    ).get()).toMatchObject({
      event_type: "slack.channel.created",
      resource_type: "slack_channel",
      provider_resource_id: "CNEW",
      title: "Slack channel created in #new-channel",
      raw_content_hash: "hash",
    });
    expect(JSON.parse(String(database.prepare(
      "SELECT metadata_json FROM activities WHERE provider_event_id = 'EvChannelCreated'",
    ).get()!.metadata_json))).toMatchObject({
      teamId: "T123",
      channelId: "CNEW",
      channelName: "new-channel",
      channelType: "public",
    });
    expect(JSON.parse(String(database.prepare(
      "SELECT visibility_json FROM activities WHERE provider_event_id = 'EvChannelCreated'",
    ).get()!.visibility_json))).toMatchObject({
      workspaceAutomationAllowed: true,
      channelType: "public",
    });
    expect(activityQueueSend).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT status, payload_json, completed_at FROM slack_ingress_jobs WHERE id = 'event:EvChannelCreated'",
    ).get()).toMatchObject({ status: "completed", payload_json: null });
  });

  it("does not turn Avalon's own reaction events into automation activity", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:own-reaction", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvOwnReaction",
      authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
      event: {
        type: "reaction_added",
        user: "UBOT",
        reaction: "eyes",
        item_user: "U456",
        item: { type: "message", channel: "C123", ts: "1.0", channel_type: "channel" },
        event_ts: "1.1",
      },
    });
    const activityQueueSend = vi.fn(async () => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      activityQueueSend,
    )).processQueuedIngress("event:own-reaction");

    expect(database.prepare("SELECT COUNT(*) AS count FROM activities").get()).toEqual({ count: 0 });
    expect(activityQueueSend).not.toHaveBeenCalled();
  });

  it("adds eyes to the triggering message before starting Slack task processing", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:acknowledge", appMention("EvAcknowledge"));
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      methods.push(method);
      if (method === "conversations.info") return new Response(JSON.stringify({
        ok: true,
        channel: { id: "C123", is_private: false, is_im: false, is_mpim: false },
      }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "users.info") return new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U456",
          team_id: "T123",
          deleted: false,
          is_bot: false,
          profile: { display_name: "Taylor", email: "taylor@example.com" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "reactions.add") {
        expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
        expect(JSON.parse(String(init?.body))).toEqual({
          channel: "C123",
          name: "eyes",
          timestamp: "1.0",
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "assistant.threads.setStatus" || method === "assistant.threads.setTitle") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "chat.startStream") return new Response(JSON.stringify({
        ok: true,
        channel: "C123",
        ts: "2.0",
      }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected Slack request ${url}`);
    }));
    const env = createTestEnv({
      ...slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
    });

    await new SlackAgentService(env).processQueuedIngress("event:acknowledge");

    expect(methods.indexOf("reactions.add")).toBeGreaterThan(methods.indexOf("users.info"));
    expect(methods.indexOf("reactions.add")).toBeLessThan(methods.indexOf("assistant.threads.setStatus"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT status, payload_json FROM slack_ingress_jobs WHERE id = 'event:acknowledge'",
    ).get()).toEqual({ status: "completed", payload_json: null });
  });

  it.each([
    ["too_many_reactions", "healthy"],
    ["missing_scope", "needs_reconnect"],
  ] as const)("continues an admitted task when reactions.add returns %s", async (reactionError, expectedStatus) => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, `event:${reactionError}`, appMention(`Ev${reactionError}`));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: false, error: reactionError });
    vi.stubGlobal("fetch", fetcher);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = createTestEnv({
      ...slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
    });

    await new SlackAgentService(env).processQueuedIngress(`event:${reactionError}`);

    expect(methods.indexOf("reactions.add")).toBeLessThan(methods.indexOf("assistant.threads.setStatus"));
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_activation_ack_failed",
      reason: reactionError,
    }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: expectedStatus });
    expect(database.prepare(
      `SELECT status, payload_json FROM slack_ingress_jobs WHERE id = 'event:${reactionError}'`,
    ).get()).toEqual({ status: "completed", payload_json: null });
  });

  it("uses the installed Slack capability grants for activation", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:missing-capability", appMention("EvMissingCapability"));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:missing-capability")).rejects.toThrow(/has not granted slack\.agent/iu);

    expect(methods).not.toContain("reactions.add");
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:missing-capability'",
    ).get()).toEqual({
      status: "failed",
      attempt_count: 20,
      error_code: "unsupported_capability",
    });
  });

  it("acknowledges linked-user activation without external actor lookup", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('44444444-4444-4444-8444-444444444444', 'google-linked',
              'linked@example.com', 'Linked User', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('22222222-2222-4222-8222-222222222222',
              '44444444-4444-4444-8444-444444444444', 'member', 'active', '2026-01-01');
      INSERT INTO slack_user_links
        (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
         status, created_at, updated_at)
      VALUES ('33333333-3333-4333-8333-333333333333',
              '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111',
              '44444444-4444-4444-8444-444444444444', 'T123', 'U456',
              'active', '2026-01-01', '2026-01-01');
    `);
    database.exec(`
      INSERT INTO slack_installation_routes
        (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
      VALUES ('T123', 'global', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', 'active', '2026-01-01', '2026-01-01');
    `);
    insertSlackEventJob(database, "event:linked", appMention("EvLinked"));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    // A linked member creates through the object creation coordinator. Capture
    // its product boundary: attribution belongs in the object, while regional
    // D1 retains only the identity anchor.
    let initializeInput: Record<string, unknown> | null = null;
    const env = createTestEnv({
      ...slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
        product: {
          initialize: (request) => {
            const input = request.input as Record<string, unknown>;
            initializeInput = input;
            return {
              workstream: testWorkstreamContract({
                id: input.workstreamId,
                workspaceId: input.workspaceId,
                title: input.title,
                objective: input.objective,
                titleStatus: input.titleStatus,
                createdByUserId: input.creatorUserId,
                emailAddress: input.emailAddress,
              }),
              messageId: crypto.randomUUID(),
              harnessRunId: crypto.randomUUID(),
            };
          },
          attach_resource: (request) => ({
            id: request.resourceId,
            workspaceId: "22222222-2222-4222-8222-222222222222",
            connectionId: null,
            resourceType: "slack_thread",
            provider: "slack",
            providerResourceId: null,
            title: "Slack thread",
            mimeType: null,
            canonicalUrl: null,
            watchEnabled: false,
            watchStatus: "unsupported",
            lastHydratedAt: null,
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          }),
        },
      }),
      WORKSTREAM_DOS: testSubstreamAgentsBinding(database, {
        extra: { flushWorkspaceDirectoryEffects: vi.fn(async () => ({ status: 200, bodyJson: "{}" })) },
      }),
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: { hasWorkstreamDirectory: vi.fn(async () => true) },
      }),
    });

    await new SlackAgentService(env).processQueuedIngress(
      "22222222-2222-4222-8222-222222222222",
      "event:linked",
    );

    expect(methods).toContain("reactions.add");
    expect(methods).not.toContain("users.info");
    expect(initializeInput).toMatchObject({
      creatorUserId: "44444444-4444-4444-8444-444444444444",
    });
    expect(database.prepare(
      "SELECT id, workspace_id, do_identity_anchor FROM workstreams",
    ).get()).toMatchObject({
      workspace_id: "22222222-2222-4222-8222-222222222222",
      do_identity_anchor: 1,
    });
  });

  it("makes deterministic ingress failures terminal in the durable job row", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:invalid", { type: 42 });

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:invalid")).rejects.toBeDefined();

    expect(database.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:invalid'",
    ).get()).toMatchObject({ status: "failed", attempt_count: 20 });
  });

  it("retries an access-token expiration without poisoning the Slack connection", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:expired", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvExpired",
      event: { type: "channel_created", channel: { id: "CNEW", name: "new-channel" } },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: "token_expired",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:expired")).rejects.toMatchObject({ message: "token_expired" });

    expect(database.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:expired'",
    ).get()).toEqual({ status: "failed", attempt_count: 1, error_code: "token_expired" });
    expect(database.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: "healthy" });
  });

  it("accepts an unlinked private-channel task regardless of legacy policy rows", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      `INSERT INTO slack_agent_policies
       (connection_id, allow_unlinked_workspace_tasks, public_channel_mode, private_channel_mode,
        allow_direct_messages, allow_commands, allow_shortcuts, created_at, updated_at)
       VALUES (?, 0, 'disabled', 'disabled', 0, 0, 0, '2026-01-01', '2026-01-01')`,
    ).run("11111111-1111-4111-8111-111111111111");
    const payload = appMention("EvWideLatitude");
    (payload.event as Record<string, unknown>).channel_type = "group";
    insertSlackEventJob(database, "event:wide-latitude", payload);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.info")) {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: "C123", name: "private-work", is_private: true, is_im: false, is_mpim: false },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("users.info")) {
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: "U456",
            team_id: "T123",
            deleted: false,
            is_bot: false,
            name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("assistant.threads.setStatus")
        || url.pathname.endsWith("assistant.threads.setTitle")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("chat.startStream")) {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const objectStores = new Map<string, DatabaseSync>();
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
      objectStores,
    )).processQueuedIngress("event:wide-latitude");

    // The created work stream's product row lives in its object; the regional
    // row is only the bootstrap identity anchor and keeps its placeholder.
    const [createdId] = [...objectStores.keys()];
    const createdStore = objectStores.get(createdId!)!;
    databases.push(createdStore);
    expect(workstreamObjectGet(createdStore, "SELECT title, objective FROM workstreams")).toEqual({
      title: "investigate this",
      objective: "investigate this",
    });
    expect(database.prepare(
      "SELECT id, workspace_id, do_identity_anchor FROM workstreams WHERE id = ?",
    ).get(createdId!)).toEqual({
      id: createdId,
      workspace_id: "22222222-2222-4222-8222-222222222222",
      do_identity_anchor: 1,
    });
    expect(database.prepare("SELECT execution_scope, channel_type FROM slack_agent_sessions").get()).toEqual({
      execution_scope: "workspace",
      channel_type: "private",
    });
  });

  it("marks a missing channel-lookup scope for reconnect before unlinked dispatch", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:missing-scope", appMention("EvMissingScope"));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.info")) {
        return new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:missing-scope");

    expect(database.prepare(
      "SELECT status, error_json FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toMatchObject({ status: "needs_reconnect" });
    expect(database.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:missing-scope'",
    ).get()).toEqual({ status: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks for the request again when a legacy retry has no recoverable prompt", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:legacy-retry-missing", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvLegacyRetryMissing",
      authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
      event: {
        type: "app_mention",
        user: "U456",
        channel: "C123",
        channel_type: "channel",
        thread_ts: "1.0",
        ts: "1.3",
        text: "<@UBOT> try again",
      },
    });
    const postedMessages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.replies")) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { type: "message", user: "U456", text: "<@UBOT> old request", ts: "1.0" },
            { type: "message", user: "UBOT", text: "A different reply", ts: "1.1", thread_ts: "1.0" },
          ],
          response_metadata: { next_cursor: "more" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        postedMessages.push(String((JSON.parse(String(init?.body)) as Record<string, unknown>).text));
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:legacy-retry-missing");

    expect(postedMessages).toEqual([expect.stringContaining("couldn’t find the original request")]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:legacy-retry-missing'",
    ).get()).toEqual({ status: "completed" });
  });

  it("runs a mention on a connection the row believes is broken", async () => {
    // The status is a record of one past moment and nothing re-checks it, so a
    // stale `needs_reconnect` must not decide whether a member's request is
    // answered. This used to post a denial, stash the prompt, and wait for
    // somebody to reconnect and reply `try again` — a denial posted with the
    // very bot token that proves the installation works.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      "UPDATE connector_connections SET status = 'needs_reconnect' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:unhealthy", appMention("EvUnhealthy"));
    const postedMessages: string[] = [];
    const threadTitles: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.info")) {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: "C123", is_private: false, is_im: false, is_mpim: false },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        postedMessages.push(String((JSON.parse(String(init?.body)) as Record<string, unknown>).text));
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("users.info")) {
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: "U456",
            team_id: "T123",
            deleted: false,
            is_bot: false,
            name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("assistant.threads.setStatus")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("assistant.threads.setTitle")) {
        threadTitles.push(String((JSON.parse(String(init?.body)) as Record<string, unknown>).title));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("chat.startStream")) {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const objectStores = new Map<string, DatabaseSync>();
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
      objectStores,
    )).processQueuedIngress("event:unhealthy");

    expect(postedMessages).not.toContainEqual(expect.stringContaining("connection needs attention"));
    // The created work stream's product row lives in its object; the regional
    // row is only the bootstrap identity anchor and keeps its placeholder.
    const [createdId] = [...objectStores.keys()];
    const createdStore = objectStores.get(createdId!)!;
    databases.push(createdStore);
    expect(workstreamObjectGet(createdStore, "SELECT title, objective FROM workstreams")).toEqual({
      title: "investigate this",
      objective: "investigate this",
    });
    expect(database.prepare(
      "SELECT id, workspace_id, do_identity_anchor FROM workstreams WHERE id = ?",
    ).get(createdId!)).toEqual({
      id: createdId,
      workspace_id: "22222222-2222-4222-8222-222222222222",
      do_identity_anchor: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM slack_agent_pending_prompts").get())
      .toEqual({ count: 0 });
    expect(threadTitles).toEqual(["investigate this"]);
  });
});

function seedElicitationRetry(
  database: DatabaseSync,
  objectStore: DatabaseSync,
  authorType: "human" | "system",
  authorUserId: string | null,
  externalActorJson: string | null,
): void {
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('a352221e-2577-4ad0-8889-5b24421f63fb', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('3f88f9ca-d7b3-4714-828e-b22187914524', 'Slack Workspace', 'slack-workspace', 'global',
            'user-owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('3f88f9ca-d7b3-4714-828e-b22187914524', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('3f88f9ca-d7b3-4714-828e-b22187914524', 'a352221e-2577-4ad0-8889-5b24421f63fb', 'member', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, next_sequence_number, email_address, email_route_status,
       last_activity_at, created_at, updated_at)
    VALUES ('7a000000-0000-4000-8000-000000000005', '3f88f9ca-d7b3-4714-828e-b22187914524', 'Retry', 'Retry', 'ad_hoc', NULL,
            'needs_input', 2, 'retry@automation.with-avalon.com', 'active',
            '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // Runs, elicitations, and the transcript live only in the work stream's
  // object since migration 0090.
  workstreamObjectRun(
    objectStore,
    `INSERT INTO workstreams
       (id, workspace_id, title, objective, origin_type, created_by_user_id,
        harness_status, next_sequence_number, email_address, email_route_status,
        last_activity_at, created_at, updated_at)
     VALUES ('7a000000-0000-4000-8000-000000000005', '3f88f9ca-d7b3-4714-828e-b22187914524', 'Retry', 'Retry', 'ad_hoc', NULL,
             'needs_input', 2, 'retry@automation.with-avalon.com', 'active',
             '2026-01-01', '2026-01-01', '2026-01-01')`,
  );
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
     VALUES
       ('run-a', '3f88f9ca-d7b3-4714-828e-b22187914524', '7a000000-0000-4000-8000-000000000005', 'test', '{}', 'needs_input', '2026-01-01'),
       ('run-b', '3f88f9ca-d7b3-4714-828e-b22187914524', '7a000000-0000-4000-8000-000000000005', 'test', '{}', 'needs_input', '2026-01-02')`,
  );
  workstreamObjectRun(
    objectStore,
    `INSERT INTO elicitations
       (id, workspace_id, workstream_id, harness_run_id, prompt, response_type,
        options_json, minimum_selections, maximum_selections, status, created_at)
     VALUES
       ('elicitation-a', '3f88f9ca-d7b3-4714-828e-b22187914524', '7a000000-0000-4000-8000-000000000005', 'run-a', 'First?', 'text',
        '[]', 0, NULL, 'open', '2026-01-01'),
       ('elicitation-b', '3f88f9ca-d7b3-4714-828e-b22187914524', '7a000000-0000-4000-8000-000000000005', 'run-b', 'Second?', 'text',
        '[]', 0, NULL, 'open', '2026-01-02')`,
  );
  workstreamObjectRun(
    objectStore,
    `INSERT INTO messages
     (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
      message_type, text_content, structured_content_json, sequence_number, created_at,
      external_actor_json)
     VALUES ('message-retry', 'event:retry', '3f88f9ca-d7b3-4714-828e-b22187914524', '7a000000-0000-4000-8000-000000000005', ?, ?,
             'elicitation', '', NULL, 1, '2026-01-01', ?)`,
    // The object stores an externally-actored message as author `external` —
    // its parts table rejects the legacy `system` + actor-json encoding.
    externalActorJson === null ? authorType : "external",
    authorUserId,
    externalActorJson,
  );
}

async function seedSlackInstallation(database: DatabaseSync, credentialsKey: string): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify({ botAccessToken: "xoxb-test", botUserId: "UBOT" }),
    credentialsKey,
    "11111111-1111-4111-8111-111111111111",
  );
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('22222222-2222-4222-8222-222222222222', 'Slack Workspace', 'slack-workspace', 'global',
            'user-owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('22222222-2222-4222-8222-222222222222', 'user-owner', 'owner', 'active', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
       model_plugin_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222', 'slack', 'workspace', NULL, 'T123',
            'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
            '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
            'plugin_slack_workspace');
  `);
}

describe("Slack ingress re-drive after reauthorization", () => {
  async function strandedJob(id: string): Promise<{ database: DatabaseSync; credentialsKey: string }> {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, id, appMention("EvStranded"));
    database.prepare(
      `UPDATE slack_ingress_jobs SET status = 'failed', attempt_count = 20,
         error_code = 'unauthorized', received_at = ?, updated_at = '2026-01-02'
       WHERE id = ?`,
    ).run(new Date().toISOString(), id);
    return { database, credentialsKey };
  }

  function sweep(database: DatabaseSync, credentialsKey: string): Promise<unknown[]> {
    const sent: unknown[] = [];
    return new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async (body: unknown) => { sent.push(body); }),
    )).maintainIngress().then(() => sent);
  }

  it("re-drives an authorization failure once the installation is reauthorized", async () => {
    // Slack reports `link_shared` exactly once and never redelivers it, so an
    // event that failed while the grant was dead is lost permanently unless
    // something lifts the retry ceiling after the reconnect.
    const { database, credentialsKey } = await strandedJob("event:stranded");
    database.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = '2026-01-03'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(database, credentialsKey);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:stranded")).toHaveLength(1);
    expect(database.prepare(
      "SELECT status, attempt_count FROM slack_ingress_jobs WHERE id = 'event:stranded'",
    ).get()).toMatchObject({ status: "queued", attempt_count: 0 });
  });

  it("does not re-drive while the connection is still marked", async () => {
    // The termination proof. An earlier draft selected on `updated_at` alone
    // against any non-disabled row, and every failure bumped that timestamp
    // through the marking write — so N stranded jobs re-drove each other
    // forever, on a signal that meant "something failed again" rather than
    // "someone reconnected". Only a return to `healthy` is a reconnect.
    const { database, credentialsKey } = await strandedJob("event:still-broken");
    database.prepare(
      `UPDATE connector_connections SET status = 'needs_reconnect', updated_at = '2026-01-03'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(database, credentialsKey);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:still-broken")).toHaveLength(0);
  });

  it("leaves a job alone when nothing about its connection has changed", async () => {
    const { database, credentialsKey } = await strandedJob("event:untouched");
    database.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = '2026-01-01'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(database, credentialsKey);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:untouched")).toHaveLength(0);
  });

  it("re-drives only failures a reauthorization can repair", async () => {
    // A job that died on malformed data is not fixed by a reconnect, and
    // re-driving it every time a connection is written is pure waste.
    const { database, credentialsKey } = await strandedJob("event:bad-data");
    database.prepare(
      "UPDATE slack_ingress_jobs SET error_code = 'invalid_slack_data' WHERE id = 'event:bad-data'",
    ).run();
    database.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = '2026-01-03'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(database, credentialsKey);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:bad-data")).toHaveLength(0);
  });

  it("does not replay an event older than the age bound", async () => {
    // Unfurling a message from three weeks ago answers nobody, and Slack may
    // refuse it outright.
    const { database, credentialsKey } = await strandedJob("event:ancient");
    database.prepare(
      "UPDATE slack_ingress_jobs SET received_at = '2026-01-01' WHERE id = 'event:ancient'",
    ).run();
    database.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = ?
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run(new Date().toISOString());

    const sent = await sweep(database, credentialsKey);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:ancient")).toHaveLength(0);
  });

  it("re-drives the vocabulary a real authorization failure actually emits", async () => {
    // Closes the loop between `slackIngressErrorCode` and the allowlist: a
    // drift in either would silently disable the whole sweep.
    const { database } = await strandedJob("event:vocabulary");
    const emitted = database.prepare(
      "SELECT error_code FROM slack_ingress_jobs WHERE id = 'event:vocabulary'",
    ).get() as { error_code: string };
    expect(__slackAgentTesting.SLACK_AUTHORIZATION_ERROR_CODES).toContain(emitted.error_code);
  });
});

describe("Slack ingress maintenance reaps link challenges", () => {
  const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
  const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

  function seedChallenge(
    database: DatabaseSync,
    tokenHash: string,
    expiresAt: string,
    consumedAt: string | null = null,
  ): void {
    database.prepare(
      `INSERT INTO slack_link_challenges
         (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, consumed_at, created_at)
       VALUES (?, ?, 'T123', 'U456', ?, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(tokenHash, CONNECTION_ID, expiresAt, consumedAt);
  }

  it("reaps a spent challenge a day later, not after the 30-day retention", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const soon = new Date(Date.now() + 600_000).toISOString();
    // A day and an hour past expiry: the row the retention-bound reap kept,
    // and the alarm counted as due, for a month.
    seedChallenge(database, await sha256("expired-long-ago"), hoursAgo(25));
    // An hour past expiry: still inside the grace that lets a late click be
    // refused as expired rather than unknown.
    seedChallenge(database, await sha256("expired-recently"), hoursAgo(1));
    seedChallenge(database, await sha256("consumed-long-ago"), soon, hoursAgo(25));
    seedChallenge(database, await sha256("consumed-recently"), soon, hoursAgo(1));
    seedChallenge(database, await sha256("live"), soon);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).maintainIngress();

    const kept = database.prepare("SELECT token_hash FROM slack_link_challenges").all() as { token_hash: string }[];
    expect(kept.map((row) => row.token_hash).sort()).toEqual([
      await sha256("consumed-recently"),
      await sha256("expired-recently"),
      await sha256("live"),
    ].sort());
  });

  it("stops reporting the slack_ingress target once the spent challenge is reaped", async () => {
    // The alarm counts a challenge as due a day after it is spent — the same
    // horizon the reap removes it at. A reap that leaves the row behind leaves
    // that instant in the past for as long as the row lasts, and the workspace
    // alarm comes back for it as fast as it can: the 2026-08-22 hot loop.
    const database = migratedDatabase();
    // The alarm's draft arm reads the object's links table, which no regional
    // snapshot has ever carried.
    createWorkspaceObjectTable(database, "workspace_workstream_resource_links");
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    seedChallenge(database, await sha256("expired"), "2026-01-01T00:15:00.000Z");
    const env = slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined));
    const ctx: WorkspaceScheduleContext = {
      env,
      workspaceEnv: env,
      workspaceId: WORKSPACE_ID,
      directory: {
        workstreamScheduleTargets: async () => ({ items: [] }),
        plannedAutomationWorkstream: async () => null,
      },
    };
    const slackIngress = (targets: WorkspaceScheduleTarget[]) =>
      targets.filter((target) => target.kind === "maintenance" && target.id === "slack_ingress");

    // A day after expiry, rounded up to the next whole second.
    expect(slackIngress(await workspaceScheduleTargets(ctx)))
      .toEqual([{ kind: "maintenance", id: "slack_ingress", dueAt: "2026-01-02T00:15:01Z" }]);

    await runWorkspaceScheduleTarget(
      ctx,
      { kind: "maintenance", id: "slack_ingress", dueAt: "2026-01-02T00:15:01Z" },
      new Date(),
    );

    expect(slackIngress(await workspaceScheduleTargets(ctx))).toEqual([]);
  });
});

describe("Slack ingress jobs given up on", () => {
  // Not credential-shaped: Gitleaks' Slack token rules want digit groups.
  const OPS_BOT_TOKEN = "xoxb-ops-test";
  const OPS_CHANNEL_ID = "C0OPSTEST";
  const OPS_SECRETS = { OPS_SLACK_BOT_TOKEN: OPS_BOT_TOKEN, OPS_SLACK_CHANNEL_ID: OPS_CHANNEL_ID };

  /**
   * Stub `fetch` so the operator notifier's posts are captured and everything
   * else falls through. The product code posts to `chat.postMessage` too; the
   * operator post is the one carrying the operator app's token.
   */
  function captureOpsPosts(
    fallback: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ): string[] {
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${OPS_BOT_TOKEN}`) {
        const body = JSON.parse(String(init?.body)) as { channel: string; text: string };
        expect(body.channel).toBe(OPS_CHANNEL_ID);
        posted.push(body.text);
        return new Response(JSON.stringify({ ok: true }));
      }
      return fallback(input, init);
    }));
    return posted;
  }

  it("posts one ops notification when a job reaches the attempt ceiling", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:exhausted", appMention("EvExhausted"));
    const posted = captureOpsPosts(slackTaskApiFetcher(database, { ok: true }).fetcher);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("event:exhausted"))
      .rejects.toThrow(/has not granted slack\.agent/iu);

    expect(database.prepare(
      "SELECT attempt_count FROM slack_ingress_jobs WHERE id = 'event:exhausted'",
    ).get()).toEqual({ attempt_count: 20 });
    // The row first, then the notice.
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_ingress_job_exhausted",
      job_id: "event:exhausted",
      code: "unsupported_capability",
    }));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("`slack_ingress_job_exhausted`");
    expect(posted[0]).toContain("• job_id: event:exhausted");
    expect(posted[0]).toContain("• code: unsupported_capability");
    expect(posted[0]).toContain("• workspace_id: 22222222-2222-4222-8222-222222222222");

    // The Queue redelivers a message whose processing threw. A job at the
    // ceiling is no longer claimable, so the redelivery is acknowledged
    // without running, pinning, or reporting it again.
    await expect(new SlackAgentService(env).processQueuedIngress("event:exhausted")).resolves.toBeUndefined();

    expect(database.prepare(
      "SELECT status, attempt_count FROM slack_ingress_jobs WHERE id = 'event:exhausted'",
    ).get()).toEqual({ status: "failed", attempt_count: 20 });
    expect(posted).toHaveLength(1);
  });

  it("reports one installation failing the same way as one episode", async () => {
    // A broken installation fails every event it receives identically. The
    // first exhausted job is the notice; the rest within the hour are rows.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:first", appMention("EvFirst"));
    insertSlackEventJob(database, "event:second", appMention("EvSecond"));
    const posted = captureOpsPosts(slackTaskApiFetcher(database, { ok: true }).fetcher);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("event:first")).rejects.toThrow();
    await expect(new SlackAgentService(env).processQueuedIngress("event:second")).rejects.toThrow();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("• job_id: event:first");
    expect(failure.mock.calls.map((call) => (call[0] as { job_id?: string }).job_id).filter(Boolean))
      .toEqual(["event:first", "event:second"]);
  });

  it("claims a job one attempt short of the ceiling, and refuses it past it", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:nineteen", appMention("EvNineteen"));
    database.prepare("UPDATE slack_ingress_jobs SET status = 'failed', attempt_count = 19 WHERE id = 'event:nineteen'").run();
    const posted = captureOpsPosts(slackTaskApiFetcher(database, { ok: true }).fetcher);
    const env = slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("event:nineteen")).rejects.toThrow();

    expect(database.prepare("SELECT attempt_count FROM slack_ingress_jobs WHERE id = 'event:nineteen'").get())
      .toEqual({ attempt_count: 20 });
    expect(posted).toHaveLength(1);
  });

  it("logs the standing count of exhausted jobs once per pass, not once per job", async () => {
    // One error row per job per pass is what buried the 2026-08-22 incident
    // under fifty thousand lines an hour.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    for (const id of ["event:dead-1", "event:dead-2", "event:dead-3"]) {
      insertSlackEventJob(database, id, appMention(id));
      // Failed today: the pass keeps an exhausted job for 30 days, and one
      // older than that is reaped before it is counted.
      database.prepare(
        `UPDATE slack_ingress_jobs SET status = 'failed', attempt_count = 20,
           error_code = 'session_revoked', updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), id);
    }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).maintainIngress();

    const summaries = warning.mock.calls.map((call) => call[0] as { event?: string; count?: number; job_ids?: string[]; error_codes?: string[] })
      .filter((entry) => entry.event === "slack_ingress_exhausted_jobs");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ count: 3, error_codes: ["session_revoked"] });
    expect(summaries[0]!.job_ids).toHaveLength(3);
    expect(failure.mock.calls.map((call) => (call[0] as { event?: string }).event))
      .not.toContain("slack_ingress_retry_budget_exhausted");
  });

  it("stays quiet for a failure the queue will retry", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:expired", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvExpired",
      event: { type: "channel_created", channel: { id: "CNEW", name: "new-channel" } },
    });
    const posted = captureOpsPosts(async () => new Response(JSON.stringify({
      ok: false,
      error: "token_expired",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const env = slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("event:expired"))
      .rejects.toMatchObject({ message: "token_expired" });

    expect(database.prepare(
      "SELECT attempt_count FROM slack_ingress_jobs WHERE id = 'event:expired'",
    ).get()).toEqual({ attempt_count: 1 });
    expect(posted).toEqual([]);
  });
});

function insertSlackEventJob(database: DatabaseSync, id: string, payload: unknown): void {
  database.prepare(
    `INSERT INTO slack_ingress_jobs
     (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
      status, attempt_count, received_at, updated_at)
     VALUES (?, '22222222-2222-4222-8222-222222222222',
             '11111111-1111-4111-8111-111111111111', 'T123', 'hash', 'event', ?,
             'queued', 0, '2026-01-01', '2026-01-01')`,
  ).run(id, JSON.stringify(payload));
}

function seedSlackActivitySubscription(database: DatabaseSync, eventType: string): void {
  database.prepare(
    `INSERT INTO automation_templates
       (id, workspace_id, owner_user_id, name, description, sharing_state,
        latest_version_number, created_at, updated_at)
     VALUES ('template-slack-activity', '22222222-2222-4222-8222-222222222222',
             'user-owner', 'Slack activity', 'Test Slack activity', 'workspace',
             1, '2026-01-01', '2026-01-01')`,
  ).run();
  database.prepare(
    `INSERT INTO automation_template_versions
       (id, template_id, version_number, instructions, trigger_definitions_json,
        required_capabilities_json, expected_outputs_json, default_behavior_json,
        created_by_user_id, created_at)
     VALUES ('version-slack-activity', 'template-slack-activity', 1, 'Handle Slack activity', ?,
             '[]', '[]', '{}', 'user-owner', '2026-01-01')`,
  ).run(JSON.stringify([{
    type: "connector_activity",
    connectorType: "slack",
    sourceBindingKey: "slack_source",
    suggestedSourcePluginId: "plugin_slack_workspace",
    eventTypes: [eventType],
    deterministicFilters: {},
  }]));
  database.prepare(
    `INSERT INTO automation_subscriptions
       (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
        execution_principal_json, connector_bindings_json, activity_trigger_bindings_json,
        overrides_json, status, created_at, updated_at)
     VALUES ('subscription-slack-activity', '22222222-2222-4222-8222-222222222222',
             'template-slack-activity', 'version-slack-activity', 'workspace', NULL,
             '{}', ?, ?, '{}', 'active', '2026-01-01', '2026-01-01')`,
  ).run(
    JSON.stringify({ plugin_slack_workspace: "11111111-1111-4111-8111-111111111111" }),
    JSON.stringify({ slack_source: "plugin_slack_workspace" }),
  );
}

function appMention(
  eventId: string,
  overrides: { threadTs?: string; ts?: string } = {},
): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A1",
    event_id: eventId,
    authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
    event: {
      type: "app_mention",
      user: "U456",
      channel: "C123",
      channel_type: "channel",
      ...(overrides.threadTs ? { thread_ts: overrides.threadTs } : {}),
      ts: overrides.ts ?? "1.0",
      text: "<@UBOT> investigate this",
    },
  };
}

function slackTaskApiFetcher(
  database: DatabaseSync,
  reactionResponse: Record<string, unknown>,
): { fetcher: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>; methods: string[] } {
  const methods: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = url.pathname.split("/").at(-1)!;
    methods.push(method);
    if (method === "conversations.info") return new Response(JSON.stringify({
      ok: true,
      channel: { id: "C123", is_private: false, is_im: false, is_mpim: false },
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "users.info") return new Response(JSON.stringify({
      ok: true,
      user: {
        id: "U456",
        team_id: "T123",
        deleted: false,
        is_bot: false,
        profile: { display_name: "Taylor", email: "taylor@example.com" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "conversations.history") return new Response(JSON.stringify({
      ok: true,
      messages: [],
      has_more: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "reactions.add") {
      expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123",
        name: "eyes",
        timestamp: "1.0",
      });
      return new Response(JSON.stringify(reactionResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "assistant.threads.setStatus" || method === "assistant.threads.setTitle") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "chat.startStream") return new Response(JSON.stringify({
      ok: true,
      channel: "C123",
      ts: "2.0",
    }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected Slack request ${url}`);
  });
  return { fetcher, methods };
}

function slackMembershipEnvironment(
  database: DatabaseSync,
  credentialsKey: string,
  send: (body: unknown) => Promise<void>,
  objectStores?: Map<string, DatabaseSync>,
  overrides: Partial<Env> = {},
): Env {
  return { ...createTestEnv({
    DB: sqliteD1(database),
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ send }),
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: credentialsKey,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    OPENROUTER_PRIMARY_MODEL: "test-model",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
    WORKSTREAM_EMAIL_ADDRESS_KEY: "test-workstream-email-address-key",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, objectStores ? { objectStores } : {}),
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  }), ...overrides };
}


function migratedDatabase(): DatabaseSync {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  // The retired pre-cutover arms are gone: Slack ingress serves work streams
  // through the Durable-Object authority, so every fixture opens it first.
  openWorkstreamAuthorityForTest(database);
  return database;
}
