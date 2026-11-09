import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createApp } from "../src/app";
import { mcpRouteAllowed } from "../src/middleware/auth";
import { sha256 } from "../src/lib/crypto";
import { AuthService } from "../src/services/auth-service";
import { BrowserSessionSchema } from "../src/services/browser-session-service";
import { openEmailLoginSecret } from "../src/services/email-login-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// Rally's MCP authorization server end to end over the real migrations:
// registration, consent through the browser cookie, the PKCE code exchange,
// the MCP audience's route boundary, refresh in each direction, and
// revocation. `docs/rally-mcp.md`.

let db: DatabaseSync;
const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
const claudeRedirect = "https://claude.ai/api/mcp/auth_callback";

function bindings() {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"development",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:origin,PUBLIC_API_BASE_URL:apiOrigin,LOG_LEVEL:"error",
    SESSION_SIGNING_KEY:"mcp-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:"mcp-test-encryption-key",
    BROWSER_APP_ORIGIN:origin,MCP_RESOURCE:"https://mcp.example.test/mcp",RESEND_FROM_EMAIL:"Rally <login@example.test>",
    EMAIL_LOGIN_POLICY_JSON:JSON.stringify({ otpDigits:6,ttlSeconds:600,maxFailedAttempts:3 }) });
}

function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return createApp().request(`${apiOrigin}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }) }, bindings());
}

function browser(path: string, cookie: string, body?: unknown) {
  return call(`/browser/${path}`, body === undefined ? { headers: { origin, cookie } }
    : { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
}

function form(path: string, fields: Record<string, string>) {
  return call(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString() });
}

async function signIn() {
  const challengeId = crypto.randomUUID();
  const start = await call("/browser/email/start", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ challengeId, email: "maya@example.test" }) });
  expect(start.status).toBe(202);
  const row = db.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?").get(challengeId)!;
  const delivery = await openEmailLoginSecret(bindings(), challengeId, String(row.delivery_payload_encrypted)) as { text: string };
  const otp = /code is (\d+)\./u.exec(delivery.text)![1]!;
  const redeemed = await call("/browser/email/redeem", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ challengeId, redemptionId: crypto.randomUUID(), method: "otp", credential: otp }) });
  expect(redeemed.status).toBe(200);
  return { cookie: redeemed.headers.get("set-cookie")!.split(";")[0]!, session: BrowserSessionSchema.parse(await redeemed.json()) };
}

function organization(userId: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at)
    VALUES (?,'Acme',?,'global',?,?,?)`).run(id, id, userId, now, now);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,'member','owner','active',?)")
    .run(id, userId, now);
  return id;
}

async function register(redirectUris = [claudeRedirect]) {
  return call("/mcp-oauth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris }) });
}

/** A PKCE pair: the verifier and its S256 challenge. */
async function pkce() {
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/gu, "");
  return { verifier, challenge: await sha256(verifier) };
}

async function approve(cookie: string, clientId: string, workspaceId: string, challenge: string) {
  const response = await browser("oauth/approve", cookie, { clientId, redirectUri: claudeRedirect,
    codeChallenge: challenge, codeChallengeMethod: "S256", state: "client-state", workspaceId });
  expect(response.status).toBe(200);
  const redirect = new URL((await response.json<{ redirectUrl: string }>()).redirectUrl);
  return redirect;
}

beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close(); });

it("refuses to register a client whose redirect is neither a loopback nor a Claude or ChatGPT callback", async () => {
  const refused = await register(["https://evil.example.test/callback"]);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "invalid_client_metadata",
    error_description: "Invalid request: redirect_uris.0:custom" });
  expect((await register(["http://127.0.0.1:33418/callback"])).status).toBe(201);
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_clients").get()).toEqual({ n: 1 });
});

