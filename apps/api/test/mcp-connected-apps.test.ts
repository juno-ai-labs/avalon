import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createApp } from "../src/app";
import { sha256 } from "../src/lib/crypto";
import { AuthService } from "../src/services/auth-service";
import { BrowserSessionSchema } from "../src/services/browser-session-service";
import { openEmailLoginSecret } from "../src/services/email-login-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// Settings › Account › Connected apps over the real migrations: a person
// lists the MCP apps they connected and disconnects one, and nobody else can
// do either for them. `docs/rally-mcp.md`.

let db: DatabaseSync;
const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
const claudeRedirect = "https://claude.ai/api/mcp/auth_callback";
const loopbackRedirect = "http://127.0.0.1:33418/callback";

function bindings() {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"development",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:origin,PUBLIC_API_BASE_URL:apiOrigin,LOG_LEVEL:"error",
    SESSION_SIGNING_KEY:"mcp-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:"mcp-test-encryption-key",
    BROWSER_APP_ORIGIN:origin,MCP_RESOURCE:"https://mcp.example.test/mcp",EMAIL_FROM:"Rally <login@example.test>",
    EMAIL_LOGIN_POLICY_JSON:JSON.stringify({ otpDigits:6,ttlSeconds:600,maxFailedAttempts:3 }) });
}

function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return createApp().request(`${apiOrigin}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }) }, bindings());
}

function form(path: string, fields: Record<string, string>) {
  return call(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString() });
}

async function signIn(email: string) {
  const challengeId = crypto.randomUUID();
  const start = await call("/browser/email/start", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ challengeId, email }) });
  expect(start.status).toBe(202);
  const row = db.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?").get(challengeId)!;
  const delivery = await openEmailLoginSecret(bindings(), challengeId, String(row.delivery_payload_encrypted)) as { text: string };
  const otp = /code is (\d+)\./u.exec(delivery.text)![1]!;
  const redeemed = await call("/browser/email/redeem", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ challengeId, redemptionId: crypto.randomUUID(), method: "otp", credential: otp }) });
  expect(redeemed.status).toBe(200);
  return { cookie: redeemed.headers.get("set-cookie")!.split(";")[0]!, userId: BrowserSessionSchema.parse(await redeemed.json()).user.id };
}

function organization(name: string, ...userIds: string[]) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,'global',?,?,?)`).run(id, name, id, userIds[0]!, now, now);
  for (const userId of userIds) {
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,'member','owner','active',?)")
      .run(id, userId, now);
  }
  return id;
}

/** One app connected the whole way through: registration, consent, and the PKCE exchange. */
async function connect(cookie: string, workspaceId: string, clientName: string, redirectUris: string[]) {
  const client = await (await call("/mcp-oauth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris }) })).json<{ client_id: string }>();
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/gu, "");
  const redirectUri = redirectUris[0]!;
  const approved = await call("/browser/oauth/approve", { method: "POST", headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ clientId: client.client_id, redirectUri, codeChallenge: await sha256(verifier),
      codeChallengeMethod: "S256", workspaceId }) });
  expect(approved.status).toBe(200);
  const code = new URL((await approved.json<{ redirectUrl: string }>()).redirectUrl).searchParams.get("code")!;
  const exchanged = await form("/mcp-oauth/token", { grant_type: "authorization_code", code, redirect_uri: redirectUri,
    client_id: client.client_id, code_verifier: verifier });
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json<{ access_token: string; refresh_token: string }>();
  const grant = db.prepare("SELECT session_id FROM mcp_oauth_grants WHERE client_id=?").get(client.client_id)!;
  return { clientId: client.client_id, grantId: String(grant.session_id), ...tokens };
}

/** A desktop session, which no client holds: what the person's Mac signs in with. */
async function desktopSession(userId: string, workspaceId: string) {
  const session = await new AuthService(bindings()).createRegionalSession(userId, workspaceId);
  const row = db.prepare("SELECT id FROM sessions WHERE refresh_token_hash=?").get(await sha256(session.refreshToken))!;
  return { ...session, sessionId: String(row.id) };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function listed(token: string) {
  const response = await call("/workspace/me/connected-apps", { headers: bearer(token) });
  expect(response.status).toBe(200);
  return (await response.json<{ apps: Array<{ id: string; clientName: string }> }>()).apps;
}

beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close(); });

