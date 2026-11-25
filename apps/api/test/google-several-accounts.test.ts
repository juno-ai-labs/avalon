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
 * Starts a Google sign-in, answers Google's token and identity endpoints as
 * `subject` (granting whatever scopes the authorization asked for), and runs
 * the callback. Resolves with the connection it stored and the authorization
 * URL, or rejects as the callback does.
 */
async function signIn(
  { env, auth }: ReturnType<typeof fixture>,
  subject: string,
  capabilities: readonly string[],
  options: { scope?: "personal" | "workspace"; connectionId?: string } = {},
): Promise<{ connectionId: string; authorization: URL }> {
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
    scope: options.scope ?? "personal",
    capabilities: [...capabilities],
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    desktopHandoffVersion: 2,
  });
  const authorization = new URL(started.url);
  requestedScopes = authorization.searchParams.get("scope") ?? "";
  const target = new URL(await new ConnectionService(env).completeGoogle(
    "google-authorization-code", authorization.searchParams.get("state")!,
  ));
  expect(target.searchParams.get("status")).toBe("connected");
  const attempt = await new ConnectionService(env, auth).getOAuthAttempt(started.attemptId);
  return { connectionId: attempt.connectionId!, authorization };
}

const MAIL = GOOGLE_MAIL_CALENDAR_CAPABILITIES;
const DRIVE = GOOGLE_DRIVE_CAPABILITIES;

function connection(context: ReturnType<typeof fixture>, id: string) {
  return context.object.prepare("SELECT provider_account_id, status, granted_scopes_json FROM connector_connections WHERE id = ?")
    .get(id) as { provider_account_id: string; status: string; granted_scopes_json: string };
}

describe("several Google accounts for one person", () => {
  it("adds a second account as its own connection", async () => {
    const context = fixture();
    const a = await signIn(context, "account-a", MAIL);
    const b = await signIn(context, "account-b", MAIL);
    expect(b.connectionId).not.toBe(a.connectionId);
    expect(connection(context, b.connectionId)).toMatchObject({ provider_account_id: "account-b", status: "healthy" });
  });

  it("reconnects an account that signs in again instead of adding it twice", async () => {
    const context = fixture();
    const a = await signIn(context, "account-a", MAIL);
    context.object.prepare("UPDATE connector_connections SET status = 'needs_reconnect' WHERE id = ?").run(a.connectionId);
    const again = await signIn(context, "account-a", MAIL);
    expect(again.connectionId).toBe(a.connectionId);
    expect(connection(context, a.connectionId).status).toBe("healthy");
  });

  it("gives the same account's Drive its own connection", async () => {
    const context = fixture();
    const mail = await signIn(context, "account-a", MAIL);
    const drive = await signIn(context, "account-a", DRIVE);
    expect(drive.connectionId).not.toBe(mail.connectionId);
  });

  it("leaves a connection holding both products alone when the same account signs in for one of them", async () => {
    const context = fixture();
    const both = await signIn(context, "account-c", [...MAIL, ...DRIVE]);
    const driveOnly = await signIn(context, "account-c", DRIVE);
    expect(driveOnly.connectionId).not.toBe(both.connectionId);
    expect(JSON.parse(connection(context, both.connectionId).granted_scopes_json)).toEqual(expect.arrayContaining([...MAIL]));
  });

  it("widens a connection when the same account signs in for more products than it holds", async () => {
    const context = fixture();
    const mail = await signIn(context, "account-d", MAIL);
    const both = await signIn(context, "account-d", [...MAIL, ...DRIVE]);
    expect(both.connectionId).toBe(mail.connectionId);
  });

  it("adds a new connection for an account whose old one was disconnected", async () => {
    const context = fixture();
    const a = await signIn(context, "account-a", MAIL);
    context.object.prepare("UPDATE connector_connections SET status = 'disabled' WHERE id = ?").run(a.connectionId);
    const again = await signIn(context, "account-a", MAIL);
    expect(again.connectionId).not.toBe(a.connectionId);
  });

  it("keeps the Organization's connection apart from the same account's personal one", async () => {
    const context = fixture();
    const organization = await signIn(context, "account-a", DRIVE, { scope: "workspace" });
    const personal = await signIn(context, "account-a", DRIVE);
    expect(personal.connectionId).not.toBe(organization.connectionId);
  });

  it("refuses a reconnect of one account signed in as another, and names the account it expects", async () => {
    const context = fixture();
    const a = await signIn(context, "account-a", MAIL);
    const b = await signIn(context, "account-b", MAIL);
    await expect(signIn(context, "account-a", MAIL, { connectionId: b.connectionId }))
      .rejects.toMatchObject({ code: "google_account_mismatch" });
    expect(connection(context, a.connectionId).provider_account_id).toBe("account-a");
    expect(connection(context, b.connectionId).provider_account_id).toBe("account-b");
    // A reconnect asks Google to preselect the account it is for.
    const { env, auth } = context;
    const started = await new ConnectionService(env, auth).beginGoogle({
      scope: "personal", capabilities: [...MAIL], connectionId: b.connectionId, desktopHandoffVersion: 2,
    });
    expect(new URL(started.url).searchParams.get("login_hint")).toBe("account-b");
  });
});
