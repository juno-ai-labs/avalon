import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { encryptString } from "../src/lib/crypto";
import { ConnectionService } from "../src/services/connection-service";
import {
  createTestEnv,
} from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const CONNECTION_ID = "00000000-0000-7000-8000-000000000041";
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000042");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000043");
const CREDENTIALS_KEY = "github-repository-policy-test-key";
const databases: DatabaseSync[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    expect(url.pathname).toBe("/installation/repositories");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-installation-token");
    return jsonResponse({
      total_count: 2,
      repositories: [
        {
          id: 101,
          node_id: "repo-node-101",
          name: "avalon",
          full_name: "with-avalon/avalon",
          private: true,
          html_url: "https://github.com/with-avalon/avalon",
          default_branch: "main",
          owner: { login: "with-avalon" },
        },
        {
          id: 102,
          node_id: "repo-node-102",
          name: "docs",
          full_name: "with-avalon/docs",
          private: false,
          html_url: "https://github.com/with-avalon/docs",
          default_branch: "main",
          owner: { login: "with-avalon" },
        },
      ],
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("GitHub repository access settings", () => {
  it("defaults existing connections to full access and persists a revisioned selected-repository policy", async () => {
    const database = migratedDatabase();
    await seedConnection(database);
    const service = new ConnectionService(environment(database), authorization());

    await expect(service.getGitHubRepositoryAccess(CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      connectionName: "GitHub · with-avalon",
      revision: 0,
      mode: "all_repositories",
      defaultRemoteAccess: "full_access",
      repositories: [],
      availableRepositories: [
        {
          repositoryId: "101",
          repositoryFullName: "with-avalon/avalon",
          private: true,
          remoteAccess: "full_access",
        },
        {
          repositoryId: "102",
          repositoryFullName: "with-avalon/docs",
          private: false,
          remoteAccess: "full_access",
        },
      ],
    });
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-000000000044', '${WORKSPACE_ID}', 'Terminal',
              'Terminal', 'ad_hoc', '${USER_ID}', 'idle', '2026-01-01', '2026-01-01', '2026-01-01');
    `);
    const objectStore = selectedRepositoryObject("00000000-0000-7000-8000-000000000044");

    const updated = await service.updateGitHubRepositoryAccess(CONNECTION_ID, {
      expectedRevision: 0,
      mode: "selected_repositories",
      defaultRemoteAccess: "read_only",
      repositories: [{
        repositoryId: "101",
        repositoryFullName: "with-avalon/avalon",
        remoteAccess: "read_only",
      }],
    });
    expect(updated).toMatchObject({
      revision: 1,
      mode: "selected_repositories",
      repositories: [{
        repositoryId: "101",
        repositoryFullName: "with-avalon/avalon",
        remoteAccess: "read_only",
      }],
      availableRepositories: [
        { repositoryFullName: "with-avalon/avalon", remoteAccess: "read_only" },
        { repositoryFullName: "with-avalon/docs", remoteAccess: null },
      ],
    });
    const config = JSON.parse(String(database.prepare(
      "SELECT config_json FROM connector_connections WHERE id = ?",
    ).get(CONNECTION_ID)?.config_json)) as Record<string, unknown>;
    expect(config).toMatchObject({
      installationId: "9001",
      githubRepositoryAccess: {
        version: 1,
        revision: 1,
        mode: "selected_repositories",
        defaultAccess: "read_only",
        repositories: [{
          repositoryId: "101",
          repositoryFullName: "with-avalon/avalon",
          access: "read_only",
        }],
      },
    });
    expect(database.prepare(
      "SELECT action FROM audit_events WHERE target_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(CONNECTION_ID)).toEqual({ action: "connector.github_repository_access.updated" });
    // Post-cutover the object-local selection is immutable provenance: the
    // policy change does not fan out to it, and every bootstrap rechecks the
    // connector policy instead of trusting this mounted credential expiry.
    expect(workstreamObjectGet(
      objectStore,
      "SELECT read_token_expires_at FROM terminal_repository WHERE connection_id = ?",
      CONNECTION_ID,
    )).toEqual({ read_token_expires_at: Date.parse("2099-01-01T00:00:00.000Z") });
  });

  it("rejects stale revisions and repository identities absent from the current App installation", async () => {
    const database = migratedDatabase();
    await seedConnection(database);
    const service = new ConnectionService(environment(database), authorization());
    await service.updateGitHubRepositoryAccess(CONNECTION_ID, {
      expectedRevision: 0,
      mode: "all_repositories",
      defaultRemoteAccess: "read_only",
      repositories: [],
    });

    await expect(service.updateGitHubRepositoryAccess(CONNECTION_ID, {
      expectedRevision: 0,
      mode: "all_repositories",
      defaultRemoteAccess: "full_access",
      repositories: [],
    })).rejects.toMatchObject({ status: 409, code: "github_repository_access_revision_conflict" });
    await expect(service.updateGitHubRepositoryAccess(CONNECTION_ID, {
      expectedRevision: 1,
      mode: "selected_repositories",
      defaultRemoteAccess: "read_only",
      repositories: [{
        repositoryId: "999",
        repositoryFullName: "with-avalon/avalon",
        remoteAccess: "full_access",
      }],
    })).rejects.toMatchObject({ status: 422, code: "github_repository_identity_changed" });
  });

  it("updates only the repository-policy subtree when another connector field changes concurrently", async () => {
    const database = migratedDatabase();
    await seedConnection(database);
    vi.mocked(fetch).mockImplementationOnce(async () => {
      database.prepare(
        "UPDATE connector_connections SET config_json = json_set(config_json, '$.pollCursor', 'new-cursor') WHERE id = ?",
      ).run(CONNECTION_ID);
      return jsonResponse({ total_count: 0, repositories: [] });
    });
    const service = new ConnectionService(environment(database), authorization());

    await service.updateGitHubRepositoryAccess(CONNECTION_ID, {
      expectedRevision: 0,
      mode: "all_repositories",
      defaultRemoteAccess: "read_only",
      repositories: [],
    });

    expect(JSON.parse(String(database.prepare(
      "SELECT config_json FROM connector_connections WHERE id = ?",
    ).get(CONNECTION_ID)?.config_json))).toMatchObject({
      installationId: "9001",
      pollCursor: "new-cursor",
      githubRepositoryAccess: { revision: 1, defaultAccess: "read_only" },
    });
  });

  it("disables the connection every bootstrap rechecks, leaving object-local Terminal provenance untouched", async () => {
    const database = migratedDatabase();
    await seedConnection(database);
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-000000000046', '${WORKSPACE_ID}', 'Terminal',
              'Terminal', 'ad_hoc', '${USER_ID}', 'idle', '2026-01-01', '2026-01-01', '2026-01-01');
    `);
    const objectStore = selectedRepositoryObject("00000000-0000-7000-8000-000000000046");

    await new ConnectionService(environment(database), authorization()).disable(CONNECTION_ID);

    // Post-cutover, disabling no longer fans a revocation out to every
    // AgentLoopDO: the object row is immutable provenance and every
    // bootstrap rechecks the connector, which is now disabled and stripped of
    // credentials — the state that makes the selection unusable.
    expect(database.prepare(
      "SELECT status, encrypted_credentials FROM connector_connections WHERE id = ?",
    ).get(CONNECTION_ID)).toEqual({ status: "disabled", encrypted_credentials: null });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, read_token_expires_at FROM terminal_repository WHERE connection_id = ?",
      CONNECTION_ID,
    )).toEqual({ state: "selected", read_token_expires_at: Date.parse("2099-01-01T00:00:00.000Z") });
  });

  it("lets members inspect workspace policy but reserves changes for administrators", async () => {
    const database = migratedDatabase();
    await seedConnection(database);
    const service = new ConnectionService(environment(database), { ...authorization(), role: "member" });

    await expect(service.getGitHubRepositoryAccess(CONNECTION_ID)).resolves.toMatchObject({
      connectionId: CONNECTION_ID,
      mode: "all_repositories",
    });
    await expect(service.updateGitHubRepositoryAccess(CONNECTION_ID, {
      expectedRevision: 0,
      mode: "all_repositories",
      defaultRemoteAccess: "read_only",
      repositories: [],
    })).rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
  });

  it.each(["workspace", "personal"] as const)(
    "never calls GitHub for a disabled %s connection's settings",
    async (scope) => {
      const database = migratedDatabase();
      await seedConnection(database);
      database.prepare(
        "UPDATE connector_connections SET scope = ?, owner_user_id = ?, status = 'disabled' WHERE id = ?",
      ).run(scope, scope === "personal" ? USER_ID : null, CONNECTION_ID);
      const service = new ConnectionService(environment(database), authorization());
      const providerFetch = vi.mocked(fetch);
      providerFetch.mockClear();

      await expect(service.getGitHubRepositoryAccess(CONNECTION_ID)).rejects.toMatchObject({
        status: 409,
        code: "connection_disabled",
      });
      await expect(service.updateGitHubRepositoryAccess(CONNECTION_ID, {
        expectedRevision: 0,
        mode: "all_repositories",
        defaultRemoteAccess: "read_only",
        repositories: [],
      })).rejects.toMatchObject({ status: 409, code: "connection_disabled" });
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );
});

