import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migratedSqliteDatabase, preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  recordConnectorActorIdentity,
  resolveConnectorActorIdentity,
} from "../src/services/connector-actor-identity";
import { createTestEnv } from "./helpers/cloudflare-test";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("connector actor identity", () => {
  const linearActor = {
    provider: "linear",
    providerAccountId: "org-avalon",
    providerUserId: "linear-user-taylor",
    displayName: "Taylor",
    avatarUrl: null,
  };

  it("resolves any connector's actor from a member's own personal connection", async () => {
    const database = seededDatabase();
    // `provider_account_id` is provider-shaped — Linear stores the organization
    // and Slack stores `<team>:<user>` — so the actor is matched against the
    // normalized identity the OAuth callback writes to config_json.
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, status, cursor_json, config_json,
         created_at, updated_at, model_plugin_id)
      VALUES
        ('connection-linear', 'workspace-1', 'linear', 'personal', 'user-taylor',
         'org-avalon', 'Linear', '[]', 'healthy', '{}',
         '{"providerTenantId":"org-avalon","providerUserId":"linear-user-taylor"}',
         '2026-01-01', '2026-01-01', 'plugin_linear'),
        ('connection-slack', 'workspace-1', 'slack', 'personal', 'user-jordan',
         'T123:U456', 'Slack', '[]', 'healthy', '{}',
         '{"providerTenantId":"T123","providerUserId":"U456"}',
         '2026-01-01', '2026-01-01', 'plugin_slack');
    `);
    const env = createTestEnv({ DB: sqliteD1(database) });

    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toEqual({
      userId: "user-taylor",
      verification: "personal_connection",
    });
    await expect(resolveConnectorActorIdentity(env, "workspace-1", {
      provider: "slack",
      providerAccountId: "T123",
      providerUserId: "U456",
      displayName: "Jordan",
      avatarUrl: null,
    })).resolves.toEqual({ userId: "user-jordan", verification: "personal_connection" });
  });

  it("does not match a personal connection of the same provider in another tenant", async () => {
    const database = seededDatabase();
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, status, cursor_json, config_json,
         created_at, updated_at, model_plugin_id)
      VALUES ('connection-linear', 'workspace-1', 'linear', 'personal', 'user-taylor',
              'org-other', 'Linear', '[]', 'healthy', '{}',
              '{"providerTenantId":"org-other","providerUserId":"linear-user-taylor"}',
              '2026-01-01', '2026-01-01', 'plugin_linear');
    `);
    const env = createTestEnv({ DB: sqliteD1(database) });

    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toBeNull();
  });

  it("prefers a recorded account link over every weaker mapping", async () => {
    const database = seededDatabase();
    storeIdentity(database, "workspace-1", "user-jordan", "slack_user_link");
    const env = createTestEnv({ DB: sqliteD1(database) });

    await expect(resolveConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      "taylor@example.com",
    )).resolves.toEqual({ userId: "user-jordan", verification: "account_link" });
  });

  it("falls back to a verified email that exactly one active member holds", async () => {
    const database = seededDatabase();
    const env = createTestEnv({ DB: sqliteD1(database) });

    await expect(resolveConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      "  Taylor@Example.com ",
    )).resolves.toEqual({ userId: "user-taylor", verification: "verified_email" });
  });

  it("resolves nobody for an unknown actor, a suspended member, or another workspace", async () => {
    const database = seededDatabase();
    const env = createTestEnv({ DB: sqliteD1(database) });

    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toBeNull();
    await expect(resolveConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      "former@example.com",
    )).resolves.toBeNull();

    storeIdentity(database, "workspace-2", "user-taylor", "account_link");
    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toBeNull();
  });

  it("stores only the email lookup, which nothing else can reproduce", async () => {
    const database = seededDatabase();
    const env = createTestEnv({ DB: sqliteD1(database) });

    // The stronger tiers are already derivable from a stored row or the
    // connection itself, so recording them would add a write to every inbound
    // provider message and relabel another writer's row with a synonym.
    for (const verification of ["account_link", "personal_connection"] as const) {
      await recordConnectorActorIdentity(
        env,
        "workspace-1",
        linearActor,
        { userId: "user-taylor", verification },
        "taylor@example.com",
      );
    }
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM external_user_identities",
    ).get()).toEqual({ count: 0 });

    await recordConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      { userId: "user-taylor", verification: "verified_email" },
      "  Taylor@Example.com ",
    );
    expect(database.prepare(
      `SELECT user_id, email, display_name, verification_source
       FROM external_user_identities WHERE workspace_id = 'workspace-1'`,
    ).all()).toEqual([{
      user_id: "user-taylor",
      email: "taylor@example.com",
      display_name: "Taylor",
      verification_source: "verified_email",
    }]);
  });

  it("never lets a verified email retarget an identity that is already linked", async () => {
    const database = seededDatabase();
    const env = createTestEnv({ DB: sqliteD1(database) });

    storeIdentity(database, "workspace-1", "user-taylor", "slack_user_link");
    // A provider profile can carry an address belonging to a different member.
    await recordConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      { userId: "user-jordan", verification: "verified_email" },
      "jordan@example.com",
    );

    expect(database.prepare(
      `SELECT user_id, verification_source FROM external_user_identities
       WHERE workspace_id = 'workspace-1'`,
    ).all()).toEqual([{ user_id: "user-taylor", verification_source: "slack_user_link" }]);
    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toEqual({
      userId: "user-taylor",
      verification: "account_link",
    });
  });

  it("reads a stored mapping back at the strength it was recorded with", async () => {
    const database = seededDatabase();
    const env = createTestEnv({ DB: sqliteD1(database) });

    await recordConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      { userId: "user-taylor", verification: "verified_email" },
      "taylor@example.com",
    );

    // Reading it back as an account link would silently promote a weak match
    // and let it overwrite a real link on the next write.
    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toEqual({
      userId: "user-taylor",
      verification: "verified_email",
    });

    database.exec(`
      UPDATE external_user_identities
      SET verification_source = 'personal_connector_oauth'
      WHERE workspace_id = 'workspace-1';
    `);
    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toEqual({
      userId: "user-taylor",
      verification: "personal_connection",
    });
  });
});

