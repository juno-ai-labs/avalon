import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AuthContext, Env } from "../src/env";
import { ConnectionService } from "../src/services/connection-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";

/**
 * A connector authorization's callback only holds the provider's answer; the
 * session that started it has to claim it (`docs/connectors.md`, "Claiming a
 * connector authorization"). These run the real callback route and the real
 * claim against the checked-in migrations, with only the provider doubled.
 */

const OWNER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const OTHER_ID = asUserId("00000000-0000-4000-8000-000000000002");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000003");

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

function fixture(): { regional: DatabaseSync; object: DatabaseSync; env: Env; owner: AuthContext; other: AuthContext } {
  const regional = migratedSqliteDatabase();
  databases.push(regional);
  const at = "2026-11-16T00:00:00.000Z";
  const insertUser = regional.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insertUser.run(OWNER_ID, "claim-owner", "owner@example.test", "Owner", at, at);
  insertUser.run(OTHER_ID, "claim-other", "other@example.test", "Other", at, at);
  regional.prepare(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Claims', 'claims', 'global', ?, ?, ?)`).run(WORKSPACE_ID, OWNER_ID, at, at);
  const insertMember = regional.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (?, ?, ?, 'active', ?)`);
  insertMember.run(WORKSPACE_ID, OWNER_ID, "owner", at);
  insertMember.run(WORKSPACE_ID, OTHER_ID, "member", at);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  const auth = (userId: typeof OWNER_ID, role: AuthContext["role"]): AuthContext =>
    ({ sessionId: `session-${userId}`, userId, workspaceId: WORKSPACE_ID, region: "global", role });
  return {
    regional,
    object: workspace.objectDatabase,
    owner: auth(OWNER_ID, "owner"),
    other: auth(OTHER_ID, "member"),
    env: createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      LOG_LEVEL: "error",
      ALLOWED_ORIGINS: "app://rally",
      PUBLIC_API_BASE_URL: "https://api.rallywith.ai",
      PUBLIC_WEB_BASE_URL: "https://rallywith.ai",
      DESKTOP_DEEP_LINK_URI: "rallywithai://auth/complete",
      BROWSER_APP_ORIGIN: "https://app.rallywith.ai",
      OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
      CONNECTOR_CREDENTIALS_KEY: "test-connector-credentials-key",
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, [
        "startConnectorOAuthAttempt",
        "abandonConnectorOAuthAttempt",
        "extendConnectorOAuthAttempt",
        "finishConnectorOAuthAttempt",
        "connectorOAuthAttempt",
        "bindConnectorOAuthAttemptTelemetry",
        "executeRuntimeSql",
      ]),
    }),
  };
}

/** Apollo's hosted MCP authorization server; records every code it is asked to exchange. */
function stubApollo(): string[] {
  const exchanged: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.apollo.io/mcp", authorization_servers: ["https://mcp.apollo.io"], scopes_supported: ["read_user_profile"] });
    if (url.includes("oauth-authorization-server")) return Response.json({ authorization_endpoint: "https://mcp.apollo.io/authorize", token_endpoint: "https://mcp.apollo.io/token", registration_endpoint: "https://mcp.apollo.io/register", code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.endsWith("/register")) return Response.json({ client_id: "apollo-fixture-client", token_endpoint_auth_method: "none" });
    if (url.endsWith("/token")) {
      exchanged.push(new URLSearchParams(String(init?.body ?? "")).get("code") ?? "");
      return Response.json({ access_token: "apollo-access", refresh_token: "apollo-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  });
  return exchanged;
}

/** Start as `auth`, then answer the provider's redirect the way a browser would. */
async function consent(env: Env, auth: AuthContext, code: string): Promise<{ attemptId: string; target: URL }> {
  const started = await new ConnectionService(env, auth).beginProvider("apollo", {
    scope: "personal", capabilities: ["apollo.personal.mcp"], desktopHandoffVersion: 2,
  });
  const state = new URL(started.url).searchParams.get("state")!;
  const response = await createApp().request(
    `https://api.rallywith.ai/connections/apollo/callback?code=${code}&state=${encodeURIComponent(state)}`,
    undefined,
    env,
  );
  expect(response.status).toBe(302);
  const handoff = new URL(response.headers.get("location")!);
  return { attemptId: started.attemptId, target: new URL(new URLSearchParams(handoff.hash.slice(1)).get("target")!) };
}

function connections(object: DatabaseSync): unknown[] {
  return object.prepare("SELECT owner_user_id FROM connector_connections WHERE connector_type = 'apollo'").all();
}

describe("claiming a connector authorization", () => {
  it("attaches the account only once the session that started it claims the callback", async () => {
    const { env, object, owner } = fixture();
    const exchanged = stubApollo();
    const { attemptId, target } = await consent(env, owner, "owner-code");

    expect(target.searchParams.get("status")).toBe("authorized");
    expect(exchanged).toEqual([]);
    expect(connections(object)).toEqual([]);

    const service = new ConnectionService(env, owner);
    const completed = new URL(await service.completeClaimedCallback(
      await service.claimCallback(target.searchParams.get("ticket")!),
    ));
    expect(completed.searchParams.get("status")).toBe("connected");
    expect(exchanged).toEqual(["owner-code"]);
    expect(connections(object)).toEqual([{ owner_user_id: OWNER_ID }]);
    expect(await service.getOAuthAttempt(attemptId)).toMatchObject({ status: "succeeded" });
  });

  it("refuses another account's claim and never exchanges the code it held", async () => {
    const { env, object, owner, other, regional } = fixture();
    const exchanged = stubApollo();
    // The owner started this and sent the consent page on; the other person
    // consented, so the ticket landed in the other person's client.
    const { attemptId, target } = await consent(env, owner, "other-persons-code");
    const ticket = target.searchParams.get("ticket")!;

    await expect(new ConnectionService(env, other).claimCallback(ticket))
      .rejects.toMatchObject({ status: 403, code: "connector_oauth_account_mismatch" });
    expect(regional.prepare("SELECT consumed_at IS NOT NULL AS consumed FROM oauth_states").all()).toEqual([{ consumed: 1 }]);
    // The starter cannot claim it afterwards either: the state is spent.
    await expect(new ConnectionService(env, owner).claimCallback(ticket))
      .rejects.toMatchObject({ status: 401, code: "invalid_oauth_state" });
    expect(exchanged).toEqual([]);
    expect(connections(object)).toEqual([]);
    expect(await new ConnectionService(env, owner).getOAuthAttempt(attemptId))
      .toMatchObject({ status: "failed", errorCode: "connector_oauth_account_mismatch" });
  });

  it("holds a state's callback once", async () => {
    const { env, owner } = fixture();
    stubApollo();
    const started = await new ConnectionService(env, owner).beginProvider("apollo", {
      scope: "personal", capabilities: ["apollo.personal.mcp"], desktopHandoffVersion: 2,
    });
    const state = new URL(started.url).searchParams.get("state")!;
    await new ConnectionService(env).holdCallback("apollo", state, { code: "first" });
    await expect(new ConnectionService(env).holdCallback("apollo", state, { code: "second" }))
      .rejects.toMatchObject({ status: 401, code: "invalid_oauth_state" });
  });
});
