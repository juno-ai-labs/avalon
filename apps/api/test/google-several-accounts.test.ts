import { asUserId, asWorkspaceId, GOOGLE_DRIVE_CAPABILITIES, GOOGLE_MAIL_CALENDAR_CAPABILITIES } from "@rally/contracts";
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
// Google's external endpoints and the WorkspaceDO transport use test doubles.
function fixture() {
  const regional = migratedSqliteDatabase();
  databases.push(regional);
  const at = new Date().toISOString();
  regional.prepare(`INSERT INTO users
    (id, google_subject, email, name, created_at, updated_at)
    VALUES (?, 'google-accounts-test', 'google@example.test', 'Google Accounts Test', ?, ?)`)
    .run(USER_ID, at, at);
  regional.prepare(`INSERT INTO workspaces
    (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Google Accounts Test', 'google-accounts-test', 'global', ?, ?, ?)`)
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
    OAUTH_STATE_ENCRYPTION_KEY: "google-accounts-test-state-key",
    CONNECTOR_CREDENTIALS_KEY: "google-accounts-test-credentials-key",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-connector-client",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-connector-secret",
    WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, [
      "startConnectorOAuthAttempt",
      "abandonConnectorOAuthAttempt",
      "finishConnectorOAuthAttempt",
      "connectorOAuthAttempt",
      "executeRuntimeSql",
      "publishSync",
      "refreshSchedule",
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

/**
 * Signs in to Google as `subject` and returns the connection the callback
 * stored. Google's token and identity endpoints are doubles; the token grants
 * whatever scopes the authorization asked for.
 */
async function connectGoogle(
  { env, auth }: ReturnType<typeof fixture>,
  subject: string,
  capabilities: readonly string[],
): Promise<{ connectionId: string; prompt: string | null }> {
  let requestedScopes = "";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: `access-${subject}`, refresh_token: `refresh-${subject}`, expires_in: 3600, scope: requestedScopes });
    }
    if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({ sub: subject, email: `${subject}@example.test`, email_verified: true, name: subject });
    }
    throw new Error(`Unexpected request: ${url.origin}${url.pathname}`);
  }));
  const started = await new ConnectionService(env, auth).beginGoogle({
    scope: "personal",
    capabilities: [...capabilities],
    desktopHandoffVersion: 2,
  });
  const authorization = new URL(started.url);
  requestedScopes = authorization.searchParams.get("scope") ?? "";
  const target = new URL(await new ConnectionService(env).completeGoogle(
    "google-authorization-code", authorization.searchParams.get("state")!,
  ));
  expect(target.searchParams.get("status")).toBe("connected");
  const attempt = await new ConnectionService(env, auth).getOAuthAttempt(started.attemptId);
  return { connectionId: attempt.connectionId!, prompt: authorization.searchParams.get("prompt") };
}

describe("several Google accounts for one person", () => {
  it("adds each new account as its own connection and reconnects one already connected for the same product", async () => {
    const context = fixture();
    const inboxA = await connectGoogle(context, "account-a", GOOGLE_MAIL_CALENDAR_CAPABILITIES);
    // Google asks which account every time, so a person can pick inbox B.
    expect(inboxA.prompt).toBe("select_account consent");
    const inboxB = await connectGoogle(context, "account-b", GOOGLE_MAIL_CALENDAR_CAPABILITIES);
    expect(inboxB.connectionId).not.toBe(inboxA.connectionId);
    // Signing in with A again from "Add another account" is A, not a third inbox.
    const inboxAAgain = await connectGoogle(context, "account-a", GOOGLE_MAIL_CALENDAR_CAPABILITIES);
    expect(inboxAAgain.connectionId).toBe(inboxA.connectionId);
    // The same account's Drive is a different product, so it is its own connection.
    const driveA = await connectGoogle(context, "account-a", GOOGLE_DRIVE_CAPABILITIES);
    expect(driveA.connectionId).not.toBe(inboxA.connectionId);
    expect(context.object.prepare(`SELECT provider_account_id, status FROM connector_connections
      WHERE connector_type = 'google' ORDER BY created_at, provider_account_id`).all()).toEqual([
      { provider_account_id: "account-a", status: "healthy" },
      { provider_account_id: "account-b", status: "healthy" },
      { provider_account_id: "account-a", status: "healthy" },
    ]);
  });

  it("leaves a connection holding both products alone when the same account signs in for one of them", async () => {
    const context = fixture();
    const both = await connectGoogle(context, "account-c", [...GOOGLE_MAIL_CALENDAR_CAPABILITIES, ...GOOGLE_DRIVE_CAPABILITIES]);
    const driveOnly = await connectGoogle(context, "account-c", GOOGLE_DRIVE_CAPABILITIES);
    expect(driveOnly.connectionId).not.toBe(both.connectionId);
    const kept = context.object.prepare("SELECT granted_scopes_json FROM connector_connections WHERE id = ?")
      .get(both.connectionId) as { granted_scopes_json: string };
    expect(JSON.parse(kept.granted_scopes_json)).toEqual(expect.arrayContaining([...GOOGLE_MAIL_CALENDAR_CAPABILITIES]));
  });
});
