import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { SlackWorkspaceBotScopes } from "@rally/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { decryptString, encryptString } from "../src/lib/crypto";
import { ConnectionService } from "../src/services/connection-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestD1Results, createTestEnv } from "./helpers/cloudflare-test";
import {
  CONNECTION_WORKSPACE_OBJECT_METHODS,
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

const connectionId = "00000000-0000-7000-8000-000000000031";
const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000032");
const userId = asUserId("00000000-0000-7000-8000-000000000033");
const credentialsKey = "slack-health-refresh-test-key";
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("Slack connection health", () => {
  it("refreshes an expired rotating token before testing the connection", async () => {
    const database = migratedDatabase();
    await seedSlackConnection(database, "xoxe-valid-refresh");
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("oauth.v2.access")) {
        expect(String(init?.body)).toContain("refresh_token=xoxe-valid-refresh");
        return response({
          ok: true,
          access_token: "xoxe.xoxb-new",
          refresh_token: "xoxe-next-refresh",
          expires_in: 43_200,
          scope: SlackWorkspaceBotScopes.join(","),
        });
      }
      if (url.pathname.endsWith("auth.test")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxe.xoxb-new");
        return response({ ok: true }, { "x-oauth-scopes": SlackWorkspaceBotScopes.join(",") });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(new ConnectionService(environment(database), authorization()).test(connectionId))
      .resolves.toEqual({ ok: true, message: "Slack authorization is healthy" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const row = storedConnection(database);
    expect(row).toMatchObject({ status: "healthy", error_json: null });
    const credentials = JSON.parse(await decryptString(
      String(row.encrypted_credentials),
      String(row.credential_iv),
      credentialsKey,
      connectionId,
    )) as Record<string, unknown>;
    expect(credentials).toMatchObject({
      botAccessToken: "xoxe.xoxb-new",
      refreshToken: "xoxe-next-refresh",
      oauthScopes: [...SlackWorkspaceBotScopes].sort(),
    });
    expect(database.prepare(
      "SELECT team_id, status FROM slack_installation_routes WHERE connection_id = ?",
    ).get(connectionId)).toEqual({ team_id: "TACME", status: "active" });
  });

  it("marks the connection for reconnect when Slack rejects its refresh token", async () => {
    const database = migratedDatabase();
    await seedSlackConnection(database, "xoxe-invalid-refresh");
    vi.stubGlobal("fetch", vi.fn(async () => response({ ok: false, error: "invalid_refresh_token" })));

    await expect(new ConnectionService(environment(database), authorization()).test(connectionId))
      .resolves.toMatchObject({
        ok: false,
        message: "invalid_refresh_token",
        reconnectRequired: true,
      });

    const row = storedConnection(database) as { status: string; error_json: string };
    expect(row.status).toBe("needs_reconnect");
    expect(JSON.parse(row.error_json)).toMatchObject({ reconnectRequired: true });
  });
});

function authorization(): AuthContext {
  return {
    sessionId: "session-owner",
    userId,
    workspaceId,
    region: "global",
    role: "owner",
  };
}

async function seedSlackConnection(database: DatabaseSync, refreshToken: string): Promise<void> {
  const encrypted = await encryptString(JSON.stringify({
    botAccessToken: "xoxe.xoxb-expired",
    refreshToken,
    oauthScopes: [...SlackWorkspaceBotScopes],
    expiresAt: "2020-01-01T00:00:00.000Z",
  }), credentialsKey, connectionId);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'owner-subject', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', '${userId}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '2026-01-01');
  `);
  workspaceObjectFor(database).objectDatabase.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, encrypted_credentials, credential_iv, credential_key_version,
      granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
      model_plugin_id)
     VALUES (?, ?, 'slack', 'workspace', NULL, 'TACME', 'Slack · Acme', ?, ?, 1,
             '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
             'plugin_slack_workspace')`,
  ).run(connectionId, workspaceId, encrypted.ciphertext, encrypted.iv);
}

/**
 * The workspace object holding this suite's connection.
 *
 * `connector_connections` is WorkspaceDO's, so the refresh lease, the
 * credential settle, and the reconnect marker all land there. Seeding the row
 * regionally and reading it back would assert on a database the writes never
 * reach.
 */
const workspaceObjects = new Map<DatabaseSync, ReturnType<typeof createTestWorkspaceDO>>();

function workspaceObjectFor(database: DatabaseSync) {
  const existing = workspaceObjects.get(database);
  if (existing) return existing;
  const created = createTestWorkspaceDO({
    workspaceId,
    regionalDatabase: database,
    register: (store) => { databases.push(store); },
  });
  workspaceObjects.set(database, created);
  return created;
}

function storedConnection(database: DatabaseSync): Record<string, unknown> {
  return workspaceObjectFor(database).objectDatabase.prepare(
    `SELECT * FROM connector_connections WHERE id = ?`,
  ).get(connectionId) as Record<string, unknown>;
}

function environment(database: DatabaseSync): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    WORKSPACE_DOS: testWorkspaceObjectBinding(
      workspaceObjectFor(database).instance,
      CONNECTION_WORKSPACE_OBJECT_METHODS,
    ),
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: credentialsKey,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  });
}

function migratedDatabase(): DatabaseSync {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  return database;
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { values = next; return statement; },
      async first<T>() {
        return (database.prepare(sql).get(...values as SQLInputValue[]) as T | undefined) ?? null;
      },
      async all<T>() {
        return createTestD1Result<T>({
          success: true,
          results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        });
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as SQLInputValue[]);
        return createTestD1Result<T>({
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        });
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) results.push(await statement.run());
      return createTestD1Results<T>(results);
    },
  });
}

function response(value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}
