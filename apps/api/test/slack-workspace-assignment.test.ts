import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Env } from "../src/env";
import { encryptString, sha256 } from "../src/lib/crypto";
import { __slackAgentTesting, SlackAgentService } from "../src/services/slack-agent-service";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import { ApiError } from "../src/lib/api-error";
import {
  runWorkspaceScheduleTarget,
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
  type WorkspaceScheduleTarget,
} from "../src/services/workspace-schedule-execution";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  createTestWorkspaceDO,
  SLACK_WORKSPACE_OBJECT_METHODS,
  workspaceObjectRpcs,
} from "./helpers/workspace-object-rpcs";
import { spaceCreationWorkspaceRpcs } from "./helpers/space-creation-rpcs";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import {
  openWorkstreamAuthorityForTest,
  seedCanonicalConversationTurn,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamContract,
  testWorkstreamObjectStore,
  workstreamObjectAll,
  workstreamObjectGet,
  applyWorkstreamObjectRootFields,
  seedWorkstreamObjectParticipant,
  workstreamObjectParticipantRows,
  workstreamObjectRootRow,
} from "./helpers/durable-authority";

const databases: DatabaseSync[] = [];

/**
 * The parent's half of a create.
 *
 * A work stream created from Slack reserves its main conversation on the parent
 * the Organization object hosts before the child is initialized, then flushes its provisional
 * directory effects alongside initialization. Nothing in this file asserts on
 * those parent operations, but a create that cannot make them never reaches
 * the object.
 */
function parentCreationRpcs() {
  return {
    reserveChild: vi.fn(async (input: { authorityGeneration: number }) => ({
      reserved: true as const,
      authorityGeneration: input.authorityGeneration,
    })),
    flushProvisionalDirectory: vi.fn(async () => undefined),
  };
}

/**
 * Open a fixture work stream's own object database and mirror its D1 product
 * row into it. Creator and participant writes route to this store since the
 * cutover — the D1 `workstreams` row is only the regional directory copy.
 */
function seedWorkstreamObject(
  objectStores: Map<string, DatabaseSync>,
  ids: { workstreamId: string; workspaceId: string },
  row: { title: string; objective: string; createdByUserId: string | null; exactState: string },
): DatabaseSync {
  const store = testWorkstreamObjectStore();
  databases.push(store);
  seedWorkstreamObjectRoot(store, {
    ...ids,
    title: row.title,
    description: row.objective,
    originType: "ad_hoc",
    createdByUserId: row.createdByUserId,
    exactState: row.exactState,
  });
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
    // A real WorkspaceDO, so the seat this assignment performs and the row the
    // test reads back are one store. `slack_agent_sessions` is the object's
    // table since the cutover; asserting on the regional fixture would assert
    // on a database the write never reaches.
    const { instance: workspaceObject, objectDatabase } = createTestWorkspaceDO({
      workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524",
      regionalDatabase: database,
      register: (created) => { databases.push(created); },
    });
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
    `);
    // The sessions live in the object, not in the regional fixture the
    // facade used to answer from. The connection comes with them because
    // they reference it — the object enforces that foreign key, which the
    // regional fixture never had to.
    objectDatabase.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
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
      { title: "Investigate", objective: "Investigate", createdByUserId: null, exactState: "completed" },
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
    const admitAudience = vi.fn(async () => ({ status: "ready" as const }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          ...workspaceObjectRpcs(workspaceObject, SLACK_WORKSPACE_OBJECT_METHODS),
          ...spaceCreationWorkspaceRpcs(),
          admitConnectorParticipants: admitAudience,
        },
      }),
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

    expect(objectDatabase.prepare(
      `SELECT assigned_user_id, assignment_method, execution_scope, linked_user_id
       FROM slack_agent_sessions WHERE id = 'session-ownerless'`,
    ).get()).toEqual({
      assigned_user_id: "a352221e-2577-4ad0-8889-5b24421f63fb",
      assignment_method: "verified_email",
      execution_scope: "workspace",
      linked_user_id: null,
    });
    expect(admitAudience).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524",
      parentId: "7a000000-0000-4000-8000-000000000001",
      userIds: ["a352221e-2577-4ad0-8889-5b24421f63fb"],
    }));
    // Attribution is local. Seating is delegated to canonical admission,
    // whose grants/projections are covered by the real-workerd connector lane.
    expect(workstreamObjectParticipantRows(objectStore, "user_id, participation_reason")).toEqual([]);
    expect(workstreamObjectRootRow(objectStore, "created_by_user_id")).toEqual({ created_by_user_id: "a352221e-2577-4ad0-8889-5b24421f63fb" });
  });

  it("keeps an existing creator when a later Slack assignment resolves the same session", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    // A real WorkspaceDO, so the seat this assignment performs and the row the
    // test reads back are one store. `slack_agent_sessions` is the object's
    // table since the cutover; asserting on the regional fixture would assert
    // on a database the write never reaches.
    const { instance: workspaceObject, objectDatabase } = createTestWorkspaceDO({
      workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524",
      regionalDatabase: database,
      register: (created) => { databases.push(created); },
    });
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
    `);
    // The sessions live in the object, not in the regional fixture the
    // facade used to answer from. The connection comes with them because
    // they reference it — the object enforces that foreign key, which the
    // regional fixture never had to.
    objectDatabase.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
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
      { title: "Investigate", objective: "Investigate", createdByUserId: "user-owner", exactState: "completed" },
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
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          ...workspaceObjectRpcs(workspaceObject, SLACK_WORKSPACE_OBJECT_METHODS),
          ...spaceCreationWorkspaceRpcs(),
        },
      }),
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

    expect(workstreamObjectRootRow(objectStore, "created_by_user_id")).toEqual({ created_by_user_id: "user-owner" });
  });

  it("seats the connections behind a failed one instead of abandoning the loop", async () => {
    // A workspace can carry more than one workspace-scoped Slack installation:
    // `connector_connections_active_model_plugin_id_uq` is unique on
    // `(workspace_id, model_plugin_id)`, and `allocateModelPluginId` suffixes
    // (`plugin_slack_workspace_2`) rather than refusing, which is why the two
    // rows here differ in that column and only in that column. Seating is a
    // WorkspaceDO write that can fail transiently. When it
    // does, only that connection is skipped: letting the throw out of the loop
    // would silently leave every later installation unseated, which is the
    // regression that arrives the moment the seating call shares the Slack
    // lookup's `try` block or nothing at all.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance: workspaceObject, objectDatabase } = createTestWorkspaceDO({
      workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524",
      regionalDatabase: database,
      register: (created) => { databases.push(created); },
    });
    const failing = await encryptString(
      JSON.stringify({ botAccessToken: "xoxb-a" }), credentialsKey, "connection-a",
    );
    const healthy = await encryptString(
      JSON.stringify({ botAccessToken: "xoxb-b" }), credentialsKey, "connection-b",
    );
    const connections = `
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES
        ('connection-a', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T1',
         'Slack A', '${failing.ciphertext}', '${failing.iv}', 1,
         '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
         'plugin_slack_workspace'),
        ('connection-b', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T2',
         'Slack B', '${healthy.ciphertext}', '${healthy.iv}', 1,
         '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
         'plugin_slack_workspace_2');
    `;
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
      ${connections}
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('7a000000-0000-4000-8000-000000000009', '3f88f9ca-d7b3-4714-828e-b22187914524', 'Later', 'Later',
              'ad_hoc', NULL, 'completed', 2, '2026-01-01', '2026-01-01', '2026-01-01');
    `);
    // Only the second installation owns a session, so the count this returns is
    // exactly the evidence that the loop reached it.
    objectDatabase.exec(`
      ${connections}
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-later', '3f88f9ca-d7b3-4714-828e-b22187914524', 'connection-b', NULL, 'workspace',
              'T2', 'U456', 'C123', '1.0', 'event:later', '7a000000-0000-4000-8000-000000000009',
              'app_mention', 'public', '{}', '2026-01-01', '2026-01-01');
    `);
    const objectStores = new Map<string, DatabaseSync>();
    seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-000000000009", workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524" },
      { title: "Later", objective: "Later", createdByUserId: null, exactState: "completed" },
    );
    // Each installation is its own Slack team, so the lookup answers with the
    // team belonging to the bot token it was called with — `validSlackHuman`
    // rejects a member from another team, and a single-team stub would make
    // the second connection look like a mismatch rather than a seating.
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = String(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U456",
          team_id: authorization.includes("xoxb-b") ? "T2" : "T1",
          deleted: false,
          is_bot: false,
          profile: { email: "taylor@example.com" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const rpcs = workspaceObjectRpcs(workspaceObject, SLACK_WORKSPACE_OBJECT_METHODS);
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          ...rpcs,
          // The object refusing one installation's write, the way an overloaded
          // object would. Everything else stays the real method.
          assignSlackSessions: async (input: { connectionId: string }) => {
            if (input.connectionId === "connection-a") throw new Error("workspace_object_overloaded");
            return (rpcs.assignSlackSessions as (request: unknown) => unknown)(input);
          },
        },
      }),
      AVALON_REGION: "global",
      CONNECTOR_CREDENTIALS_KEY: credentialsKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing",
    });

    // One, not zero and not a throw: `connection-a` was skipped, `connection-b`
    // was still seated.
    await expect(new SlackAgentService(env).assignWorkspaceWorkstreamsForMember(
      "3f88f9ca-d7b3-4714-828e-b22187914524",
      "a352221e-2577-4ad0-8889-5b24421f63fb",
      "taylor@example.com",
    )).resolves.toBe(1);

    expect(objectDatabase.prepare(
      `SELECT assigned_user_id FROM slack_agent_sessions WHERE id = 'session-later'`,
    ).get()).toEqual({ assigned_user_id: "a352221e-2577-4ad0-8889-5b24421f63fb" });
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
    )).resolves.toEqual({ elicitation: null });

    expect(workstreamObjectAll(
      objectStore,
      `SELECT elicitation_id AS id, status, answer_json
         FROM elicitation_requests ORDER BY created_at`,
    )).toEqual([
      { id: "elicitation-a", status: "pending", answer_json: null },
      { id: "elicitation-b", status: "pending", answer_json: null },
    ]);
  });

  it("answers the oldest open question for an actor Avalon has no account for", async () => {
    const database = migratedDatabase();
    const objectStores = new Map<string, DatabaseSync>();
    const objectStore = testWorkstreamObjectStore();
    databases.push(objectStore);
    seedWorkstreamObjectRoot(objectStore, {
      workstreamId: "7a000000-0000-4000-8000-000000000005",
      workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524",
    });
    objectStores.set("7a000000-0000-4000-8000-000000000005", objectStore);
    seedElicitationRetry(database, objectStore, "system", null, null);
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
    });
    const actor = {
      provider: "slack" as const,
      providerAccountId: "T123",
      providerUserId: "U456",
      displayName: "Taylor",
      avatarUrl: null,
    };

    const answered = await new SlackWorkspaceWorkstreamService(
      env,
      asWorkspaceId("3f88f9ca-d7b3-4714-828e-b22187914524"),
    ).answerOpenElicitation("7a000000-0000-4000-8000-000000000005", {
      actor,
      text: "staging",
      clientMessageId: "event:answer",
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
    });

    // `elicitation-b` is still open, so the work stream is still waiting on
    // somebody and no run is launched to resume it.
    expect(answered?.elicitation).toMatchObject({ id: "elicitation-a", status: "answered", answer: "staging" });
    expect(workstreamObjectAll(
      objectStore,
      `SELECT elicitation_id AS id, status, answer_json
         FROM elicitation_requests ORDER BY created_at`,
    )).toEqual([
      { id: "elicitation-a", status: "answered", answer_json: JSON.stringify("staging") },
      { id: "elicitation-b", status: "pending", answer_json: null },
    ]);
    // The answer is in the transcript as the external actor who gave it, and
    // it took the next sequence number rather than the one the seed's own part
    // already holds.
    expect(workstreamObjectGet(
      objectStore,
      `SELECT author_type, message_type, sequence_number, external_actor_json
         FROM canonical_conversation_turn_details WHERE client_message_id = 'event:answer'`,
    )).toEqual({
      author_type: "external",
      message_type: "elicitation",
      sequence_number: 2,
      external_actor_json: JSON.stringify(actor),
    });
  });

  it("admits the final external answer to the loop without publishing or minting a run", async () => {
    const database = migratedDatabase();
    const objectStores = new Map<string, DatabaseSync>();
    const objectStore = testWorkstreamObjectStore();
    databases.push(objectStore);
    const workstreamId = "7a000000-0000-4000-8000-000000000005";
    const workspaceId = "3f88f9ca-d7b3-4714-828e-b22187914524";
    seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId });
    objectStores.set(workstreamId, objectStore);
    seedElicitationRetry(database, objectStore, "system", null, null);
    objectStore.prepare(
      `UPDATE elicitation_requests
          SET status = 'answered', answer_json = '"already done"', answered_at = created_at
        WHERE elicitation_id = 'elicitation-b'`,
    ).run();
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
    });
    const before = workstreamObjectRootRow(
      objectStore,
      "next_sequence_number, next_attention_ordinal",
    );
    const actor = {
      provider: "slack" as const,
      providerAccountId: "T123",
      providerUserId: "U456",
      displayName: "Taylor",
      avatarUrl: null,
    };

    const answered = await new SlackWorkspaceWorkstreamService(
      env,
      asWorkspaceId(workspaceId),
    ).answerOpenElicitation(workstreamId, {
      actor,
      text: "ship it",
      clientMessageId: "event:final-answer",
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
    });

    expect(answered).toMatchObject({
      elicitation: { id: "elicitation-a", status: "answered", answer: "ship it" },
    });
    expect(workstreamObjectGet(
      objectStore,
      `SELECT actor, external_actor_json, message_type
         FROM pending_loop_inputs WHERE client_message_id = 'event:final-answer'`,
    )).toEqual({
      actor: "external",
      external_actor_json: JSON.stringify(actor),
      message_type: "elicitation",
    });
    expect(workstreamObjectGet(
      objectStore,
      `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details
        WHERE client_message_id = 'event:final-answer'`,
    )).toEqual({ count: 0 });
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM runs"))
      .toEqual({ count: 2 });
    expect(workstreamObjectRootRow(
      objectStore,
      "next_sequence_number, next_attention_ordinal",
    )).toEqual(before);
  });

  it("reports pending delivery without execution claims and audits a replay once", async () => {
    const database = migratedDatabase();
    const objectStores = new Map<string, DatabaseSync>();
    const objectStore = testWorkstreamObjectStore();
    databases.push(objectStore);
    const workstreamId = "7a000000-0000-4000-8000-000000000005";
    const workspaceId = "3f88f9ca-d7b3-4714-828e-b22187914524";
    seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId });
    objectStores.set(workstreamId, objectStore);
    seedElicitationRetry(database, objectStore, "system", null, null);
    const service = new SlackWorkspaceWorkstreamService(
      createTestEnv({
        DB: sqliteD1(database),
        SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
        AVALON_REGION: "global",
      }),
      asWorkspaceId(workspaceId),
    );
    const input = {
      actor: {
        provider: "slack" as const,
        providerAccountId: "T123",
        providerUserId: "U456",
        displayName: "Taylor",
        avatarUrl: null,
      },
      text: "Please inspect the deploy",
      clientMessageId: "event:message-replay",
      slackOrigin: {
        teamId: "T123",
        channelId: "C123",
        channelName: "general",
        threadTs: "123.456",
        invocationType: "app_mention" as const,
        channelType: "public" as const,
        matchedAvalonUserId: null,
        nearbyMessagesStatus: "available" as const,
        nearbyMessages: [],
        attachments: [],
      },
    };

    const first = await service.createMessage(workstreamId, input);
    const replay = await service.createMessage(workstreamId, input);

    expect(first).toEqual({
      message: {
        id: expect.any(String),
        clientMessageId: "event:message-replay",
      },
      deliveryState: "pending",
    });
    expect(replay).toEqual(first);
    await vi.waitFor(() => expect(database.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'slack.workspace_workstream.message_created'
          AND target_id = ?`,
    ).get(first.message.id)).toEqual({ count: 1 }));
  });

  it("lets an explicit account link correct a creator its own email guess produced", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    // A real WorkspaceDO, serving both the typed session methods and
    // `executeRuntimeSql`, so the seat this link performs and the rows it reads
    // are one store. Seating is a typed method now; leaving the sessions in the
    // regional fixture would assert against a database the write never reaches.
    const { instance: workspaceObject, objectDatabase } = createTestWorkspaceDO({
      workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524",
      regionalDatabase: database,
      register: (created) => { databases.push(created); },
    });
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
      INSERT INTO slack_installation_routes
        (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
      VALUES ('T123', 'global', '3f88f9ca-d7b3-4714-828e-b22187914524',
              'connection-slack', 'active', '2026-01-01', '2026-01-01');
    `);
    // `slack_agent_sessions` is WorkspaceDO's table: the rows live in the
    // object, not in the regional fixture the facade used to answer from. The
    // connection comes with them because the sessions reference it — the object
    // enforces that foreign key, which the regional fixture never had to.
    objectDatabase.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', '3f88f9ca-d7b3-4714-828e-b22187914524', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
      INSERT INTO slack_link_challenges
        (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, created_at)
      VALUES ('${await sha256("link-token")}', 'connection-slack', 'T123', 'U456',
              '2099-01-01T00:00:00.000Z', '2026-01-01');
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
    `);
    const objectStores = new Map<string, DatabaseSync>();
    const guessedStore = seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-000000000003", workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524" },
      { title: "Guessed", objective: "Slack task", createdByUserId: "user-jordan", exactState: "completed" },
    );
    seedWorkstreamObjectParticipant(guessedStore, {
      userId: "user-jordan",
      participationReason: "creator",
    });
    const elsewhereStore = seedWorkstreamObject(
      objectStores,
      { workstreamId: "7a000000-0000-4000-8000-000000000004", workspaceId: "3f88f9ca-d7b3-4714-828e-b22187914524" },
      { title: "Elsewhere", objective: "Slack task", createdByUserId: "user-owner", exactState: "completed" },
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
        extra: {
          ...workspaceObjectRpcs(workspaceObject, SLACK_WORKSPACE_OBJECT_METHODS),
          ...spaceCreationWorkspaceRpcs(),
          recentWorkstreamDirectory: vi.fn(async () => ({ items: [] })),
          listAutomationDirectory: vi.fn(async () => ({ items: [] })),
        },
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
    expect(workstreamObjectRootRow(guessedStore, "created_by_user_id")).toEqual({ created_by_user_id: "a352221e-2577-4ad0-8889-5b24421f63fb" });
    expect(workstreamObjectParticipantRows(guessedStore, "user_id, participation_reason"))
      .toEqual([
        { user_id: "user-jordan", participation_reason: "creator" },
      ]);
    // A creator recorded by anything other than that guess still stands.
    expect(workstreamObjectRootRow(elsewhereStore, "created_by_user_id")).toEqual({ created_by_user_id: "user-owner" });
  });
});

