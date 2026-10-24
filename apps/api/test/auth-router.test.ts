import { SignJWT } from "jose";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { HonoAppEnv } from "../src/env";
import { SessionSchema, WorkspaceMemberSchema } from "@rally/contracts";
import { RegionalOnboardingService } from "../src/services/platform-onboarding-service";
import { AuthService } from "../src/services/auth-service";
import { sha256 } from "../src/lib/crypto";
import { requireAuth } from "../src/middleware/auth";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const userId = "00000000-0000-7000-8000-000000000001";
const workspaceId = "00000000-0000-7000-8000-000000000002";
const sessionId = "00000000-0000-7000-8000-000000000003";
const signingKey = "session-signing-key-for-tests-only-long-enough";
const at = "2026-08-20T12:00:00.000Z";

let database: DatabaseSync;

function env() {
  return createTestEnv({
    DB: sqliteD1(database),
    ALLOWED_ORIGINS: "app://rallywithai",
    AVALON_REGION: "global",
    APP_ENV: "production",
    RALLY_DEV_AUTH: "false",
    SESSION_SIGNING_KEY: signingKey,
    LOG_LEVEL: "error",
  });
}

async function bearer(): Promise<string> {
  return new SignJWT({ sid: sessionId, wid: workspaceId, region: "global" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer("avalon-api")
    .setAudience("avalon-desktop")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(signingKey));
}

beforeEach(() => {
  database = migratedSqliteDatabase();
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'google-subject', ?, 'Member', ?, ?)`,
  ).run(userId, "member@example.com", at, at);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon', 'avalon', 'global', ?, ?, ?)`,
  ).run(workspaceId, userId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(workspaceId, userId, at);
  database.prepare(
    `INSERT INTO sessions
       (id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, 'global', 'hash', '2099-01-01T00:00:00.000Z', ?)`,
  ).run(sessionId, userId, workspaceId, at);
});

afterEach(() => { database.close(); });