/**
 * `external_user_identities` rows written by the other producers — the
 * opportunity directory sync uses its own `verification_source` vocabulary.
 */
function storeIdentity(
  database: DatabaseSync,
  workspaceId: string,
  userId: string,
  source: string,
): void {
  database.prepare(
    `INSERT INTO external_user_identities
     (id, workspace_id, user_id, provider, provider_tenant_id, provider_user_id,
      handle, email, display_name, verification_source, created_at, updated_at)
     VALUES (?, ?, ?, 'linear', 'org-avalon', 'linear-user-taylor', NULL, NULL, NULL, ?,
             '2026-01-01', '2026-01-01')`,
  ).run(`identity-${workspaceId}-${userId}`, workspaceId, userId, source);
}

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01'),
      ('user-jordan', 'google-jordan', 'jordan@example.com', 'Jordan', '2026-01-01', '2026-01-01'),
      ('user-former', 'google-former', 'former@example.com', 'Former', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES
      ('workspace-1', 'One', 'one', 'global', 'user-owner', '2026-01-01', '2026-01-01'),
      ('workspace-2', 'Two', 'two', 'global', 'user-owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('workspace-1', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('workspace-1', 'user-taylor', 'member', 'active', '2026-01-01'),
      ('workspace-1', 'user-jordan', 'member', 'active', '2026-01-01'),
      ('workspace-1', 'user-former', 'member', 'suspended', '2026-01-01'),
      ('workspace-2', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('workspace-2', 'user-taylor', 'member', 'active', '2026-01-01');
  `);
  return database;
}


it("attributes verified guests", async () => {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`INSERT INTO users (id,email,name,created_at,updated_at)
    VALUES ('guest','guest@example.test','Guest','now','now'), ('member','member@example.test','Member','now','now');
    INSERT INTO workspaces (id,name,slug,region,created_by_user_id,created_at,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000071','Workspace','workspace','global','member','now','now');
    INSERT INTO workspace_members (workspace_id,user_id,access_class,role,status,joined_at)
    VALUES ('00000000-0000-4000-8000-000000000071','guest','guest',NULL,'active','now'), ('00000000-0000-4000-8000-000000000071','member','member','owner','active','now');`);
  const workspace = createTestWorkspaceDO({ workspaceId: "00000000-0000-4000-8000-000000000071", regionalDatabase: database });
  databases.push(workspace.objectDatabase);
  const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test",
    WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ["executeRuntimeSql"]) });
  const actor = { provider: "linear", providerAccountId: "org", providerUserId: "external", displayName: "Guest", avatarUrl: null };
  expect(await resolveConnectorActorIdentity(env, "00000000-0000-4000-8000-000000000071", actor, "guest@example.test"))
    .toEqual({ userId: "guest", verification: "verified_email", accessClass: "guest" });
});