it("issues an MCP session through consent and a PKCE exchange that reaches only the MCP routes", async () => {
  const { cookie, session } = await signIn();
  const workspaceId = organization(session.user.id);
  const client = await (await register()).json<{ client_id: string }>();

  const description = await browser(`oauth/authorization?${new URLSearchParams({ clientId: client.client_id,
    redirectUri: claudeRedirect, codeChallenge: (await pkce()).challenge, codeChallengeMethod: "S256" })}`, cookie);
  expect(await description.json()).toEqual({ clientName: "Claude", redirectOrigin: "https://claude.ai" });

  const { verifier, challenge } = await pkce();
  const redirect = await approve(cookie, client.client_id, workspaceId, challenge);
  expect(redirect.origin + redirect.pathname).toBe(claudeRedirect);
  expect(redirect.searchParams.get("state")).toBe("client-state");
  const code = redirect.searchParams.get("code")!;

  const exchanged = await form("/mcp-oauth/token", { grant_type: "authorization_code", code, redirect_uri: claudeRedirect,
    client_id: client.client_id, code_verifier: verifier });
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json<{ access_token: string; refresh_token: string; token_type: string; scope: string }>();
  expect(tokens.token_type).toBe("Bearer");
  expect(tokens.scope).toBe("canvases");

  // The code is spent: a replay reaches nothing.
  const replay = await form("/mcp-oauth/token", { grant_type: "authorization_code", code, redirect_uri: claudeRedirect,
    client_id: client.client_id, code_verifier: verifier });
  expect(replay.status).toBe(400);
  expect((await replay.json<{ error: string }>()).error).toBe("invalid_grant");

  const bearer = { authorization: `Bearer ${tokens.access_token}` };
  const profile = await call("/workspace", { headers: bearer });
  expect(profile.status).toBe(200);
  expect((await profile.json<{ id: string }>()).id).toBe(workspaceId);
  for (const [method, path] of [["GET", "/workspace/me/timezone"], ["PATCH", "/workspace"], ["GET", "/resources"]] as const) {
    const outside = await call(path, { method, headers: { ...bearer, "content-type": "application/json" },
      ...(method === "PATCH" ? { body: JSON.stringify({ name: "Renamed" }) } : {}) });
    expect([method, path, outside.status]).toEqual([method, path, 403]);
    expect((await outside.json<{ error: { code: string } }>()).error.code).toBe("mcp_route_unavailable");
  }
  expect(db.prepare("SELECT name FROM workspaces WHERE id=?").get(workspaceId)).toEqual({ name: "Acme" });
});

it("lets an MCP token make exactly the calls the MCP server's tools make", () => {
  const id = "00000000-0000-7000-8000-000000000001";
  const allowed: Array<[string, string]> = [
    ["GET", "/canvases"], ["POST", "/canvases"], ["GET", `/canvases/${id}`], ["PATCH", `/canvases/${id}`],
    ["POST", `/canvases/${id}/audience`], ["POST", `/canvases/${id}/pin`], ["POST", `/canvases/${id}/artifacts`],
    ["POST", `/canvases/${id}/access-requests/${id}/decision`],
    ["GET", `/canvases/${id}/artifacts/${id}/versions/3/content`], ["GET", `/canvases/${id}/artifacts/${id}/versions/3/model-content`],
    ["GET", `/conversations/${id}/text`], ["POST", `/conversations/${id}/substreams/0/messages`],
    ["PATCH", `/conversations/${id}/resources/${id}`], ["POST", "/sharing"], ["GET", "/workspace"], ["GET", "/workspace/members"],
  ];
  const refused: Array<[string, string]> = [
    ["PATCH", "/workspace"], ["DELETE", `/canvases/${id}`], ["GET", "/resources"], ["POST", "/resources/upload"],
    ["POST", "/resources/resolve"], ["GET", `/resources/${id}/versions/1/content`], ["GET", `/conversations/${id}`],
    ["GET", `/conversations/${id}/substreams/0/socket`], ["POST", `/conversations/${id}/substreams/1/messages`],
    ["DELETE", `/conversations/${id}/resources/${id}`], ["GET", `/canvases/${id}/artifacts/${id}/versions/3/preview`],
    ["GET", "/workspace/me/timezone"], ["GET", "/canvases/"], ["GET", `/canvases/${id}/../workspace`],
  ];
  expect(allowed.filter(([method, path]) => !mcpRouteAllowed(method, path))).toEqual([]);
  expect(refused.filter(([method, path]) => mcpRouteAllowed(method, path))).toEqual([]);
});

