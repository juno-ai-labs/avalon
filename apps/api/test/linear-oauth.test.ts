import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../src/env";
import { ConnectionService } from "../src/services/connection-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000002");
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

// This covers the service/adapter input contract against the checked-in SQL
// schemas. It does not assert workerd transaction, alarm, or RPC semantics;
// Linear's external endpoints and the WorkspaceDO transport use test doubles.
function fixture() {
  const regional = migratedSqliteDatabase();
  databases.push(regional);
  const at = new Date().toISOString();
  regional.prepare(`INSERT INTO users
    (id, google_subject, email, name, created_at, updated_at)
    VALUES (?, 'linear-test', 'linear@example.test', 'Linear Test', ?, ?)`)
    .run(USER_ID, at, at);
  regional.prepare(`INSERT INTO workspaces
    (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Linear Test', 'linear-test', 'global', ?, ?, ?)`)
    .run(WORKSPACE_ID, USER_ID, at, at);
  regional.prepare(`INSERT INTO workspace_members
    (workspace_id, user_id, role, status, joined_at)
    VALUES (?, ?, 'owner', 'active', ?)`)
    .run(WORKSPACE_ID, USER_ID, at);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (database) => { databases.push(database); },
  });
  const env = createTestEnv({
    DB: sqliteD1(regional),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_API_BASE_URL: "https://api.rallywith.ai",
    DESKTOP_DEEP_LINK_URI: "rallywithai://auth/complete",
    OAUTH_STATE_ENCRYPTION_KEY: "linear-test-state-key",
    CONNECTOR_CREDENTIALS_KEY: "linear-test-credentials-key",
    LINEAR_OAUTH_CLIENT_ID: "linear-client",
    LINEAR_OAUTH_CLIENT_SECRET: "linear-secret",
    WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, [
      "startConnectorOAuthAttempt",
      "abandonConnectorOAuthAttempt",
      "finishConnectorOAuthAttempt",
      "connectorOAuthAttempt",
      "executeRuntimeSql",
      "publishSync",
    ]),
  });
  const auth: AuthContext = {
    sessionId: "session",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role: "owner",
  };
  return { env, auth, regional, object: workspace.objectDatabase };
}

describe("Linear OAuth service", () => {
  it.each(["personal", "workspace"] as const)(
    "completes %s consent through the shared callback and stores a usable connection",
    async (scope) => {
      const { env, auth, object, regional } = fixture();
      const actorId = scope === "workspace" ? "linear-app-user" : "linear-human-user";
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.href === "https://api.linear.app/oauth/token") {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("code")).toBe("linear-authorization-code");
          expect(body.get("code_verifier")).toBeTruthy();
          return Response.json({
            access_token: "linear-access-token",
            refresh_token: "linear-refresh-token",
            expires_in: 3600,
            scope: "read",
          });
        }
        if (url.href === "https://api.linear.app/graphql") {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer linear-access-token");
          return Response.json({ data: { viewer: {
            id: actorId,
            name: "Linear Test",
            app: scope === "workspace",
            organization: { id: "linear-organization", name: "Test Organization", urlKey: "test-org" },
          } } });
        }
        throw new Error(`Unexpected request: ${url.origin}${url.pathname}`);
      }));
      const started = await new ConnectionService(env, auth).beginProvider("linear", {
        scope,
        capabilities: ["linear.read"],
        desktopHandoffVersion: 2,
      });
      const authorization = new URL(started.url);
      expect(authorization.searchParams.get("actor")).toBe(scope === "workspace" ? "app" : "user");

      const target = new URL(await new ConnectionService(env).completeProvider(
        "linear", "linear-authorization-code", authorization.searchParams.get("state")!,
      ));

      expect(target.searchParams.get("status")).toBe("connected");
      const attempt = await new ConnectionService(env, auth).getOAuthAttempt(started.attemptId);
      expect(attempt).toMatchObject({ status: "succeeded", errorCode: null });
      expect(object.prepare(`SELECT scope, owner_user_id, provider_account_id, status,
        encrypted_credentials IS NOT NULL AS has_credentials
        FROM connector_connections WHERE id = ?`).get(attempt.connectionId!)).toEqual({
        scope,
        owner_user_id: scope === "personal" ? USER_ID : null,
        provider_account_id: "linear-organization",
        status: "healthy",
        has_credentials: 1,
      });
      expect(regional.prepare(`SELECT organization_id, status
        FROM linear_organization_routes WHERE connection_id = ?`).get(attempt.connectionId!))
        .toEqual({ organization_id: "linear-organization", status: "active" });
    },
  );
});