async function linkedSlackMemberFixture(
  database: DatabaseSync,
  credentialsKey: string,
): Promise<{ instance: WorkspaceDO; objectDatabase: DatabaseSync }> {
  const fixture = await slackInstallationFixture(database, credentialsKey);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('019fc4e0-4444-7000-8000-000000000044', 'google-linked',
            'linked@example.com', 'Linked User',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('22222222-2222-4222-8222-222222222222',
            '019fc4e0-4444-7000-8000-000000000044', 'member', 'active', '2026-01-01');
  `);
  fixture.objectDatabase.exec(`
    INSERT INTO slack_user_links
      (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
       status, created_at, updated_at)
    VALUES ('33333333-3333-4333-8333-333333333333',
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            '019fc4e0-4444-7000-8000-000000000044', 'T123', 'U456',
            'active', '2026-01-01', '2026-01-01');
  `);
  return fixture;
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
    instance: WorkspaceDO,
    credentialsKey: string,
    substreamAgents: DurableObjectNamespace,
  ): Env {
    return createTestEnv({
      ...slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
      SUBSTREAM_AGENTS: substreamAgents,
      // The Organization object hosts the Channel's parent, so the parent's
      // creation RPCs answer on the same stub as the workspace object's own.
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          ...workspaceObjectRpcs(instance, SLACK_WORKSPACE_OBJECT_METHODS),
          ...spaceCreationWorkspaceRpcs(),
          ...parentCreationRpcs(),
          admitConnectorParticipants: async () => ({ status: "ready" }),
          hasActiveExternalEventRegistration: vi.fn(async () => false),
        },
      }),
    });
  }

  it("closes a legacy empty stream and posts only the complete saved outcome", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    objectDatabase.exec(`
      INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash,
         revision, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-0000000000a9', 'General', 'workspace', 1, 1,
              'fixture', 1, 0, 0);
      INSERT INTO space_channel_memberships
        (space_id, workstream_id, state, generation, joined_at, updated_at)
      VALUES ('00000000-0000-7000-8000-0000000000a9',
              '7a000000-0000-4000-8000-0000000000ab', 'active', 1, 0, 0);
    `);
    objectDatabase.exec(`
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         slack_stream_ts, opening_client_message_id, workstream_id, invocation_kind,
         channel_type, context_json, created_at, updated_at)
      VALUES ('session-saved-outcome', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', '2.0', 'event:saved-outcome',
              '7a000000-0000-4000-8000-0000000000ab', 'app_mention', 'public',
              '{}', '2026-01-01', '2026-01-01');
    `);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === "chat.stopStream") {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "2.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "assistant.threads.setStatus") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "chat.postMessage") {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "3.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const clearLegacyStream = vi.spyOn(instance, "setSlackSessionStream");
    const service = new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { PUBLIC_WEB_BASE_URL: "https://rallywith.ai" },
    ));
    await service.deliverWorkstreamOutcome(
      "22222222-2222-4222-8222-222222222222",
      "7a000000-0000-4000-8000-0000000000ab",
      "The saved final answer",
      "run-saved:completed",
      "completed",
    );

    expect(calls.map((call) => call.method)).toEqual([
      "chat.stopStream",
      "chat.postMessage",
      "chat.postMessage",
      "assistant.threads.setStatus",
    ]);
    expect(calls.some((call) => call.method === "chat.startStream" || call.method === "chat.appendStream"))
      .toBe(false);
    expect(calls[1]?.body).toMatchObject({
      channel: "C123",
      thread_ts: "1.0",
      text: "The saved final answer",
    });
    expect(objectDatabase.prepare(
      "SELECT slack_stream_ts, last_delivery_key FROM slack_agent_sessions WHERE id = 'session-saved-outcome'",
    ).get()).toEqual({ slack_stream_ts: null, last_delivery_key: "run-saved:completed" });
    expect(clearLegacyStream).toHaveBeenCalledTimes(1);

    objectDatabase.exec(`
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-no-saved-turn', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', NULL, 'workspace',
              'T123', 'U456', 'C123', '4.0', 'event:no-saved-turn',
              '7a000000-0000-4000-8000-0000000000ac', 'app_mention', 'public',
              '{}', '2026-01-01', '2026-01-01');
    `);
    calls.length = 0;

    await service.deliverWorkstreamOutcome(
      "22222222-2222-4222-8222-222222222222",
      "7a000000-0000-4000-8000-0000000000ac",
      null,
      "run-unsaved:failed",
      "failed",
    );

    expect(calls.map((call) => call.method)).toEqual(["assistant.threads.setStatus"]);
    expect(objectDatabase.prepare(
      "SELECT last_delivery_key FROM slack_agent_sessions WHERE id = 'session-no-saved-turn'",
    ).get()).toEqual({ last_delivery_key: "run-unsaved:failed" });
    expect(clearLegacyStream).toHaveBeenCalledTimes(1);
  });

  it("posts a non-threadable room's outcome at the top level, every chunk of it", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    objectDatabase.exec(`
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-top-level', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:top-level',
              '7a000000-0000-4000-8000-0000000000ad', 'app_mention', 'public',
              '{"source":{"threadable":false}}', '2026-01-01', '2026-01-01');
    `);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let ts = 3;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (method === "chat.postMessage") {
        ts += 1;
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: `${ts}.0` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), undefined,
      { PUBLIC_WEB_BASE_URL: "https://rallywith.ai" },
    )).deliverWorkstreamOutcome(
      "22222222-2222-4222-8222-222222222222",
      "7a000000-0000-4000-8000-0000000000ad",
      // Past Slack's 12,000-character message limit, so it is sent in chunks.
      `${"word ".repeat(2_600)}end`,
      "run-top-level:completed",
      "completed",
    );

    // Two result chunks and the controls, none of them threaded.
    expect(calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.postMessage", "chat.postMessage"]);
    expect(calls.filter((call) => "thread_ts" in call.body)).toEqual([]);
    expect(objectDatabase.prepare(
      "SELECT last_delivery_key FROM slack_agent_sessions WHERE id = 'session-top-level'",
    ).get()).toEqual({ last_delivery_key: "run-top-level:completed" });
  });

  it("settles the outcome on a follow-up steered into the run, which has no run of its own", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    // The run started at 5.0; a follow-up at 9.0 moved the slot and was steered into it.
    objectDatabase.exec(`
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         reaction_channel_id, reaction_message_ts, reaction_current,
         context_json, created_at, updated_at)
      VALUES ('session-steered', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:steered',
              '7a000000-0000-4000-8000-0000000000b0', 'app_mention', 'public',
              'C123', '9.0', 'eyes',
              '{}', '2026-01-01', '2026-01-01');
    `);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push({
        method: url.pathname.split("/").at(-1)!,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), undefined,
      { PUBLIC_WEB_BASE_URL: "https://rallywith.ai" },
    )).deliverWorkstreamOutcome(
      "22222222-2222-4222-8222-222222222222",
      "7a000000-0000-4000-8000-0000000000b0",
      null,
      "run-steered:completed",
      "completed",
      {
        reactionAnchor: { channelId: "C123", messageTs: "5.0" },
        absorbedReactionAnchors: [{ channelId: "C123", messageTs: "9.0" }],
      },
    );

    expect(calls.filter((call) => call.method.startsWith("reactions.")).map((call) => ({
      method: call.method,
      timestamp: call.body.timestamp,
      name: call.body.name,
    }))).toEqual([
      { method: "reactions.remove", timestamp: "5.0", name: "eyes" },
      { method: "reactions.add", timestamp: "5.0", name: "white_check_mark" },
      { method: "reactions.remove", timestamp: "9.0", name: "eyes" },
      { method: "reactions.add", timestamp: "9.0", name: "white_check_mark" },
    ]);
    // The slot is 9.0's, and this run answered it, so the outcome is recorded.
    expect(objectDatabase.prepare(
      `SELECT reaction_message_ts, reaction_current FROM slack_agent_sessions
        WHERE id = 'session-steered'`,
    ).get()).toEqual({ reaction_message_ts: "9.0", reaction_current: "white_check_mark" });
  });

  it("sends a needs-input connect prompt to the member who triggered the run, not the thread's opener", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    // U456 opened the thread and is linked; U999, who is not, sent the follow-up.
    objectDatabase.exec(`
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-follow-up-member', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:follow-up-member',
              '7a000000-0000-4000-8000-0000000000af', 'app_mention', 'public',
              '{}', '2026-01-01', '2026-01-01');
    `);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const body = method === "conversations.open"
        ? { ok: true, channel: { id: "D999" } }
        : { ok: true, channel: "C123", ts: "3.0" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), undefined,
      { PUBLIC_WEB_BASE_URL: "https://rallywith.ai" },
    )).deliverWorkstreamOutcome(
      "22222222-2222-4222-8222-222222222222",
      "7a000000-0000-4000-8000-0000000000af",
      "Which region should I deploy to?",
      "run-follow-up:needs_input",
      "needs_input",
      { triggeringSlackUserId: "U999" },
    );

    expect(calls.filter((call) => call.method === "conversations.open").map((call) => call.body))
      .toEqual([{ users: "U999" }]);
    expect(calls.some((call) => call.method === "chat.postMessage" && call.body.channel === "D999"))
      .toBe(true);
  });

  it("settles an earlier run's outcome on its own message after a follow-up moved the slot", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    // A follow-up at 9.0 was admitted while the run that started at 5.0 was
    // live, and moved the slot with the same emoji.
    objectDatabase.exec(`
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         reaction_channel_id, reaction_message_ts, reaction_current,
         context_json, created_at, updated_at)
      VALUES ('session-moved-anchor', '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:moved-anchor',
              '7a000000-0000-4000-8000-0000000000ae', 'app_mention', 'public',
              'C123', '9.0', 'eyes',
              '{}', '2026-01-01', '2026-01-01');
    `);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push({
        method: url.pathname.split("/").at(-1)!,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), undefined,
      { PUBLIC_WEB_BASE_URL: "https://rallywith.ai" },
    )).deliverWorkstreamOutcome(
      "22222222-2222-4222-8222-222222222222",
      "7a000000-0000-4000-8000-0000000000ae",
      null,
      "run-earlier:completed",
      "completed",
      { reactionAnchor: { channelId: "C123", messageTs: "5.0" } },
    );

    expect(calls.filter((call) => call.method.startsWith("reactions.")).map((call) => ({
      method: call.method,
      timestamp: call.body.timestamp,
      name: call.body.name,
    }))).toEqual([
      { method: "reactions.remove", timestamp: "5.0", name: "eyes" },
      { method: "reactions.add", timestamp: "5.0", name: "white_check_mark" },
    ]);
    // The slot still belongs to the follow-up.
    expect(objectDatabase.prepare(
      `SELECT reaction_message_ts, reaction_current FROM slack_agent_sessions
        WHERE id = 'session-moved-anchor'`,
    ).get()).toEqual({ reaction_message_ts: "9.0", reaction_current: "eyes" });
  });

  it("presents the connector principal to the work-stream object, not a login session", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:principal", appMention("EvPrincipal"));
    const { fetcher } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    let initializeAuth: unknown = null;
    const env = deliveryEnv(database, instance, credentialsKey, testSubstreamAgentsBinding(database, {
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
              turnId: crypto.randomUUID(),
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
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:race", appMention("EvRace"));
    const { fetcher } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    const env = deliveryEnv(database, instance, credentialsKey, testSubstreamAgentsBinding(database, {
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
    expect(objectDatabase.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:race'",
    ).get()).toEqual({ status: "failed", attempt_count: 1, error_code: "connector_member_revoked" });
    // One member's refusal says nothing about the installation's grant.
    expect(objectDatabase.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: "healthy" });
  });

  it("carries the connector principal on a reply into an existing thread", async () => {
    // The reply branch builds its own WorkstreamService, separately from the
    // create branch — and the reply is the symptom the incident was reported
    // under.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('7a000000-0000-4000-8000-0000000000aa', '22222222-2222-4222-8222-222222222222',
              'Investigate', 'Investigate', 'ad_hoc', NULL, 'completed', 2,
              '2026-01-01', '2026-01-01', '2026-01-01');
    `);
    objectDatabase.exec(`
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
      { title: "Investigate", objective: "Investigate", createdByUserId: null, exactState: "completed" },
    );
    insertSlackEventJob(objectDatabase, "event:reply", appMention("EvReply", { threadTs: "1.0", ts: "2.0" }));
    const { fetcher } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    const captured: Array<{ operation: string; auth: unknown }> = [];
    const env = deliveryEnv(database, instance, credentialsKey, testSubstreamAgentsBinding(database, {
        objectStores,
        product: {
          create_message: (request) => {
            captured.push(request as { operation: string; auth: unknown });
            return {
              turn: {
                turnId: "019fc4e0-5555-7000-8000-000000000055",
                clientMessageId: "slack:reply",
                createdAt: "2026-01-02T00:00:00.000Z",
              },
              deliveryState: "canonical",
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
  it("completes a public-channel sync queued before joins stopped, without joining anything", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    insertSlackEventJob(objectDatabase, "event:legacy-sync", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "legacy-sync",
      event: { type: "rally_public_channel_sync" },
    });
    const fetcher = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    const send = vi.fn(async () => undefined);

    await new SlackAgentService(slackMembershipEnvironment(database, instance, credentialsKey, send))
      .processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:legacy-sync");

    expect(fetcher).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(objectDatabase.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:legacy-sync'",
    ).get()).toEqual({ status: "completed" });
  });

  it("records a created public channel as activity without joining it", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.prepare(
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
    // Rally joins only where it is invited, or where a Sidekick source names
    // a conversation; a channel merely existing is neither.
    const fetcher = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);

    const activityQueueSend = vi.fn(async () => undefined);
    const hasActiveExternalEventRegistration = vi.fn(async () => ({ active: true }));
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      activityQueueSend,
      undefined,
      {
        WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>(testSubstreamAgentsBinding(database, {
          extra: {
            ...workspaceObjectRpcs(instance, SLACK_WORKSPACE_OBJECT_METHODS),
            hasActiveExternalEventRegistration,
          },
        })),
      },
    )).processQueuedIngress(
      "22222222-2222-4222-8222-222222222222",
      "event:EvChannelCreated",
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(hasActiveExternalEventRegistration).toHaveBeenCalledOnce();
    expect(activityQueueSend).toHaveBeenCalledOnce();
    expect(activityQueueSend).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workspace_connector_event",
      request: expect.objectContaining({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        event: expect.objectContaining({
          connectorType: "slack",
          activity: expect.objectContaining({
            eventType: "slack.channel.created",
            resourceType: "slack_channel",
            providerResourceId: "CNEW",
            title: "Slack channel created in #new-channel",
            rawContentHash: "hash",
            metadata: expect.objectContaining({
              teamId: "T123",
              channelId: "CNEW",
              channelName: "new-channel",
              channelType: "public",
            }),
            visibility: expect.objectContaining({
              workspaceAutomationAllowed: true,
              channelType: "public",
            }),
          }),
        }),
      }),
    }));
    expect(objectDatabase.prepare(
      "SELECT status, payload_json, completed_at FROM slack_ingress_jobs WHERE id = 'event:EvChannelCreated'",
    ).get()).toMatchObject({ status: "completed", payload_json: null });
  });

  it("does not turn Avalon's own reaction events into automation activity", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:own-reaction", {
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
      instance,
      credentialsKey,
      activityQueueSend,
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:own-reaction");

    expect(database.prepare("SELECT COUNT(*) AS count FROM activities").get()).toEqual({ count: 0 });
    expect(activityQueueSend).not.toHaveBeenCalled();
  });

  it("adds eyes before task processing without opening a Slack response stream", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:acknowledge", appMention("EvAcknowledge"));
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
      throw new Error(`Unexpected Slack request ${url}`);
    }));
    const env = createTestEnv({
      ...slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
    });

    await new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:acknowledge");

    expect(methods.indexOf("reactions.add")).toBeGreaterThan(methods.indexOf("users.info"));
    expect(methods.indexOf("reactions.add")).toBeLessThan(methods.indexOf("assistant.threads.setStatus"));
    expect(methods).not.toContain("chat.startStream");
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    expect(objectDatabase.prepare(
      "SELECT status, payload_json FROM slack_ingress_jobs WHERE id = 'event:acknowledge'",
    ).get()).toEqual({ status: "completed", payload_json: null });
  });

  it.each([
    ["too_many_reactions", "healthy"],
    ["missing_scope", "needs_reconnect"],
  ] as const)("continues an admitted task when reactions.add returns %s", async (reactionError, expectedStatus) => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, `event:${reactionError}`, appMention(`Ev${reactionError}`));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: false, error: reactionError });
    vi.stubGlobal("fetch", fetcher);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = createTestEnv({
      ...slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
    });

    await new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", `event:${reactionError}`);

    expect(methods.indexOf("reactions.add")).toBeLessThan(methods.indexOf("assistant.threads.setStatus"));
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_activation_ack_failed",
      reason: reactionError,
    }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    expect(objectDatabase.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: expectedStatus });
    expect(objectDatabase.prepare(
      `SELECT status, payload_json FROM slack_ingress_jobs WHERE id = 'event:${reactionError}'`,
    ).get()).toEqual({ status: "completed", payload_json: null });
  });

  it("uses the installed Slack capability grants for activation", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(objectDatabase, "event:missing-capability", appMention("EvMissingCapability"));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:missing-capability")).rejects.toThrow(/has not granted slack\.agent/iu);

    expect(methods).not.toContain("reactions.add");
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
    expect(objectDatabase.prepare(
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
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('44444444-4444-4444-8444-444444444444', 'google-linked',
              'linked@example.com', 'Linked User', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('22222222-2222-4222-8222-222222222222',
              '44444444-4444-4444-8444-444444444444', 'member', 'active', '2026-01-01');
    `);
    objectDatabase.exec(`
      INSERT INTO slack_user_links
        (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
         status, created_at, updated_at)
      VALUES ('33333333-3333-4333-8333-333333333333',
              '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111',
              '44444444-4444-4444-8444-444444444444', 'T123', 'U456',
              'active', '2026-01-01', '2026-01-01');
    `);
    insertSlackEventJob(objectDatabase, "event:linked", appMention("EvLinked"));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    // A linked member creates through the object creation coordinator. Capture
    // its product boundary: attribution belongs in the object, while regional
    // D1 retains only the identity anchor.
    let initializeInput: Record<string, unknown> | null = null;
    const env = createTestEnv({
      ...slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined)),
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
              turnId: crypto.randomUUID(),
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
      // The Organization object hosts the Channel's parent, so the parent's
      // creation RPCs answer on the same stub as the workspace object's own.
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          ...workspaceObjectRpcs(instance, SLACK_WORKSPACE_OBJECT_METHODS),
          ...spaceCreationWorkspaceRpcs(),
          ...parentCreationRpcs(),
          admitConnectorParticipants: async () => ({ status: "ready" }),
          hasActiveExternalEventRegistration: vi.fn(async () => false),
        },
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
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:invalid", { type: 42 });

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:invalid")).rejects.toBeDefined();

    expect(objectDatabase.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:invalid'",
    ).get()).toMatchObject({ status: "failed", attempt_count: 20 });
  });

  it("retries an access-token expiration without poisoning the Slack connection", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:expired", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvExpired",
      // The bot's own invitation asks Slack what the room is before linking it.
      authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
      event: { type: "member_joined_channel", user: "UBOT", channel: "CNEW", channel_type: "C" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: "token_expired",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:expired")).rejects.toMatchObject({ message: "token_expired" });

    expect(objectDatabase.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:expired'",
    ).get()).toEqual({ status: "failed", attempt_count: 1, error_code: "token_expired" });
    expect(objectDatabase.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: "healthy" });
  });

  it("declines a private room's mention visibly when no one in it is a Rally member", async () => {
    // A private room's Space is personal and needs somebody in it who can open
    // it in Rally. With nobody Rally recognizes, the mention is answered with a
    // routing failure: nothing is created, and nothing lands in General, where
    // the room's content would reach people who are not in it. Legacy policy
    // rows still decide nothing.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.prepare(
      `INSERT INTO slack_agent_policies
       (connection_id, allow_unlinked_workspace_tasks, public_channel_mode, private_channel_mode,
        allow_direct_messages, allow_commands, allow_shortcuts, created_at, updated_at)
       VALUES (?, 0, 'disabled', 'disabled', 0, 0, 0, '2026-01-01', '2026-01-01')`,
    ).run("11111111-1111-4111-8111-111111111111");
    const payload = appMention("EvWideLatitude");
    (payload.event as Record<string, unknown>).channel_type = "group";
    insertSlackEventJob(objectDatabase, "event:wide-latitude", payload);
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("conversations.info")) {
        return json({
          ok: true,
          channel: { id: "C123", name: "private-work", is_private: true, is_im: false, is_mpim: false },
        });
      }
      if (url.pathname.endsWith("conversations.members")) return json({ ok: true, members: ["U456"] });
      if (url.pathname.endsWith("users.info")) {
        return json({
          ok: true,
          user: {
            id: "U456",
            team_id: "T123",
            deleted: false,
            is_bot: false,
            name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "C123", ts: "1.1" });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const objectStores = new Map<string, DatabaseSync>();
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
      objectStores,
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:wide-latitude");

    expect(objectStores.size).toBe(0);
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM slack_agent_sessions").get()).toEqual({ count: 0 });
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM external_conversation_bindings").get())
      .toEqual({ count: 0 });
    expect(posted).toEqual([expect.objectContaining({ channel: "C123", thread_ts: "1.0" })]);
    // The room has no Space yet, and nobody in it is a Rally member: the
    // notice says that, not that a linked Space refused somebody.
    expect(String(posted[0]!.text)).toContain("nobody in this private conversation");
    expect(String(posted[0]!.text)).not.toContain("linked");
    expect(objectDatabase.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:wide-latitude'",
    ).get()).toEqual({ status: "completed" });

    // A retry of the same event (its settlement was lost) posts the notice
    // under the same message identity, which Slack deduplicates.
    objectDatabase.prepare(
      "UPDATE slack_ingress_jobs SET status = 'queued', payload_json = ? WHERE id = 'event:wide-latitude'",
    ).run(JSON.stringify(payload));
    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), objectStores,
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:wide-latitude");
    expect(posted).toHaveLength(2);
    expect(posted[0]!.client_msg_id).toEqual(expect.any(String));
    expect(posted[1]!.client_msg_id).toBe(posted[0]!.client_msg_id);
  });

  it("marks a missing channel-lookup scope for reconnect before unlinked dispatch", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:missing-scope", appMention("EvMissingScope"));
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
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:missing-scope");

    expect(objectDatabase.prepare(
      "SELECT status, error_json FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toMatchObject({ status: "needs_reconnect" });
    expect(objectDatabase.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:missing-scope'",
    ).get()).toEqual({ status: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks for the request again when a legacy retry has no recoverable prompt", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:legacy-retry-missing", {
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
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:legacy-retry-missing");

    expect(postedMessages).toEqual([expect.stringContaining("couldn’t find the original request")]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
    expect(objectDatabase.prepare(
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
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.prepare(
      "UPDATE connector_connections SET status = 'needs_reconnect' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(objectDatabase, "event:unhealthy", appMention("EvUnhealthy"));
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
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const objectStores = new Map<string, DatabaseSync>();
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
      objectStores,
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:unhealthy");

    expect(postedMessages).not.toContainEqual(expect.stringContaining("connection needs attention"));
    // The created work stream's product row lives in its object; the regional
    // row is only the bootstrap identity anchor and keeps its placeholder.
    const [createdId] = [...objectStores.keys()];
    const createdStore = objectStores.get(createdId!)!;
    databases.push(createdStore);
    expect(workstreamObjectRootRow(createdStore, "title, description")).toEqual({
      title: "investigate this",
      description: "investigate this",
    });
    expect(database.prepare(
      "SELECT id, workspace_id, do_identity_anchor FROM workstreams WHERE id = ?",
    ).get(createdId!)).toEqual({
      id: createdId,
      workspace_id: "22222222-2222-4222-8222-222222222222",
      do_identity_anchor: 1,
    });
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM slack_agent_pending_prompts").get())
      .toEqual({ count: 0 });
    expect(threadTitles).toEqual(["investigate this"]);
  });

  it("retries a mention that lost its thread to another event instead of reporting a refusal", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.exec(`
      INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash,
         revision, created_at, updated_at, created_by_user_id)
      VALUES ('00000000-0000-7000-8000-0000000000b3', 'launch', 'workspace', 1, 1,
              'fixture', 1, 0, 0, '019fc4e0-4444-7000-8000-000000000044');
      INSERT INTO external_conversation_bindings
        (installation_id, path_json, target_kind, space_id, state, created_at, updated_at)
      VALUES ('slack:T123', '["C123"]', 'space', '00000000-0000-7000-8000-0000000000b3', 'active',
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);
    insertSlackEventJob(objectDatabase, "event:lost-race", appMention("EvLostRace"));
    // Between this event's resolution and its reservation, another event for
    // the same thread bound it: the reservation refuses the claim.
    vi.spyOn(SlackWorkspaceWorkstreamService.prototype, "create").mockRejectedValue(
      new ApiError(409, "external_binding_bound", "This conversation is already bound to a thread"),
    );
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("conversations.info")) {
        return json({ ok: true, channel: { id: "C123", name: "launch", is_private: false, is_im: false, is_mpim: false } });
      }
      if (url.pathname.endsWith("users.info")) {
        return json({
          ok: true,
          user: {
            id: "U456", team_id: "T123", deleted: false, is_bot: false, name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        });
      }
      if (url.pathname.endsWith("assistant.threads.setStatus")) return json({ ok: true });
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "C123", ts: "1.1" });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const failure = await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), new Map(),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:lost-race").then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ status: 503, code: "external_binding_raced" });
    expect(posted).toEqual([]);
    expect(objectDatabase.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:lost-race'",
    ).get()).not.toEqual({ status: "completed" });
  });

  it("brings a room back when the bot is mentioned there after it was removed", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.exec(`
      INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash,
         revision, created_at, updated_at, created_by_user_id)
      VALUES ('00000000-0000-7000-8000-0000000000b2', 'launch', 'workspace', 1, 1,
              'fixture', 1, 0, 0, '019fc4e0-4444-7000-8000-000000000044');
      INSERT INTO external_conversation_bindings
        (installation_id, path_json, target_kind, space_id, state, suspended_reason, created_at, updated_at)
      VALUES ('slack:T123', '["C123"]', 'space', '00000000-0000-7000-8000-0000000000b2', 'suspended',
              'provider_membership_ended', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);
    insertSlackEventJob(objectDatabase, "event:mentioned-again", appMention("EvMentionedAgain"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.info")) {
        return new Response(JSON.stringify({
          ok: true, channel: { id: "C123", name: "launch", is_private: false, is_im: false, is_mpim: false },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Past the relink, the mention goes on to start work; this test stops there.
      throw new Error("past_relink");
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:mentioned-again").catch(() => undefined);

    // Back, with its Space, without anyone having to re-invite the bot, and
    // without a Rally member to act as: the Space already exists.
    expect(objectDatabase.prepare(
      "SELECT state, suspended_reason, space_id FROM external_conversation_bindings WHERE path_json = '[\"C123\"]'",
    ).get()).toEqual({ state: "active", suspended_reason: null, space_id: "00000000-0000-7000-8000-0000000000b2" });
  });

  it("refuses to open a Channel in a matched Space for a room since shared through Slack Connect", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    // Linked by name into an existing Space, not one derived from the room.
    objectDatabase.exec(`
      INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash,
         revision, created_at, updated_at, created_by_user_id)
      VALUES ('00000000-0000-7000-8000-0000000000b1', 'General', 'workspace', 1, 1,
              'fixture', 1, 0, 0, '019fc4e0-4444-7000-8000-000000000044');
      INSERT INTO external_conversation_bindings
        (installation_id, path_json, target_kind, space_id, state, created_at, updated_at, space_matched)
      VALUES ('slack:T123', '["C123"]', 'space', '00000000-0000-7000-8000-0000000000b1', 'active',
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1);
    `);
    insertSlackEventJob(objectDatabase, "event:now-shared", appMention("EvNowShared"));
    const posted: Array<Record<string, unknown>> = [];
    let lookups = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("conversations.info")) {
        lookups += 1;
        return json({
          ok: true,
          channel: { id: "C123", name: "general", is_private: false, is_ext_shared: true, is_im: false, is_mpim: false },
        });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "C123", ts: "1.1" });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:now-shared");

    expect(posted).toHaveLength(1);
    expect(String(posted[0]!.text)).toContain("shared with another organization");
    // The room lookup already said so; Slack is not asked twice.
    expect(lookups).toBe(1);
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM slack_agent_sessions").get()).toEqual({ count: 0 });
    expect(objectDatabase.prepare(
      "SELECT COUNT(*) AS count FROM external_conversation_bindings WHERE path_json <> '[\"C123\"]'",
    ).get()).toEqual({ count: 0 });
  });

  it("still refuses a matched Space made private before its room was shared through Slack Connect", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    // Linked by name while Organization-wide; the Space has since been narrowed.
    objectDatabase.exec(`
      INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash,
         revision, created_at, updated_at, created_by_user_id)
      VALUES ('00000000-0000-7000-8000-0000000000b1', 'General', 'personal', 1, 1,
              'fixture', 1, 0, 0, '019fc4e0-4444-7000-8000-000000000044');
      INSERT INTO external_conversation_bindings
        (installation_id, path_json, target_kind, space_id, state, created_at, updated_at, space_matched)
      VALUES ('slack:T123', '["C123"]', 'space', '00000000-0000-7000-8000-0000000000b1', 'active',
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1);
    `);
    insertSlackEventJob(objectDatabase, "event:narrowed-then-shared", appMention("EvNarrowedThenShared"));
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("conversations.info")) {
        return json({
          ok: true,
          channel: { id: "C123", name: "general", is_private: false, is_ext_shared: true, is_im: false, is_mpim: false },
        });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "C123", ts: "1.1" });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:narrowed-then-shared");

    expect(posted).toHaveLength(1);
    expect(String(posted[0]!.text)).toContain("shared with another organization");
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM slack_agent_sessions").get()).toEqual({ count: 0 });
    expect(objectDatabase.prepare(
      "SELECT COUNT(*) AS count FROM external_conversation_bindings WHERE path_json <> '[\"C123\"]'",
    ).get()).toEqual({ count: 0 });
  });

  it("does not refuse a private room's own Space after Slack renumbers it for Slack Connect", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    // The room's own private Space, derived from its old id; the binding has
    // since moved to the id Slack gave the room when it was shared.
    objectDatabase.exec(`
      INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash,
         revision, created_at, updated_at, created_by_user_id)
      VALUES ('00000000-0000-7000-8000-0000000000b1', 'launch-private', 'personal', 1, 1,
              'fixture', 1, 0, 0, '019fc4e0-4444-7000-8000-000000000044');
      INSERT INTO external_conversation_bindings
        (installation_id, path_json, target_kind, space_id, state, created_at, updated_at)
      VALUES ('slack:T123', '["C123"]', 'space', '00000000-0000-7000-8000-0000000000b1', 'active',
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);
    insertSlackEventJob(objectDatabase, "event:renumbered-shared", appMention("EvRenumberedShared"));
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("conversations.info")) {
        return json({
          ok: true,
          channel: { id: "C123", name: "launch-private", is_private: true, is_ext_shared: true, is_im: false, is_mpim: false },
        });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "C123", ts: "1.1" });
      }
      // Past the placement checks, the mention goes on to start work; this test stops there.
      throw new Error("past_placement_checks");
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:renumbered-shared").catch(() => undefined);

    expect(posted.map((message) => String(message.text)).filter((text) => text.includes("shared with another organization")))
      .toEqual([]);
  });

  for (const [label, memberCount, scope] of [
    ["a private room", 2, "personal"],
    ["a private room past the member-count promotion", 51, "workspace"],
  ] as const) {
    it(`opens ${label}'s thread in its Organization-wide Space as a ${scope} Channel`, async () => {
      const database = migratedDatabase();
      const credentialsKey = "test-connector-credentials-key";
      const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
      // Every room's Space is Organization-wide; the room decides the Channel's audience.
      objectDatabase.exec(`
        INSERT INTO spaces
          (space_id, title, scope, authority_generation, source_version, payload_hash,
           revision, created_at, updated_at, created_by_user_id)
        VALUES ('00000000-0000-7000-8000-0000000000b1', 'launch', 'workspace', 1, 1,
                'fixture', 1, 0, 0, '019fc4e0-4444-7000-8000-000000000044');
        INSERT INTO external_conversation_bindings
          (installation_id, path_json, target_kind, space_id, state, created_at, updated_at)
        VALUES ('slack:T123', '["C123"]', 'space', '00000000-0000-7000-8000-0000000000b1', 'active',
                '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
      `);
      insertSlackEventJob(objectDatabase, `event:private-${memberCount}`, appMention(`EvPrivate${memberCount}`));
      const create = vi.spyOn(SlackWorkspaceWorkstreamService.prototype, "create")
        .mockRejectedValue(new Error("stopped_at_create"));
      const posted: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        const json = (body: unknown) => new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        if (url.pathname.endsWith("conversations.info")) {
          return json({ ok: true, channel: { id: "C123", name: "launch", is_private: true, is_im: false, is_mpim: false } });
        }
        if (url.pathname.endsWith("conversations.members")) {
          return json({
            ok: true,
            members: Array.from({ length: memberCount }, (_, index) => `U${900 + index}`),
            response_metadata: {},
          });
        }
        if (url.pathname.endsWith("users.info")) {
          return json({
            ok: true,
            user: {
              id: "U456", team_id: "T123", deleted: false, is_bot: false, name: "adam",
              profile: { display_name: "Adam", real_name: "Adam" },
            },
          });
        }
        if (url.pathname.endsWith("assistant.threads.setStatus")) return json({ ok: true });
        if (url.pathname.endsWith("chat.postMessage")) {
          posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, channel: "C123", ts: "1.1" });
        }
        return json({ ok: true });
      }));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await new SlackAgentService(slackMembershipEnvironment(
        database, instance, credentialsKey, vi.fn(async () => undefined), new Map(),
      )).processQueuedIngress("22222222-2222-4222-8222-222222222222", `event:private-${memberCount}`)
        .catch(() => undefined);

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0]).toMatchObject({
        scope,
        space: { spaceId: "00000000-0000-7000-8000-0000000000b1" },
      });
      expect(posted.map((message) => String(message.text)).filter((text) => text.includes("private"))).toEqual([]);
    });
  }

  it("starts work in a room Slack does not thread without calling a thread API", async () => {
    // Slack refuses a thread there: an Agent status or a `thread_ts` post
    // would fail the request after the reaction said it was accepted.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:non-threadable", appMention("EvNonThreadable"));
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (method === "conversations.info") {
        return json({
          ok: true,
          channel: { id: "C123", is_private: false, is_im: false, is_mpim: false, is_non_threadable: true },
        });
      }
      if (method === "users.info") {
        return json({
          ok: true,
          user: {
            id: "U456", team_id: "T123", deleted: false, is_bot: false, name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        });
      }
      if (method.startsWith("assistant.threads.")) return json({ ok: false, error: "thread_not_supported" });
      if (method === "chat.postMessage") return json({ ok: true, channel: "C123", ts: "1.1" });
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const objectStores = new Map<string, DatabaseSync>();
    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), objectStores,
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:non-threadable");

    expect(calls.filter((call) => call.method.startsWith("assistant.threads."))).toEqual([]);
    expect(calls.filter((call) => call.method === "chat.postMessage" && "thread_ts" in call.body)).toEqual([]);
    const session = objectDatabase.prepare(
      "SELECT slack_thread_ts, json_extract(context_json, '$.source.threadable') AS threadable FROM slack_agent_sessions",
    ).get();
    expect(session).toEqual({ slack_thread_ts: "1.0", threadable: 0 });
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
  applyWorkstreamObjectRootFields(objectStore, {
    title: "Retry",
    description: "Retry",
    originType: "ad_hoc",
    exactState: "needs_input",
    nextSequenceNumber: 2,
    emailAddress: "retry@automation.with-avalon.com",
    emailRouteStatus: "active",
  });
  seedWorkstreamRun(objectStore, { id: "run-a", status: "needs_input",
    createdAt: Date.parse("2026-01-01") });
  seedWorkstreamRun(objectStore, { id: "run-b", status: "needs_input",
    createdAt: Date.parse("2026-01-02") });
  // The object's own table and vocabulary: `_runtime_elicitations` is gone
  // with the last caller that named it, and `pending` is what the object
  // stores for what the retired view rendered as `open`.
  objectStore.exec(`
    INSERT INTO elicitation_requests
      (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json, minimum_selections,
       maximum_selections, target_user_id, status, answer_json, answered_by_user_id,
       external_actor_json, created_at, answered_at)
    VALUES
      ('elicitation-a', 'run-a', 'loop:turn:1:tool:0', 'First?', 'text', '[]', 0, NULL, NULL, 'pending',
       NULL, NULL, NULL, 1767225600000, NULL),
      ('elicitation-b', 'run-b', 'loop:turn:2:tool:0', 'Second?', 'text', '[]', 0, NULL, NULL, 'pending',
       NULL, NULL, NULL, 1767312000000, NULL)
  `);
  seedCanonicalConversationTurn(objectStore, {
    turnId: "message-retry",
    clientMessageId: "event:retry",
    // Canonical authorship preserves the external actor directly.
    actor: externalActorJson === null
      ? authorType
      : "external",
    authorUserId,
    authorSnapshot: null,
    externalActorJson,
    messageType: "elicitation",
    text: "",
    transcriptSequence: 1,
    createdAt: "2026-01-01",
  });
}

/**
 * A real `WorkspaceDO` for the standard installation workspace, seeded with
 * the same connection the regional fixture used to carry: the connection and
 * the Slack tables are WorkspaceDO-authority state, so the object's own
 * database is where the facade and the typed ingress methods both find them.
 */
async function slackInstallationFixture(
  database: DatabaseSync,
  credentialsKey: string,
): Promise<{ instance: WorkspaceDO; objectDatabase: DatabaseSync }> {
  const { instance, objectDatabase } = createTestWorkspaceDO({
    workspaceId: "22222222-2222-4222-8222-222222222222",
    regionalDatabase: database,
    register: (created) => { databases.push(created); },
  });
  await seedSlackInstallation(database, objectDatabase, credentialsKey);
  return { instance, objectDatabase };
}

async function seedSlackInstallation(
  database: DatabaseSync,
  objectDatabase: DatabaseSync,
  credentialsKey: string,
): Promise<void> {
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
    INSERT INTO slack_installation_routes
      (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
    VALUES ('T123', 'global', '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111', 'active', '2026-01-01', '2026-01-01');
  `);
  objectDatabase.exec(`
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
  interface StrandedJobFixture {
    database: DatabaseSync;
    credentialsKey: string;
    instance: WorkspaceDO;
    objectDatabase: DatabaseSync;
  }

  async function strandedJob(id: string): Promise<StrandedJobFixture> {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, id, appMention("EvStranded"));
    objectDatabase.prepare(
      `UPDATE slack_ingress_jobs SET status = 'failed', attempt_count = 20,
         error_code = 'unauthorized', received_at = ?, updated_at = '2026-01-02'
       WHERE id = ?`,
    ).run(new Date().toISOString(), id);
    return { database, credentialsKey, instance, objectDatabase };
  }

  function sweep(fixture: StrandedJobFixture): Promise<unknown[]> {
    const sent: unknown[] = [];
    return new SlackAgentService(slackMembershipEnvironment(
      fixture.database,
      fixture.instance,
      fixture.credentialsKey,
      vi.fn(async (body: unknown) => { sent.push(body); }),
    )).maintainIngress("22222222-2222-4222-8222-222222222222", 100).then(() => sent);
  }

  it("re-drives an authorization failure once the installation is reauthorized", async () => {
    // Slack reports `link_shared` exactly once and never redelivers it, so an
    // event that failed while the grant was dead is lost permanently unless
    // something lifts the retry ceiling after the reconnect.
    const fixture = await strandedJob("event:stranded");
    const { objectDatabase } = fixture;
    objectDatabase.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = '2026-01-03'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(fixture);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:stranded")).toHaveLength(1);
    expect(objectDatabase.prepare(
      "SELECT status, attempt_count FROM slack_ingress_jobs WHERE id = 'event:stranded'",
    ).get()).toMatchObject({ status: "queued", attempt_count: 0 });
  });

  it("does not re-drive while the connection is still marked", async () => {
    // The termination proof. An earlier draft selected on `updated_at` alone
    // against any non-disabled row, and every failure bumped that timestamp
    // through the marking write — so N stranded jobs re-drove each other
    // forever, on a signal that meant "something failed again" rather than
    // "someone reconnected". Only a return to `healthy` is a reconnect.
    const fixture = await strandedJob("event:still-broken");
    const { objectDatabase } = fixture;
    objectDatabase.prepare(
      `UPDATE connector_connections SET status = 'needs_reconnect', updated_at = '2026-01-03'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(fixture);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:still-broken")).toHaveLength(0);
  });

  it("leaves a job alone when nothing about its connection has changed", async () => {
    const fixture = await strandedJob("event:untouched");
    const { objectDatabase } = fixture;
    objectDatabase.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = '2026-01-01'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(fixture);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:untouched")).toHaveLength(0);
  });

  it("re-drives only failures a reauthorization can repair", async () => {
    // A job that died on malformed data is not fixed by a reconnect, and
    // re-driving it every time a connection is written is pure waste.
    const fixture = await strandedJob("event:bad-data");
    const { objectDatabase } = fixture;
    objectDatabase.prepare(
      "UPDATE slack_ingress_jobs SET error_code = 'invalid_slack_data' WHERE id = 'event:bad-data'",
    ).run();
    objectDatabase.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = '2026-01-03'
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run();

    const sent = await sweep(fixture);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:bad-data")).toHaveLength(0);
  });

  it("does not replay an event older than the age bound", async () => {
    // Unfurling a message from three weeks ago answers nobody, and Slack may
    // refuse it outright.
    const fixture = await strandedJob("event:ancient");
    const { objectDatabase } = fixture;
    objectDatabase.prepare(
      "UPDATE slack_ingress_jobs SET received_at = '2026-01-01' WHERE id = 'event:ancient'",
    ).run();
    objectDatabase.prepare(
      `UPDATE connector_connections SET status = 'healthy', updated_at = ?
       WHERE id = '11111111-1111-4111-8111-111111111111'`,
    ).run(new Date().toISOString());

    const sent = await sweep(fixture);

    expect(sent.filter((body) => (body as { jobId?: string }).jobId === "event:ancient")).toHaveLength(0);
  });

  it("re-drives the vocabulary a real authorization failure actually emits", async () => {
    // Closes the loop between `slackIngressErrorCode` and the allowlist: a
    // drift in either would silently disable the whole sweep.
    const fixture = await strandedJob("event:vocabulary");
    const { objectDatabase } = fixture;
    const emitted = objectDatabase.prepare(
      "SELECT error_code FROM slack_ingress_jobs WHERE id = 'event:vocabulary'",
    ).get() as { error_code: string };
    expect(__slackAgentTesting.SLACK_AUTHORIZATION_ERROR_CODES).toContain(emitted.error_code);
  });
});

describe("Slack ingress maintenance reaps link challenges", () => {
  const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
  const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

  function seedChallenge(
    objectDatabase: DatabaseSync,
    tokenHash: string,
    expiresAt: string,
    consumedAt: string | null = null,
  ): void {
    objectDatabase.prepare(
      `INSERT INTO slack_link_challenges
         (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, consumed_at, created_at)
       VALUES (?, ?, 'T123', 'U456', ?, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(tokenHash, CONNECTION_ID, expiresAt, consumedAt);
  }

  it("reaps a spent challenge a day later, not after the 30-day retention", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const soon = new Date(Date.now() + 600_000).toISOString();
    // A day and an hour past expiry: the row the retention-bound reap kept,
    // and the alarm counted as due, for a month.
    seedChallenge(objectDatabase, await sha256("expired-long-ago"), hoursAgo(25));
    // An hour past expiry: still inside the grace that lets a late click be
    // refused as expired rather than unknown.
    seedChallenge(objectDatabase, await sha256("expired-recently"), hoursAgo(1));
    seedChallenge(objectDatabase, await sha256("consumed-long-ago"), soon, hoursAgo(25));
    seedChallenge(objectDatabase, await sha256("consumed-recently"), soon, hoursAgo(1));
    seedChallenge(objectDatabase, await sha256("live"), soon);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
    )).maintainIngress("22222222-2222-4222-8222-222222222222", 100);

    const kept = objectDatabase.prepare("SELECT token_hash FROM slack_link_challenges").all() as { token_hash: string }[];
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
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedChallenge(objectDatabase, await sha256("expired"), "2026-01-01T00:15:00.000Z");
    const env = slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined));
    const ctx: WorkspaceScheduleContext = {
      env,
      // Routed the way the alarm's own context is: the due-time queries read
      // the object's tables, and the reap they schedule removes rows there.
      workspaceEnv: withWorkspaceRuntimeDatabase(env, WORKSPACE_ID),
      workspaceId: WORKSPACE_ID,
      directory: {
        workstreamScheduleTargets: async () => ({ items: [] }),
      },
      dueTerminalSubstreams: async () => [],
      notificationIntents: {
        notificationIntentMaintenanceTarget: async () => ({ dueAt: null }),
        reapSettledWorkstreamNotificationIntents: async () => ({ reapedIntentIds: [] }),
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
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(objectDatabase, "event:exhausted", appMention("EvExhausted"));
    const posted = captureOpsPosts(slackTaskApiFetcher(database, { ok: true }).fetcher);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:exhausted"))
      .rejects.toThrow(/has not granted slack\.agent/iu);

    expect(objectDatabase.prepare(
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
    await expect(new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:exhausted")).resolves.toBeUndefined();

    expect(objectDatabase.prepare(
      "SELECT status, attempt_count FROM slack_ingress_jobs WHERE id = 'event:exhausted'",
    ).get()).toEqual({ status: "failed", attempt_count: 20 });
    expect(posted).toHaveLength(1);
  });

  it("reports one installation failing the same way as one episode", async () => {
    // A broken installation fails every event it receives identically. The
    // first exhausted job is the notice; the rest within the hour are rows.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(objectDatabase, "event:first", appMention("EvFirst"));
    insertSlackEventJob(objectDatabase, "event:second", appMention("EvSecond"));
    const posted = captureOpsPosts(slackTaskApiFetcher(database, { ok: true }).fetcher);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:first")).rejects.toThrow();
    await expect(new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:second")).rejects.toThrow();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("• job_id: event:first");
    expect(failure.mock.calls.map((call) => (call[0] as { job_id?: string }).job_id).filter(Boolean))
      .toEqual(["event:first", "event:second"]);
  });

  it("claims a job one attempt short of the ceiling, and refuses it past it", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    objectDatabase.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(objectDatabase, "event:nineteen", appMention("EvNineteen"));
    objectDatabase.prepare("UPDATE slack_ingress_jobs SET status = 'failed', attempt_count = 19 WHERE id = 'event:nineteen'").run();
    const posted = captureOpsPosts(slackTaskApiFetcher(database, { ok: true }).fetcher);
    const env = slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:nineteen")).rejects.toThrow();

    expect(objectDatabase.prepare("SELECT attempt_count FROM slack_ingress_jobs WHERE id = 'event:nineteen'").get())
      .toEqual({ attempt_count: 20 });
    expect(posted).toHaveLength(1);
  });

  it("logs the standing count of exhausted jobs once per pass, not once per job", async () => {
    // One error row per job per pass is what buried the 2026-08-22 incident
    // under fifty thousand lines an hour.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    for (const id of ["event:dead-1", "event:dead-2", "event:dead-3"]) {
      insertSlackEventJob(objectDatabase, id, appMention(id));
      // Failed today: the pass keeps an exhausted job for 30 days, and one
      // older than that is reaped before it is counted.
      objectDatabase.prepare(
        `UPDATE slack_ingress_jobs SET status = 'failed', attempt_count = 20,
           error_code = 'session_revoked', updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), id);
    }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
    )).maintainIngress("22222222-2222-4222-8222-222222222222", 100);

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
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:expired", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvExpired",
      // The bot's own invitation asks Slack what the room is before linking it.
      authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
      event: { type: "member_joined_channel", user: "UBOT", channel: "CNEW", channel_type: "C" },
    });
    const posted = captureOpsPosts(async () => new Response(JSON.stringify({
      ok: false,
      error: "token_expired",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const env = slackMembershipEnvironment(
      database,
      instance,
      credentialsKey,
      vi.fn(async () => undefined),
      undefined,
      { APP_ENV: "production", ...OPS_SECRETS },
    );

    await expect(new SlackAgentService(env).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:expired"))
      .rejects.toMatchObject({ message: "token_expired" });

    expect(objectDatabase.prepare(
      "SELECT attempt_count FROM slack_ingress_jobs WHERE id = 'event:expired'",
    ).get()).toEqual({ attempt_count: 1 });
    expect(posted).toEqual([]);
  });
});

describe("Slack replies routed by external conversation bindings", () => {
  const SIDEKICK = "33333333-3333-4333-8333-333333333333";
  const RUN = "44444444-4444-4444-8444-444444444444";

  function seedBinding(
    objectDatabase: DatabaseSync,
    path: string[],
    state: "active" | "suspended" = "active",
    reason: "sidekick_deleted" | "connection_disconnected" = "sidekick_deleted",
  ): void {
    objectDatabase.prepare(
      `INSERT INTO external_conversation_bindings
         (installation_id, path_json, target_kind, space_id, parent_kind, parent_id, substream_id,
          state, suspended_reason, claim_key, created_at, updated_at)
       VALUES ('slack:T123', ?, 'conversation', NULL, 'automation', ?, ?, ?, ?, NULL,
               '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(JSON.stringify(path), SIDEKICK, RUN, state, state === "suspended" ? reason : null);
  }

  function dmMessage(eventId: string, input: { ts: string; threadTs?: string; text: string }): Record<string, unknown> {
    return {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: eventId,
      event: {
        type: "message",
        user: "U456",
        channel: "D1",
        channel_type: "im",
        ts: input.ts,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        text: input.text,
      },
    };
  }

  function slackStub(): {
    posted: Array<Record<string, unknown>>;
    reactions: Array<Record<string, unknown>>;
    fetcher: ReturnType<typeof vi.fn>;
  } {
    const posted: Array<Record<string, unknown>> = [];
    const reactions: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("reactions.add")) {
        reactions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true });
      }
      if (url.pathname.endsWith("users.info")) {
        return json({
          ok: true,
          user: {
            id: "U456", team_id: "T123", deleted: false, is_bot: false, name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "D1", ts: "1727.900" });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    return { posted, reactions, fetcher };
  }

  it("delivers a reply in a run's bound thread to that run, as the sender's external message", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedBinding(objectDatabase, ["D1", "1727.002"]);
    insertSlackEventJob(objectDatabase, "event:reply", dmMessage("EvReply", {
      ts: "1727.100", threadTs: "1727.002", text: "Nothing from me",
    }));
    const { posted, reactions } = slackStub();
    const admitted: Array<Record<string, unknown>> = [];
    await new SlackAgentService(slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined), undefined, {
      ...sidekickRuns("needs_input"),
      SUBSTREAM_AGENTS: createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>(testSubstreamAgentsBinding(database, {
        extra: {
          admitExternalMessage: vi.fn(async (input: Record<string, unknown>) => {
            admitted.push(input);
            return { status: 200, bodyJson: JSON.stringify({
              turn: { turnId: "turn-1", clientMessageId: input.clientMessageId, createdAt: "2026-09-01T00:00:00.000Z" },
              deliveryState: "pending",
            }) };
          }),
        },
      })),
    })).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:reply");

    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      workstreamId: SIDEKICK,
      substreamId: RUN,
      text: "Nothing from me",
      clientMessageId: "event:EvReply",
      origin: "external_conversation_binding",
      actor: { provider: "slack", providerAccountId: "T123", providerUserId: "U456", displayName: "Adam" },
      slackOrigin: {
        teamId: "T123",
        channelId: "D1",
        threadTs: "1727.002",
        messageTs: "1727.100",
        permalink: expect.stringContaining("/archives/D1/p1727100"),
      },
    });
    // No Agent Channel, no session, and nothing said in Slack beyond the
    // acknowledgement on the reply itself.
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM slack_agent_sessions").get()).toEqual({ count: 0 });
    expect(posted).toEqual([]);
    expect(reactions).toEqual([{ channel: "D1", timestamp: "1727.100", name: "eyes" }]);
  });

  it("marks a bound reply to a paused Sidekick as held rather than acknowledged", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedBinding(objectDatabase, ["D1", "1727.002"]);
    insertSlackEventJob(objectDatabase, "event:paused-reply", dmMessage("EvPausedReply", {
      ts: "1727.110", threadTs: "1727.002", text: "Here you go",
    }));
    const { reactions } = slackStub();
    await new SlackAgentService(slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined), undefined, {
      ...sidekickRuns("needs_input", [], "paused"),
      SUBSTREAM_AGENTS: createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>(testSubstreamAgentsBinding(database, {
        extra: {
          admitExternalMessage: vi.fn(async (input: Record<string, unknown>) => ({ status: 200, bodyJson: JSON.stringify({
            turn: { turnId: "turn-1", clientMessageId: input.clientMessageId, createdAt: "2026-09-01T00:00:00.000Z" },
            deliveryState: "pending",
          }) })),
        },
      })),
    })).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:paused-reply");

    expect(reactions).toEqual([{ channel: "D1", timestamp: "1727.110", name: "octagonal_sign" }]);
  });

  it("lifts a disconnect's suspension when the installation delivers a reply, and delivers it", async () => {
    // The reconnect's own reactivation did not land (or a late revocation
    // suspended the new installation): Slack delivering this event is proof
    // enough that the installation is connected.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedBinding(objectDatabase, ["D1", "1727.002"], "suspended", "connection_disconnected");
    seedBinding(objectDatabase, ["D9", "1727.009"], "suspended", "sidekick_deleted");
    insertSlackEventJob(objectDatabase, "event:after-reconnect", dmMessage("EvAfterReconnect", {
      ts: "1727.100", threadTs: "1727.002", text: "Nothing from me",
    }));
    slackStub();
    const admitted: Array<Record<string, unknown>> = [];
    await new SlackAgentService(slackMembershipEnvironment(database, instance, credentialsKey, vi.fn(async () => undefined), undefined, {
      SUBSTREAM_AGENTS: createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>(testSubstreamAgentsBinding(database, {
        extra: {
          admitExternalMessage: vi.fn(async (input: Record<string, unknown>) => {
            admitted.push(input);
            return { status: 200, bodyJson: JSON.stringify({
              turn: { turnId: "turn-1", clientMessageId: input.clientMessageId, createdAt: "2026-09-01T00:00:00.000Z" },
              deliveryState: "pending",
            }) };
          }),
        },
      })),
    })).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:after-reconnect");

    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ workstreamId: SIDEKICK, substreamId: RUN, text: "Nothing from me" });
    expect(objectDatabase.prepare(
      "SELECT path_json, state, suspended_reason FROM external_conversation_bindings ORDER BY path_json",
    ).all()).toEqual([
      { path_json: '["D1","1727.002"]', state: "active", suspended_reason: null },
      // A lasting suspension is not the installation's to lift.
      { path_json: '["D9","1727.009"]', state: "suspended", suspended_reason: "sidekick_deleted" },
    ]);
  });

  /** The Organization object's answer about the run the DM's latest request belongs to. */
  function sidekickRuns(state: string, reads: Array<Record<string, unknown>> = [], lifecycle = "active"): SlackEnvironmentOverrides {
    return {
      workspaceRpcs: {
        sidekickReadRunState: async (request: Record<string, unknown>) => {
          reads.push(request);
          return { state, lifecycle, completedAt: null, coordinatorEligible: true };
        },
      },
    };
  }

  it("asks a top-level DM reply to answer in the open request's thread, the same way on a retry, and creates no work", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedBinding(objectDatabase, ["D1", "1727.002"]);
    insertSlackEventJob(objectDatabase, "event:top-level", dmMessage("EvTopLevel", { ts: "1727.200", text: "Nothing from me" }));
    const { posted } = slackStub();
    const reads: Array<Record<string, unknown>> = [];
    const service = new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), undefined, sidekickRuns("needs_input", reads),
    ));

    await service.processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:top-level");
    // A retry of the same provider event (its first attempt's settlement was
    // lost) asks with the same message identity, which Slack deduplicates.
    objectDatabase.prepare(
      "UPDATE slack_ingress_jobs SET status = 'queued', payload_json = ? WHERE id = 'event:top-level'",
    ).run(JSON.stringify(dmMessage("EvTopLevel", { ts: "1727.200", text: "Nothing from me" })));
    await service.processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:top-level");

    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({ channel: "D1", thread_ts: "1727.200" });
    expect(String(posted[0]!.text)).toContain("https://slack.com/archives/D1/p1727002");
    expect(posted[1]!.client_msg_id).toBe(posted[0]!.client_msg_id);
    expect(reads[0]).toMatchObject({ automationId: SIDEKICK, runId: RUN });

    // A reply under that prompt is still not the request's thread: asked
    // again, in the prompt's own thread, rather than becoming Agent work.
    insertSlackEventJob(objectDatabase, "event:under-prompt", dmMessage("EvUnderPrompt", {
      ts: "1727.300", threadTs: "1727.200", text: "Nothing from me, again",
    }));
    await service.processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:under-prompt");
    expect(posted).toHaveLength(3);
    expect(posted[2]).toMatchObject({ channel: "D1", thread_ts: "1727.200" });
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM slack_agent_sessions").get()).toEqual({ count: 0 });
  });

  it("treats a top-level DM as Agent work again once the request's run has finished", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedBinding(objectDatabase, ["D1", "1727.002"]);
    insertSlackEventJob(objectDatabase, "event:after-run", dmMessage("EvAfterRun", { ts: "1727.600", text: "investigate this" }));
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("users.info")) {
        return json({
          ok: true,
          user: {
            id: "U456", team_id: "T123", deleted: false, is_bot: false, name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        });
      }
      if (url.pathname.endsWith("assistant.threads.setStatus") || url.pathname.endsWith("assistant.threads.setTitle")) {
        return json({ ok: true });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "D1", ts: "1727.900" });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const objectStores = new Map<string, DatabaseSync>();
    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), objectStores, sidekickRuns("completed"),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:after-run");

    expect(posted).toEqual([]);
    expect(objectDatabase.prepare(
      "SELECT slack_channel_id, slack_thread_ts FROM slack_agent_sessions",
    ).get()).toEqual({ slack_channel_id: "D1", slack_thread_ts: "1727.600" });
  });

  it("keeps today's one-to-one Agent behavior in a DM with no open request", async () => {
    // Another DM holds a request; this one does not, so its top-level message
    // is an ordinary request to the Agent: a session and its thread binding.
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedBinding(objectDatabase, ["D2", "1727.002"]);
    insertSlackEventJob(objectDatabase, "event:plain-dm", dmMessage("EvPlainDm", { ts: "1727.500", text: "investigate this" }));
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("users.info")) {
        return json({
          ok: true,
          user: {
            id: "U456", team_id: "T123", deleted: false, is_bot: false, name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        });
      }
      if (url.pathname.endsWith("assistant.threads.setStatus") || url.pathname.endsWith("assistant.threads.setTitle")) {
        return json({ ok: true });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: "D1", ts: "1727.900" });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    const objectStores = new Map<string, DatabaseSync>();
    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined), objectStores,
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:plain-dm");

    expect(posted).toEqual([]);
    const session = objectDatabase.prepare(
      "SELECT slack_channel_id, slack_thread_ts, workstream_id FROM slack_agent_sessions",
    ).get() as { slack_channel_id: string; slack_thread_ts: string; workstream_id: string };
    expect(session).toMatchObject({ slack_channel_id: "D1", slack_thread_ts: "1727.500" });
    expect(objectDatabase.prepare(
      `SELECT parent_kind, parent_id, state FROM external_conversation_bindings
        WHERE path_json = '["D1","1727.500"]'`,
    ).get()).toEqual({ parent_kind: "workstream", parent_id: session.workstream_id, state: "active" });
  });

  it("joins the conversations a saved Slack source names, and links no Space", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:source-join", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "rally-sidekick-source-join:automation:C9",
      event: { type: "rally_sidekick_source_join", channel_ids: ["C9"] },
    });
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push({ method: url.pathname.split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, channel: { id: "C9" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:source-join");

    expect(calls).toEqual([{ method: "conversations.join", body: { channel: "C9" } }]);
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM external_conversation_bindings").get())
      .toEqual({ count: 0 });
  });

  const LINKED_USER = "019fc4e0-4444-7000-8000-000000000044";

  function invitation(eventId: string, event: Record<string, unknown>): Record<string, unknown> {
    return {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: eventId,
      authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
      event,
    };
  }

  const roomPosts: Array<Record<string, unknown>> = [];

  /** Slack's answers for a room and its members; U456 is the linked member. */
  function roomStub(room: Record<string, unknown>, members: string[]): void {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname.endsWith("conversations.info")) return json({ ok: true, channel: room });
      if (url.pathname.endsWith("conversations.members")) return json({ ok: true, members, response_metadata: {} });
      if (url.pathname.endsWith("chat.postMessage")) {
        roomPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, channel: String(room.id), ts: "9.0" });
      }
      if (url.pathname.endsWith("users.info")) {
        const user = String((JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>).user ?? "");
        return json({
          ok: true,
          user: {
            id: user, team_id: "T123", deleted: false, is_bot: false, name: user.toLowerCase(),
            profile: { display_name: user, real_name: user, email: `${user.toLowerCase()}@elsewhere.example` },
          },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));
  }

  function captureRoomLinks(instance: WorkspaceDO): Array<Record<string, unknown>> {
    const links: Array<Record<string, unknown>> = [];
    vi.spyOn(instance, "admitSpaceCreation").mockResolvedValue({ ok: true } as never);
    vi.spyOn(instance, "linkExternalRoom").mockImplementation(async (request: unknown) => {
      links.push(request as Record<string, unknown>);
      return { ok: true, outcome: "linked", spaceId: (request as { spaceId: string }).spaceId } as never;
    });
    return links;
  }

  it("links a private room to an Organization-wide Space, acting as the member who is there when the inviter is not one", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    // Invited by somebody Rally does not know; the linked member is in the room.
    insertSlackEventJob(objectDatabase, "event:invited-private", invitation("EvInvitedPrivate", {
      type: "member_joined_channel", user: "UBOT", inviter: "U999", channel: "GPRIV", channel_type: "G",
    }));
    roomStub({ id: "GPRIV", name: "launch-private", is_private: true, is_im: false, is_mpim: false }, ["U999", "U456", "UBOT"]);
    const links = captureRoomLinks(instance);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:invited-private");

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      installationId: "slack:T123",
      path: ["GPRIV"],
      userId: LINKED_USER,
      space: { name: "launch-private" },
    });
    expect(links[0]).not.toHaveProperty("participantUserIds");
  });

  it("names a room's Space by the room, so a repeated invitation claims the same anchor", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    for (const id of ["EvInviteOne", "EvInviteTwo"]) {
      insertSlackEventJob(objectDatabase, `event:${id}`, invitation(id, {
        type: "member_joined_channel", user: "UBOT", inviter: "U456", channel: "CPUB", channel_type: "C",
      }));
    }
    roomStub({ id: "CPUB", name: "launch", is_private: false, is_im: false, is_mpim: false }, []);
    // The capture writes no binding, as for two invitations that race.
    const links = captureRoomLinks(instance);
    const service = new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    ));
    await service.processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:EvInviteOne");
    await service.processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:EvInviteTwo");

    expect(links).toHaveLength(2);
    expect(links[1]!.spaceId).toBe(links[0]!.spaceId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams WHERE id = ?").get(String(links[0]!.spaceId)))
      .toEqual({ count: 1 });
  });

  it("links a public room to an Organization-wide Space as the inviter", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:invited-public", invitation("EvInvitedPublic", {
      type: "member_joined_channel", user: "UBOT", inviter: "U456", channel: "CPUB", channel_type: "C",
    }));
    roomStub({ id: "CPUB", name: "launch", is_private: false, is_im: false, is_mpim: false }, []);
    roomPosts.length = 0;
    const links = captureRoomLinks(instance);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:invited-public");

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      path: ["CPUB"], userId: LINKED_USER, space: { name: "launch" }, spaceMatch: "unmatched",
    });
    // One line in the room saying what inviting Rally did.
    expect(roomPosts).toEqual([expect.objectContaining({ channel: "CPUB", text: expect.stringContaining("Rally is here") })]);
    expect(roomPosts[0]).not.toHaveProperty("thread_ts");
  });

  it("links a public room into the existing Space its name matches, claiming no anchor of its own", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:invited-general", invitation("EvInvitedGeneral", {
      type: "member_joined_channel", user: "UBOT", inviter: "U456", channel: "CGEN", channel_type: "C",
    }));
    roomStub({ id: "CGEN", name: "general", is_private: false, is_im: false, is_mpim: false }, []);
    const links = captureRoomLinks(instance);
    const general = "00000000-0000-7000-8000-0000000000a1";
    const asked: unknown[] = [];
    vi.spyOn(instance, "externalRoomSpaceMatch").mockImplementation(async (request: unknown) => {
      asked.push(request);
      return { spaceId: general } as never;
    });
    const admit = vi.mocked(instance.admitSpaceCreation);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:invited-general");

    expect(asked).toEqual([{ workspaceId: expect.any(String), name: "general" }]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ path: ["CGEN"], spaceId: general, spaceMatch: "matched", space: { name: "general" } });
    expect(admit).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams WHERE id = ?").get(general)).toEqual({ count: 0 });
  });

  it("never matches a private room to an existing Space, even one of the same name", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:invited-private-general", invitation("EvInvitedPrivateGeneral", {
      type: "member_joined_channel", user: "UBOT", inviter: "U456", channel: "GGEN", channel_type: "G",
    }));
    roomStub({ id: "GGEN", name: "general", is_private: true, is_im: false, is_mpim: false }, ["U456", "UBOT"]);
    const links = captureRoomLinks(instance);
    const matcher = vi.spyOn(instance, "externalRoomSpaceMatch")
      .mockResolvedValue({ spaceId: "00000000-0000-7000-8000-0000000000a1" } as never);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:invited-private-general");

    expect(matcher).not.toHaveBeenCalled();
    expect(links).toHaveLength(1);
    expect(links[0]!.spaceId).toBe("6594616a-fafc-5c5c-a4d9-3d7e512b42d5");
    expect(links[0]).not.toHaveProperty("spaceMatch");
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams WHERE id = ?").get(String(links[0]!.spaceId)))
      .toEqual({ count: 1 });
  });

  it("never matches a Slack Connect room to an existing Space, even a public one of the same name", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await linkedSlackMemberFixture(database, credentialsKey);
    insertSlackEventJob(objectDatabase, "event:invited-connect-general", invitation("EvInvitedConnectGeneral", {
      type: "member_joined_channel", user: "UBOT", inviter: "U456", channel: "CEXT", channel_type: "C",
    }));
    roomStub({ id: "CEXT", name: "general", is_private: false, is_ext_shared: true, is_im: false, is_mpim: false }, []);
    const links = captureRoomLinks(instance);
    const matcher = vi.spyOn(instance, "externalRoomSpaceMatch")
      .mockResolvedValue({ spaceId: "00000000-0000-7000-8000-0000000000a1" } as never);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:invited-connect-general");

    expect(matcher).not.toHaveBeenCalled();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ path: ["CEXT"], space: { name: "general" } });
    expect(links[0]).not.toHaveProperty("spaceMatch");
  });

  it("suspends a room when the bot leaves or it is archived, moves it when renumbered, and ignores a person leaving", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    for (const channel of ["CLEAVE", "CARCH", "CPERSON", "COLD"]) {
      objectDatabase.prepare(
        `INSERT INTO external_conversation_bindings
           (installation_id, path_json, target_kind, space_id, state, created_at, updated_at)
         VALUES ('slack:T123', ?, 'space', '00000000-0000-7000-8000-0000000000c1', 'active',
                 '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      ).run(JSON.stringify([channel]));
    }
    const events: Array<[string, Record<string, unknown>]> = [
      ["event:bot-left", { type: "member_left_channel", user: "UBOT", channel: "CLEAVE" }],
      ["event:archived", { type: "channel_archive", channel: "CARCH", user: "U456" }],
      ["event:person-left", { type: "member_left_channel", user: "U456", channel: "CPERSON" }],
      ["event:renumbered", { type: "channel_id_changed", old_channel_id: "COLD", new_channel_id: "CNEW2" }],
    ];
    for (const [id, event] of events) insertSlackEventJob(objectDatabase, id, invitation(id.replace("event:", "Ev"), event));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected Slack request ${String(input)}`);
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const service = new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    ));
    for (const [id] of events) await service.processQueuedIngress("22222222-2222-4222-8222-222222222222", id);

    expect(objectDatabase.prepare(
      "SELECT path_json, state, suspended_reason FROM external_conversation_bindings ORDER BY path_json",
    ).all()).toEqual([
      { path_json: '["CARCH"]', state: "suspended", suspended_reason: "provider_room_archived" },
      { path_json: '["CLEAVE"]', state: "suspended", suspended_reason: "provider_membership_ended" },
      { path_json: '["CNEW2"]', state: "active", suspended_reason: null },
      { path_json: '["CPERSON"]', state: "active", suspended_reason: null },
    ]);
  });

  it("creates no work for a reply to a suspended binding", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const { instance, objectDatabase } = await slackInstallationFixture(database, credentialsKey);
    seedBinding(objectDatabase, ["D1", "1727.002"], "suspended");
    insertSlackEventJob(objectDatabase, "event:suspended", dmMessage("EvSuspended", {
      ts: "1727.300", threadTs: "1727.002", text: "Anyone there?",
    }));
    const { fetcher } = slackStub();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await new SlackAgentService(slackMembershipEnvironment(
      database, instance, credentialsKey, vi.fn(async () => undefined),
    )).processQueuedIngress("22222222-2222-4222-8222-222222222222", "event:suspended");

    expect(fetcher).not.toHaveBeenCalled();
    expect(objectDatabase.prepare("SELECT COUNT(*) AS count FROM slack_agent_sessions").get()).toEqual({ count: 0 });
    const events = [...info.mock.calls, ...log.mock.calls].map((call) => (call[0] as { event?: unknown }).event);
    expect(events).toContain("binding_suspended");
    expect(objectDatabase.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:suspended'",
    ).get()).toEqual({ status: "completed" });
  });
});