it("issues tokens only for Rally's own MCP server (RFC 8707)", async () => {
  const { cookie, session } = await signIn();
  const workspaceId = organization(session.user.id);
  const client = await (await register()).json<{ client_id: string }>();
  const { verifier, challenge } = await pkce();
  const request = { clientId: client.client_id, redirectUri: claudeRedirect, codeChallenge: challenge, codeChallengeMethod: "S256" };

  const foreign = await browser(`oauth/authorization?${new URLSearchParams({ ...request, resource: "https://evil.example.test/mcp" })}`, cookie);
  expect(foreign.status).toBe(400);
  expect((await foreign.json<{ error: { code: string } }>()).error.code).toBe("mcp_oauth_invalid_target");
  const foreignApproval = await browser("oauth/approve", cookie, { ...request, resource: "https://evil.example.test/mcp", workspaceId });
  expect(foreignApproval.status).toBe(400);
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_codes").get()).toEqual({ n: 0 });

  const approved = await browser("oauth/approve", cookie, { ...request, resource: "https://mcp.example.test/mcp", workspaceId });
  expect(approved.status).toBe(200);
  const code = new URL((await approved.json<{ redirectUrl: string }>()).redirectUrl).searchParams.get("code")!;
  const exchange = { grant_type: "authorization_code", code, redirect_uri: claudeRedirect, client_id: client.client_id, code_verifier: verifier };
  const elsewhere = await form("/mcp-oauth/token", { ...exchange, resource: "https://evil.example.test/mcp" });
  expect(await elsewhere.json()).toEqual({ error: "invalid_target", error_description: "Rally issues tokens only for its own MCP server" });
  const tokens = await (await form("/mcp-oauth/token", { ...exchange, resource: "https://mcp.example.test/mcp" }))
    .json<{ refresh_token: string }>();
  const refreshElsewhere = await form("/mcp-oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token,
    client_id: client.client_id, resource: "https://evil.example.test/mcp" });
  expect((await refreshElsewhere.json<{ error: string }>()).error).toBe("invalid_target");
});