describe("authentication in the complete application router", () => {
  // Activation of a guest relationship is proved across deployments in browser-regions.test.ts.
  it("offers a guest relationship to desktop discovery as a guest", async () => {
    const service = new RegionalOnboardingService(env());
    const identity = { platformUserId: userId, loginIdentities: [{ provider: "google", subject: "google-subject" }],
      email: "member@example.com", name: "Member", avatarUrl: null,
      timezone: "UTC", createdAt: at };
    expect((await service.discover(identity)).workspaces.map((workspace) => workspace.id)).toContain(workspaceId);
    database.prepare("UPDATE workspace_members SET access_class = 'guest', role = NULL WHERE user_id = ?").run(userId);
    expect((await service.discover(identity)).workspaces.map((workspace) => [workspace.id, workspace.role, workspace.accessClass]))
      .toEqual([[workspaceId, null, "guest"]]);
  });

  it("serializes a guest in the ordinary workspace member directory", async () => {
    const guestId = "00000000-0000-7000-8000-000000000004";
    database.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?, 'guest@example.com','Guest',?,?)").run(guestId,at,at);
    database.prepare("INSERT INTO workspace_members (workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,'guest',NULL,'active',?)")
      .run(workspaceId,guestId,at);
    const result = await createApp().request("/workspace/members",{ headers:{ authorization:`Bearer ${await bearer()}` } },env());
    expect(result.status).toBe(200);
    const body = await result.json() as { items:unknown[] };
    const members = body.items.map((item) => WorkspaceMemberSchema.parse(item));
    expect(members.find((member) => member.user.id === guestId)).toMatchObject({ accessClass:"guest",role:null });
    expect(members.find((member) => member.user.id === userId)).toMatchObject({ role:"owner" });
  });

  it("saves a timezone chosen in Settings and then ignores a device in another zone", async () => {
    const headers = { authorization: `Bearer ${await bearer()}`, "content-type": "application/json" };
    const chosen = await createApp().request("/workspace/me",
      { method: "PATCH", headers, body: JSON.stringify({ timezone: "America/New_York" }) }, env());
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toMatchObject({ id: userId, timezone: "America/New_York" });

    const reported = await createApp().request("/workspace/me/device-timezone",
      { method: "PUT", headers, body: JSON.stringify({ timezone: "Asia/Tokyo" }) }, env());
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ timezone: "America/New_York", followsDevice: false });
  });

  it("issues a guest the workspace socket ticket its sidebar nudges arrive on", async () => {
    const guestId = "00000000-0000-7000-8000-000000000004";
    database.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?, 'guest@example.com','Guest',?,?)").run(guestId, at, at);
    database.prepare("INSERT INTO workspace_members (workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,'guest',NULL,'active',?)")
      .run(workspaceId, guestId, at);
    const bindings = createTestEnv({ ...env(), PUBLIC_API_BASE_URL: "https://api.example.test" });
    const guestSession = await new AuthService(bindings).createRegionalSession(guestId, workspaceId);
    const request = (path: string) => createApp().request(path, {
      headers: { authorization: `Bearer ${guestSession.accessToken}` },
    }, bindings);

    const ticket = await request("/workspace/socket");
    expect(ticket.status).toBe(200);
    expect(await ticket.json()).toMatchObject({
      url: `wss://api.example.test/socket/workspaces/${workspaceId}`,
      ticket: expect.any(String),
    });
  });

  it("admits a guest to push registration, search, speech and Space reads", async () => {
    const guestId = "00000000-0000-7000-8000-000000000004";
    database.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?, 'guest@example.com','Guest',?,?)").run(guestId, at, at);
    database.prepare("INSERT INTO workspace_members (workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,'guest',NULL,'active',?)")
      .run(workspaceId, guestId, at);
    const bindings = createTestEnv({ ...env(), PUBLIC_API_BASE_URL: "https://api.example.test" });
    const guestSession = await new AuthService(bindings).createRegionalSession(guestId, workspaceId);
    const request = (path: string, init: RequestInit = {}) => createApp().request(path, {
      ...init,
      headers: { authorization: `Bearer ${guestSession.accessToken}`, "content-type": "application/json" },
    }, bindings);
    const installationId = "00000000-0000-4000-8000-000000000009";

    // A device is the account's; a guest registers and removes their own.
    expect((await request(`/push-devices/${installationId}`, { method: "DELETE" })).status).toBe(204);
    // Search and speech reach their own validation, past the relationship
    // check that used to refuse a guest; a malformed body is the request's fault.
    expect((await request("/search", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await request("/speech", { method: "POST", body: "{}" })).status).toBe(400);
    // A Space's Channel list is read by the listing rules for everyone.
    expect((await request("/spaces/not-an-id/channels")).status).toBe(400);
    // Changing a Space, and the pending invitees, stay a member's.
    expect((await request("/spaces", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await request("/workspace/invitees")).status).toBe(403);
  });

  it("gives a guest the Organization profile and roster and nothing else under /workspace", async () => {
    const guestId = "00000000-0000-7000-8000-000000000004";
    database.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?, 'guest@example.com','Guest',?,?)").run(guestId, at, at);
    database.prepare("INSERT INTO workspace_members (workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,'guest',NULL,'active',?)")
      .run(workspaceId, guestId, at);
    const bindings = createTestEnv({ ...env(), PUBLIC_API_BASE_URL: "https://api.example.test" });
    const guestSession = await new AuthService(bindings).createRegionalSession(guestId, workspaceId);
    const request = (path: string) => createApp().request(path, {
      headers: { authorization: `Bearer ${guestSession.accessToken}` },
    }, bindings);

    const profile = await request("/workspace");
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ id: workspaceId, accessClass: "guest", role: null });
    // The roster, every guest and address included, is a guest's to read.
    const roster = await request("/workspace/members");
    expect(roster.status).toBe(200);
    expect(((await roster.json()) as { items: Array<{ user: { email: string } }> }).items.map((item) => item.user.email).sort())
      .toEqual(["guest@example.com", "member@example.com"]);
    // The rest of `/workspace` stays member-only.
    expect((await request("/workspace/attention")).status).toBe(403);
  });

  it("still answers a member's profile with their role", async () => {
    const response = await createApp().request("/workspace", { headers: { authorization: `Bearer ${await bearer()}` } }, env());
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: workspaceId, role: "owner" });
    expect(body).not.toHaveProperty("accessClass");
  });

  it("promotes the same guest through the public route and retains its session binding", async () => {
    const guestId = "00000000-0000-7000-8000-000000000004";
    database.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?, 'guest@example.com','Guest',?,?)").run(guestId, at, at);
    database.prepare("INSERT INTO workspace_members (workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,'guest',NULL,'active',?)")
      .run(workspaceId, guestId, at);
    const send = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
    const bindings = createTestEnv({ ...env(), PUBLIC_API_BASE_URL: "https://api.example.test",
      ACCESS_REVOCATION_QUEUE: { send, sendBatch: async () => undefined } });
    const guestSession = await new AuthService(bindings).createRegionalSession(guestId, workspaceId);
    const relationship = database.prepare("SELECT incarnation, revision FROM workspace_members WHERE user_id = ?").get(guestId)!;
    const response = await createApp().request(`/workspace/members/${guestId}/promote`, {
      method: "POST", headers: { authorization: `Bearer ${await bearer()}`, "content-type": "application/json" },
      body: JSON.stringify({ incarnation: relationship.incarnation, expectedRevision: relationship.revision }),
    }, bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: guestId, accessClass: "member", role: "member", incarnation: relationship.incarnation });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workspace_relationship_changed", removed: false,
      relationship: expect.objectContaining({ workspaceId, userId: guestId, incarnation: relationship.incarnation,
        revision: Number(relationship.revision) + 1, accessClass: "member", role: "member", status: "active" }),
    }));
    expect(database.prepare("SELECT dispatched_at FROM workspace_relationship_deliveries WHERE user_id=? ORDER BY revision DESC LIMIT 1")
      .get(guestId)?.dispatched_at).toEqual(expect.any(String));
    const refreshed = await new AuthService(bindings).refresh(guestSession.refreshToken);
    expect(refreshed.user.id).toBe(guestId);
    expect(refreshed.workspace).toMatchObject({ role: "member" });
    expect(database.prepare("SELECT workspace_incarnation FROM sessions WHERE user_id = ?").get(guestId))
      .toMatchObject({ workspace_incarnation: relationship.incarnation });
    expect(database.prepare("SELECT access_class FROM workspace_relationship_deliveries WHERE user_id = ? ORDER BY revision DESC LIMIT 1").get(guestId))
      .toMatchObject({ access_class: "member" });
  });

  it("rejects stale and non-administrator promotion requests", async () => {
    const guestId = "00000000-0000-7000-8000-000000000004";
    database.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?, 'guest@example.com','Guest',?,?)").run(guestId, at, at);
    database.prepare("INSERT INTO workspace_members (workspace_id,user_id,access_class,role,status,joined_at,incarnation) VALUES (?,?,'guest',NULL,'active',?,'current')")
      .run(workspaceId, guestId, at);
    const app = createApp();
    const headers = { authorization: `Bearer ${await bearer()}`, "content-type": "application/json" };
    const promote = (incarnation: string) => app.request(`/workspace/members/${guestId}/promote`, {
      method: "POST", headers, body: JSON.stringify({ incarnation, expectedRevision: 1 }),
    }, env());
    expect((await promote("removed-membership")).status).toBe(409);
    database.prepare("UPDATE workspace_members SET role = 'member' WHERE user_id = ?").run(userId);
    expect((await promote("current")).status).toBe(403);
    expect(database.prepare("SELECT access_class FROM workspace_members WHERE user_id = ?").get(guestId))
      .toMatchObject({ access_class: "guest" });
  });

  it("discovers and selects guest workspaces without granting member routes and preserves promotion", async () => {
    database.prepare("UPDATE users SET google_subject=NULL WHERE id=?").run(userId);
    database.prepare("UPDATE workspace_members SET access_class='guest',role=NULL WHERE workspace_id=? AND user_id=?")
      .run(workspaceId,userId);
    database.prepare("UPDATE sessions SET workspace_id=NULL WHERE id=?").run(sessionId);
    const identityToken = await new SignJWT({ sid:sessionId,wid:null,region:"global" })
      .setProtectedHeader({ alg:"HS256",typ:"JWT" }).setSubject(userId)
      .setIssuer("avalon-api").setAudience("avalon-desktop").setIssuedAt().setExpirationTime("15m")
      .sign(new TextEncoder().encode(signingKey));
    const bindings = { ...env(),PUBLIC_API_BASE_URL:"https://api.example.test" };
    const app = createApp();
    const headers = { authorization:`Bearer ${identityToken}`,"content-type":"application/json" };
    const list = await app.request("/auth/workspaces",{ headers },bindings);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ workspaces:[{ id:workspaceId,accessClass:"guest",role:null }] });
    const select = await app.request("/auth/workspace/select",{ method:"POST",headers,body:JSON.stringify({ workspaceId }) },bindings);
    expect(select.status).toBe(200);
    const session = SessionSchema.parse(await select.json());
    expect(session.workspace).toMatchObject({ id:workspaceId,accessClass:"guest",role:null });
    const guestHeaders = { ...headers,authorization:`Bearer ${session.accessToken}` };
    expect((await app.request("/auth/workspaces",{ headers:guestHeaders },bindings)).status).toBe(200);
    expect((await app.request("/workspace/invitees",{ headers:guestHeaders },bindings)).status).toBe(403);
    const refreshed = await new AuthService(bindings).refresh(session.refreshToken);
    expect(refreshed.workspace).toMatchObject({ accessClass:"guest",role:null });
    database.prepare("UPDATE workspace_members SET access_class='member',role='member' WHERE workspace_id=? AND user_id=?")
      .run(workspaceId,userId);
    const promoted = await new AuthService(bindings).refresh(refreshed.refreshToken);
    expect(promoted.user.id).toBe(session.user.id);
    expect(promoted.workspace?.role).toBe("member");
    expect((await app.request("/workspace/invitees",{ headers:guestHeaders },bindings)).status).toBe(200);
    database.prepare("UPDATE workspace_members SET status='suspended' WHERE workspace_id=? AND user_id=?").run(workspaceId,userId);
    expect((await app.request("/auth/workspaces",{ headers:guestHeaders },bindings)).status).toBe(401);
    expect(await (await app.request("/auth/workspaces",{ headers },bindings)).json()).toEqual({ workspaces:[] });
    expect((await app.request("/auth/workspace/select",{ method:"POST",headers,body:JSON.stringify({ workspaceId }) },bindings)).status).toBe(403);
    expect((await app.request("/auth/workspace/select",{ method:"POST",headers,body:JSON.stringify({ workspaceId:crypto.randomUUID() }) },bindings)).status).toBe(403);
  });

  it("does not revive old access or refresh credentials after membership removal and rejoin", async () => {
    const bindings = env();
    const app = createApp();
    const token = await bearer();
    const refreshToken = "old-workspace-refresh-token-for-incarnation-test";
    database.prepare("UPDATE sessions SET refresh_token_hash=?,created_at=? WHERE id=?")
      .run(await sha256(refreshToken),new Date().toISOString(),sessionId);
    const request = (accessToken: string) => app.request("/speech", {
      method:"POST",headers:{ authorization:`Bearer ${accessToken}`,"content-type":"application/json" },body:"{}",
    },bindings);
    expect((await request(token)).status).toBe(400);
    const original = database.prepare("SELECT workspace_incarnation FROM sessions WHERE id=?").get(sessionId);
    database.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").run(workspaceId,userId);
    database.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,joined_at) VALUES (?,?,'owner','active',?)")
      .run(workspaceId,userId,at);
    expect(database.prepare("SELECT incarnation AS workspace_incarnation FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .get(workspaceId,userId)).not.toEqual(original);
    expect(database.prepare("SELECT workspace_incarnation FROM sessions WHERE id=?").get(sessionId)).toEqual(original);
    expect((await request(token)).status).toBe(401);
    const auth = new AuthService(bindings);
    await expect(auth.refresh(refreshToken)).rejects.toMatchObject({ status:401,code:"invalid_refresh_token" });
    expect(database.prepare("SELECT refresh_token_hash FROM sessions WHERE id=?").get(sessionId))
      .toEqual({ refresh_token_hash:await sha256(refreshToken) });
    const fresh = await auth.createRegionalSession(userId,workspaceId);
    expect((await request(fresh.accessToken)).status).toBe(400);
  });

  it("keeps the session membership binding through guest promotion", async () => {
    const original = database.prepare("SELECT workspace_incarnation FROM sessions WHERE id=?").get(sessionId);
    database.prepare("UPDATE workspace_members SET access_class='guest',role=NULL WHERE workspace_id=? AND user_id=?")
      .run(workspaceId,userId);
    database.prepare("UPDATE workspace_members SET access_class='member',role='member' WHERE workspace_id=? AND user_id=?")
      .run(workspaceId,userId);
    expect(database.prepare("SELECT workspace_incarnation FROM sessions WHERE id=?").get(sessionId)).toEqual(original);
    const app = new Hono<HonoAppEnv>();
    app.use("*",requireAuth);
    app.get("/protected",(c) => c.json({ ok:true }));
    expect((await app.request("/protected",{ headers:{ authorization:`Bearer ${await bearer()}` } },env())).status).toBe(200);
  });

  it("reads the session once and checks revocation again on the next request", async () => {
    const bindings = env();
    const prepare = vi.spyOn(bindings.DB, "prepare");
    const app = createApp();
    const token = await bearer();
    const request = () => app.request("/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }, bindings);
    // Validation proves the protected route was reached without invoking Azure.
    const response = await request();
    expect(response.status).toBe(400);
    const sessionReads = () => prepare.mock.calls.filter(([sql]) => sql.includes("FROM sessions s"));
    expect(sessionReads()).toHaveLength(1);

    database.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(at, sessionId);
    const revoked = await request();
    expect(revoked.status).toBe(401);
    expect(sessionReads()).toHaveLength(2);
    await expect(revoked.json()).resolves.toMatchObject({ error: { code: "session_revoked" } });
  });

  it("still refuses an identity-only session at a protected route", async () => {
    database.prepare("UPDATE sessions SET workspace_id = NULL WHERE id = ?").run(sessionId);
    const token = await new SignJWT({ sid: sessionId, wid: null, region: "global" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(userId)
      .setIssuer("avalon-api").setAudience("avalon-desktop")
      .setIssuedAt().setExpirationTime("15m").sign(new TextEncoder().encode(signingKey));
    const response = await createApp().request("/speech", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    }, env());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "workspace_setup_required" } });
  });

  it("authenticates when workspace middleware is mounted without identity middleware", async () => {
    const app = new Hono<HonoAppEnv>();
    app.use("*", requireAuth);
    app.get("/protected", (c) => c.json({ ok: true }));
    const bindings = env();
    const prepare = vi.spyOn(bindings.DB, "prepare");
    const response = await app.request("/protected", {
      headers: { authorization: `Bearer ${await bearer()}` },
    }, bindings);
    expect(response.status).toBe(200);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM sessions s"))).toHaveLength(1);
  });
});