it("lists the person's own live grants across their Organizations, and never a desktop session", async () => {
  const maya = await signIn("maya@example.test");
  const theo = await signIn("theo@example.test");
  const acme = organization("Acme", maya.userId, theo.userId);
  const globex = organization("Globex", maya.userId);
  const claude = await connect(maya.cookie, acme, "Claude", [claudeRedirect, "https://claude.com/api/mcp/auth_callback"]);
  db.prepare("UPDATE mcp_oauth_grants SET created_at='2026-11-01T10:00:00.000Z' WHERE session_id=?").run(claude.grantId);
  const code = await connect(maya.cookie, globex, "Claude Code", [loopbackRedirect]);
  db.prepare("UPDATE mcp_oauth_grants SET created_at='2026-11-02T10:00:00.000Z' WHERE session_id=?").run(code.grantId);
  db.prepare("UPDATE sessions SET refresh_rotated_at='2026-11-03T10:00:00.000Z' WHERE id=?").run(code.grantId);
  await connect(theo.cookie, acme, "ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"]);
  const ended = await connect(maya.cookie, acme, "Revoked client", [claudeRedirect]);
  expect((await form("/mcp-oauth/revoke", { token: ended.refresh_token, client_id: ended.clientId })).status).toBe(200);
  const desktop = await desktopSession(maya.userId, acme);

  const response = await call("/workspace/me/connected-apps", { headers: bearer(desktop.accessToken) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ apps: [
    { id: code.grantId, clientName: "Claude Code", redirectOrigins: [], loopback: true, workspaceId: globex,
      workspaceName: "Globex", connectedAt: "2026-11-02T10:00:00.000Z", lastActiveAt: "2026-11-03T10:00:00.000Z" },
    { id: claude.grantId, clientName: "Claude", redirectOrigins: ["https://claude.ai", "https://claude.com"], loopback: false,
      workspaceId: acme, workspaceName: "Acme", connectedAt: "2026-11-01T10:00:00.000Z", lastActiveAt: "2026-11-01T10:00:00.000Z" },
  ] });

  // The person's own browser reaches the same list through its cookie, and
  // its own Organization session is not a connected app either.
  const selected = await call("/browser/workspace/select", { method: "POST", headers: { origin, cookie: maya.cookie,
    "content-type": "application/json" }, body: JSON.stringify({ workspaceId: acme }) });
  expect(selected.status).toBe(200);
  const throughBrowser = await call(`/browser/api/${acme}/workspace/me/connected-apps`, { headers: { origin, cookie: maya.cookie } });
  expect(throughBrowser.status).toBe(200);
  expect((await throughBrowser.json<{ apps: Array<{ id: string }> }>()).apps.map((app) => app.id)).toEqual([code.grantId, claude.grantId]);

  // An Organization the person left lists nothing of theirs.
  db.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").run(globex, maya.userId);
  expect((await listed(desktop.accessToken)).map((app) => app.id)).toEqual([claude.grantId]);
});

it("ends a grant the person disconnects, so its tokens are refused afterwards", async () => {
  const maya = await signIn("maya@example.test");
  const acme = organization("Acme", maya.userId);
  const claude = await connect(maya.cookie, acme, "Claude", [claudeRedirect]);
  const desktop = await desktopSession(maya.userId, acme);
  expect((await call("/workspace", { headers: bearer(claude.access_token) })).status).toBe(200);

  const disconnected = await call(`/workspace/me/connected-apps/${claude.grantId}`, { method: "DELETE", headers: bearer(desktop.accessToken) });
  expect(disconnected.status).toBe(204);

  const refused = await call("/workspace", { headers: bearer(claude.access_token) });
  expect(refused.status).toBe(401);
  expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("session_revoked");
  const refresh = await form("/mcp-oauth/token", { grant_type: "refresh_token", refresh_token: claude.refresh_token, client_id: claude.clientId });
  expect((await refresh.json<{ error: string }>()).error).toBe("invalid_grant");
  expect(await listed(desktop.accessToken)).toEqual([]);
  // Disconnecting it again, from a second window, is not an error.
  expect((await call(`/workspace/me/connected-apps/${claude.grantId}`, { method: "DELETE", headers: bearer(desktop.accessToken) })).status).toBe(204);
});

it("neither lists nor disconnects another person's grant, nor ends a desktop session", async () => {
  const maya = await signIn("maya@example.test");
  const theo = await signIn("theo@example.test");
  const acme = organization("Acme", maya.userId, theo.userId);
  const mayas = await connect(maya.cookie, acme, "Claude", [claudeRedirect]);
  const theoDesktop = await desktopSession(theo.userId, acme);
  const mayaDesktop = await desktopSession(maya.userId, acme);

  expect(await listed(theoDesktop.accessToken)).toEqual([]);
  for (const target of [mayas.grantId, mayaDesktop.sessionId]) {
    const refused = await call(`/workspace/me/connected-apps/${target}`, { method: "DELETE", headers: bearer(theoDesktop.accessToken) });
    expect([target, refused.status]).toEqual([target, 404]);
    expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("connected_app_not_found");
  }
  // Nor is the person's own desktop session a connected app to end.
  const ownDesktop = await call(`/workspace/me/connected-apps/${mayaDesktop.sessionId}`, { method: "DELETE", headers: bearer(mayaDesktop.accessToken) });
  expect(ownDesktop.status).toBe(404);
  expect((await call("/workspace", { headers: bearer(mayas.access_token) })).status).toBe(200);
  expect((await call("/workspace", { headers: bearer(mayaDesktop.accessToken) })).status).toBe(200);
});

it("keeps an MCP client out of the list and the disconnect", async () => {
  const maya = await signIn("maya@example.test");
  const acme = organization("Acme", maya.userId);
  const claude = await connect(maya.cookie, acme, "Claude", [claudeRedirect]);
  const other = await connect(maya.cookie, acme, "ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"]);
  for (const [method, path] of [["GET", "/workspace/me/connected-apps"], ["DELETE", `/workspace/me/connected-apps/${other.grantId}`]] as const) {
    const refused = await call(path, { method, headers: bearer(claude.access_token) });
    expect([method, refused.status]).toEqual([method, 403]);
    expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("mcp_route_unavailable");
  }
  expect((await call("/workspace", { headers: bearer(other.access_token) })).status).toBe(200);
});