it("refuses a code that expired, or that another client or redirect presents", async () => {
  const { cookie, session } = await signIn();
  const workspaceId = organization(session.user.id);
  const client = await (await register()).json<{ client_id: string }>();
  const other = await (await register()).json<{ client_id: string }>();
  const exchange = async (overrides: Record<string, string>, expire = false) => {
    const { verifier, challenge } = await pkce();
    const code = (await approve(cookie, client.client_id, workspaceId, challenge)).searchParams.get("code")!;
    if (expire) db.prepare("UPDATE mcp_oauth_codes SET created_at='2000-01-01T00:00:00.000Z', expires_at='2000-01-01T00:10:00.000Z'").run();
    const response = await form("/mcp-oauth/token", { grant_type: "authorization_code", code, redirect_uri: claudeRedirect,
      client_id: client.client_id, code_verifier: verifier, ...overrides });
    return [response.status, (await response.json<{ error: string }>()).error];
  };
  expect(await exchange({}, true)).toEqual([400, "invalid_grant"]);
  expect(await exchange({ client_id: other.client_id })).toEqual([400, "invalid_grant"]);
  expect(await exchange({ redirect_uri: "http://127.0.0.1:9/callback" })).toEqual([400, "invalid_grant"]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_grants").get()).toEqual({ n: 0 });
});

it("asks a signed-in member of the Organization, at a redirect the client registered", async () => {
  const { cookie, session } = await signIn();
  const client = await (await register()).json<{ client_id: string }>();
  const { challenge } = await pkce();
  const request = { clientId: client.client_id, redirectUri: claudeRedirect, codeChallenge: challenge, codeChallengeMethod: "S256" };

  const signedOut = await call(`/browser/oauth/authorization?${new URLSearchParams(request)}`, { headers: { origin } });
  expect(signedOut.status).toBe(401);
  // An allowlisted callback the client never registered is never followed.
  const unregistered = await browser(`oauth/authorization?${new URLSearchParams({ ...request,
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect" })}`, cookie);
  expect(unregistered.status).toBe(400);
  expect((await unregistered.json<{ error: { code: string } }>()).error.code).toBe("mcp_oauth_invalid_redirect_uri");
  const notMine = organization(session.user.id);
  db.prepare("DELETE FROM workspace_members WHERE workspace_id=?").run(notMine);
  const elsewhere = await browser("oauth/approve", cookie, { ...request, workspaceId: notMine });
  expect(elsewhere.status).toBe(403);
  const denied = await browser("oauth/deny", cookie, { ...request, state: "client-state" });
  expect(denied.status).toBe(200);
  const redirect = new URL((await denied.json<{ redirectUrl: string }>()).redirectUrl);
  expect([redirect.origin + redirect.pathname, redirect.searchParams.get("error"), redirect.searchParams.get("state")])
    .toEqual([claudeRedirect, "access_denied", "client-state"]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_codes").get()).toEqual({ n: 0 });
});

it("refuses a code exchanged with the wrong verifier", async () => {
  const { cookie, session } = await signIn();
  const workspaceId = organization(session.user.id);
  const client = await (await register()).json<{ client_id: string }>();
  const { challenge } = await pkce();
  const code = (await approve(cookie, client.client_id, workspaceId, challenge)).searchParams.get("code")!;
  const refused = await form("/mcp-oauth/token", { grant_type: "authorization_code", code, redirect_uri: claudeRedirect,
    client_id: client.client_id, code_verifier: (await pkce()).verifier });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "invalid_grant", error_description: "The code verifier does not match the code challenge" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_grants").get()).toEqual({ n: 0 });
});

it("keeps desktop and MCP refresh tokens apart, and revokes only what the client holds", async () => {
  const { cookie, session } = await signIn();
  const workspaceId = organization(session.user.id);
  const client = await (await register()).json<{ client_id: string }>();
  const { verifier, challenge } = await pkce();
  const code = (await approve(cookie, client.client_id, workspaceId, challenge)).searchParams.get("code")!;
  const tokens = await (await form("/mcp-oauth/token", { grant_type: "authorization_code", code, redirect_uri: claudeRedirect,
    client_id: client.client_id, code_verifier: verifier })).json<{ access_token: string; refresh_token: string }>();
  const desktop = await new AuthService(bindings()).createRegionalSession(session.user.id, workspaceId);

  const desktopRefreshOfMcp = await call("/auth/refresh", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: tokens.refresh_token }) });
  expect(desktopRefreshOfMcp.status).toBe(401);
  const mcpRefreshOfDesktop = await form("/mcp-oauth/token", { grant_type: "refresh_token",
    refresh_token: desktop.refreshToken, client_id: client.client_id });
  expect((await mcpRefreshOfDesktop.json<{ error: string }>()).error).toBe("invalid_grant");
  const other = await (await register()).json<{ client_id: string }>();
  const refreshByAnother = await form("/mcp-oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token,
    client_id: other.client_id });
  expect((await refreshByAnother.json<{ error: string }>()).error).toBe("invalid_grant");
  // Another client's revocation ends nothing either.
  expect((await form("/mcp-oauth/revoke", { token: tokens.refresh_token, client_id: other.client_id })).status).toBe(200);

  const refreshed = await form("/mcp-oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token,
    client_id: client.client_id });
  expect(refreshed.status).toBe(200);
  const rotated = await refreshed.json<{ access_token: string; refresh_token: string }>();
  expect((await call("/workspace", { headers: { authorization: `Bearer ${rotated.access_token}` } })).status).toBe(200);

  // A desktop token posted to the MCP revocation endpoint ends nothing.
  expect((await form("/mcp-oauth/revoke", { token: desktop.refreshToken, client_id: client.client_id })).status).toBe(200);
  expect((await call("/workspace", { headers: { authorization: `Bearer ${desktop.accessToken}` } })).status).toBe(200);

  expect((await form("/mcp-oauth/revoke", { token: rotated.refresh_token, client_id: client.client_id })).status).toBe(200);
  const revoked = await call("/workspace", { headers: { authorization: `Bearer ${rotated.access_token}` } });
  expect(revoked.status).toBe(401);
});