function authorization(): AuthContext {
  return {
    sessionId: "session-owner",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role: "owner",
  };
}

async function seedConnection(database: DatabaseSync): Promise<void> {
  const encrypted = await encryptString(JSON.stringify({
    installationId: "9001",
    accessToken: "github-installation-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    permissions: { contents: "write", issues: "write", pull_requests: "write" },
  }), CREDENTIALS_KEY, CONNECTION_ID);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'owner-subject', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Workspace', 'workspace', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'owner', 'active', '2026-01-01');
  `);
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, encrypted_credentials, credential_iv, credential_key_version,
      granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
      model_plugin_id)
     VALUES (?, ?, 'github', 'workspace', NULL, '9001', 'GitHub · with-avalon', ?, ?, 1,
             '["github.metadata.read","github.contents.read","github.pull_requests.write"]',
             'healthy', '{}', '{"installationId":"9001"}', '2026-01-01', '2026-01-01',
             'plugin_github_workspace')`,
  ).run(CONNECTION_ID, WORKSPACE_ID, encrypted.ciphertext, encrypted.iv);
}

function environment(database: DatabaseSync): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: CREDENTIALS_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
    GITHUB_APP_ID: "1",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
  });
}

function migratedDatabase(): DatabaseSync {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  openWorkstreamAuthorityForTest(database);
  return database;
}

/** A work stream's object carrying a selected Terminal repository. */
function selectedRepositoryObject(workstreamId: string): DatabaseSync {
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId: WORKSPACE_ID });
  workstreamObjectRun(
    objectStore,
    `INSERT INTO terminal_repository
       (id, connection_id, repository_id, repository_full_name,
        base_ref, base_sha, head_ref, state, read_token_expires_at, selected_by_user_id,
        created_at, updated_at)
     VALUES (1, ?, 101, 'with-avalon/avalon', 'main', ?,
             'avalon/bright-coastal-exact-heron', 'selected', ?, ?, ?, ?)`,
    CONNECTION_ID,
    "a".repeat(40),
    Date.parse("2099-01-01T00:00:00.000Z"),
    USER_ID,
    Date.parse("2026-01-01T00:00:00.000Z"),
    Date.parse("2026-01-01T00:00:00.000Z"),
  );
  return objectStore;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