function insertSlackEventJob(objectDatabase: DatabaseSync, id: string, payload: unknown): void {
  objectDatabase.prepare(
    `INSERT INTO slack_ingress_jobs
     (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
      status, attempt_count, received_at, updated_at)
     VALUES (?, '22222222-2222-4222-8222-222222222222',
             '11111111-1111-4111-8111-111111111111', 'T123', 'hash', 'event', ?,
             'queued', 0, '2026-01-01', '2026-01-01')`,
  ).run(id, JSON.stringify(payload));
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
    throw new Error(`Unexpected Slack request ${url}`);
  });
  return { fetcher, methods };
}

/** Env overrides, plus extra methods on the Organization object's stub. */
type SlackEnvironmentOverrides = Partial<Env> & { workspaceRpcs?: Record<string, unknown> };

function slackMembershipEnvironment(
  database: DatabaseSync,
  instance: WorkspaceDO,
  credentialsKey: string,
  send: (body: unknown) => Promise<void>,
  objectStores?: Map<string, DatabaseSync>,
  { workspaceRpcs = {}, ...overrides }: SlackEnvironmentOverrides = {},
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
    // The typed ingress methods and the runtime SQL port both answer from the
    // real workspace object, so every WorkspaceDO-authority table lives in
    // one store the way production has it. The Channel parent it hosts is
    // doubled: real parent grant initialization is covered in workerd
    // conversation-creation.
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        ...workspaceObjectRpcs(instance, SLACK_WORKSPACE_OBJECT_METHODS),
        ...spaceCreationWorkspaceRpcs(),
        ...parentCreationRpcs(),
        admitConnectorParticipants: async () => ({ status: "ready" }),
        ...workspaceRpcs,
      },
    }),
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
