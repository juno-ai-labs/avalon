import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { createBrowserRoutes } from "../src/routes/browser";
import { requireIdentityAuth, getIdentityAuth } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/errors";
import type { HonoAppEnv } from "../src/env";
import { BrowserSessionSchema, BrowserSessionService } from "../src/services/browser-session-service";
import { openEmailLoginSecret } from "../src/services/email-login-service";
import { sha256 } from "../src/lib/crypto";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { creatingWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";

let db: DatabaseSync;
const origin = "https://app.example.test";
const apiOrigin = "https://api.example.test";
function bindings() {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"development",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:origin,PUBLIC_API_BASE_URL:apiOrigin,LOG_LEVEL:"error",
    SESSION_SIGNING_KEY:"browser-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:"browser-test-encryption-key",
    BROWSER_APP_ORIGIN:origin,RESEND_FROM_EMAIL:"Rally <login@example.test>",
    EMAIL_LOGIN_POLICY_JSON:JSON.stringify({ otpDigits:6,ttlSeconds:600,maxFailedAttempts:3 }) });
}
function request(path:string, cookie?:string, body?:unknown, method = body === undefined ? "GET" : "POST") {
  return createApp().request(`${apiOrigin}/browser/${path}`,{ method,headers:{ origin,
    ...(cookie ? { cookie } : {}),...(body === undefined ? {} : { "content-type":"application/json" }) },
    ...(body === undefined ? {} : { body:JSON.stringify(body) }) },bindings());
}
async function login() {
  const challengeId = crypto.randomUUID();
  expect((await request("email/start",undefined,{ challengeId,email:"guest@example.test" })).status).toBe(202);
  const row = db.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?").get(challengeId)!;
  const delivery = await openEmailLoginSecret(bindings(),challengeId,String(row.delivery_payload_encrypted)) as { text:string };
  const otp = /code is (\d+)\./u.exec(delivery.text)![1]!;
  const redemption = { challengeId,redemptionId:crypto.randomUUID(),method:"otp",credential:otp };
  const response = await request("email/redeem",undefined,redemption);
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const credential = decodeURIComponent(cookie.slice(cookie.indexOf("=")+1));
  const session = BrowserSessionSchema.parse(await response.json());
  return { cookie,credential,setCookie,session,redemption };
}
function workspace(userId:string, accessClass:"member"|"guest" = "guest") {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at)
    VALUES (?,'Shared workspace',?,'global',?,?,?)`).run(id,id,userId,now,now);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status,joined_at) VALUES (?,?,?,?,'active',?)")
    .run(id,userId,accessClass,accessClass === "guest" ? null : "member",now);
  return id;
}
beforeEach(() => { db = migratedSqliteDatabase(); });
afterEach(() => { db.close();vi.useRealTimers();vi.restoreAllMocks(); });

it("redeems email into a recoverable HttpOnly cookie without exposing session tokens",async () => {
  const entry = await login();
  expect(entry.setCookie).toContain("__Host-rally-browser-global=");
  for (const attribute of ["HttpOnly","Secure","SameSite=Lax","Path=/","Expires="]) expect(entry.setCookie).toContain(attribute);
  expect(entry.setCookie).not.toContain("Domain=");
  expect(entry.session.workspace).toBeNull();
  const replay = await request("email/redeem",undefined,entry.redemption);
  expect(replay.headers.get("set-cookie")?.split(";")[0]).toBe(entry.cookie);
  const response = await request("session",entry.cookie);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).not.toHaveProperty("accessToken");
  expect(body).not.toHaveProperty("refreshToken");
  expect(db.prepare("SELECT credential_hash FROM browser_sessions").get()).toEqual({ credential_hash:await sha256(entry.credential) });
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n:1 });
});

it("rejects missing and foreign mutation origins before consuming a login proof or cookie",async () => {
  const entry = await login();
  for (const candidate of [undefined,"https://evil.example.test"]) {
    const response = await createApp().request(`${apiOrigin}/browser/logout`,{ method:"POST",
      headers:{ cookie:entry.cookie,...(candidate ? { origin:candidate } : {}) } },bindings());
    expect(response.status).toBe(403);
  }
  expect((await request("session",entry.cookie)).status).toBe(200);
  expect((await request("email/redeem")).status).toBe(405);
  expect((await createApp().request(`${apiOrigin}/resources`,{ headers:{ cookie:entry.cookie } },bindings())).status).toBe(401);
});

it("keeps simultaneous workspace tabs independent and converges racing activations",async () => {
  const entry = await login();
  const first = workspace(entry.session.user.id), second = workspace(entry.session.user.id,"member");
  const replies = await Promise.all([first,first,second].map((workspaceId) => request("workspace/select",entry.cookie,{ workspaceId })));
  expect(replies.map((response) => response.status)).toEqual([200,200,200]);
  const service = new BrowserSessionService(bindings());
  const [one,two] = await Promise.all([service.read(entry.credential,first),service.read(entry.credential,second)]);
  expect(one).toMatchObject({ workspaceId:first,accessClass:"guest",role:null });
  expect(two).toMatchObject({ workspaceId:second,role:"member" });
  expect(one.sessionId).not.toBe(two.sessionId);
  expect(db.prepare("SELECT COUNT(*) AS n FROM browser_workspace_sessions").get()).toEqual({ n:2 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").get()).toEqual({ n:3 });
});

it("adapts cookies to the ordinary API with the addressed workspace and no caller-selected bearer",async () => {
  const entry = await login();
  const workspaceId = workspace(entry.session.user.id);
  await request("workspace/select",entry.cookie,{ workspaceId });
  const api = new Hono<HonoAppEnv>();
  api.use("*",requireIdentityAuth);
  api.get("/conversations/probe",(c) => c.json(getIdentityAuth(c)));
  api.post("/conversations/probe",async (c) => c.json({ auth:getIdentityAuth(c),input:await c.req.json() }));
  const browser = new Hono<HonoAppEnv>();
  browser.route("/browser",createBrowserRoutes((forwarded,c) => api.fetch(forwarded,c.env)));
  browser.onError(errorHandler);
  const otherWorkspace = workspace(entry.session.user.id);
  const response = await browser.request(`${apiOrigin}/browser/api/${workspaceId}/conversations/probe`,{
    headers:{ cookie:entry.cookie,authorization:"Bearer attacker-value",
      "x-rally-dev-user-id":entry.session.user.id,"x-rally-dev-workspace-id":otherWorkspace },
  },{ ...bindings(),RALLY_DEV_AUTH:"true" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ userId:entry.session.user.id,workspaceId,role:null,accessClass:"guest" });
  const post = await browser.request(`${apiOrigin}/browser/api/${workspaceId}/conversations/probe`,{ method:"POST",
    headers:{ cookie:entry.cookie,origin,"content-type":"application/json" },body:JSON.stringify({ text:"hello" }) },bindings());
  expect(post.status).toBe(200);
  expect(await post.json()).toMatchObject({ auth:{ workspaceId },input:{ text:"hello" } });
  expect((await browser.request(`${apiOrigin}/browser/api/${crypto.randomUUID()}/conversations/probe`,{ headers:{ cookie:entry.cookie } },bindings())).status).toBe(401);
  expect((await request("api/_/auth/refresh",entry.cookie,{})).status).toBe(404);
  expect((await request("api/_/internal/access",entry.cookie)).status).toBe(404);
});

it("forwards a cookie-authenticated message issue POST with its addressed workspace",async () => {
  const entry = await login();
  const workspaceId = workspace(entry.session.user.id,"member");
  await request("workspace/select",entry.cookie,{ workspaceId });
  const api = new Hono<HonoAppEnv>();
  api.use("*",requireIdentityAuth);
  api.post("/message-issues",async (c) => c.json({ auth:getIdentityAuth(c),input:await c.req.json() },201));
  const browser = new Hono<HonoAppEnv>();
  browser.route("/browser",createBrowserRoutes((forwarded,c) => api.fetch(forwarded,c.env)));
  browser.onError(errorHandler);
  const input = { description:"The answer was wrong." };
  const response = await browser.request(`${apiOrigin}/browser/api/${workspaceId}/message-issues`,{
    method:"POST",headers:{ cookie:entry.cookie,origin,"content-type":"application/json" },body:JSON.stringify(input),
  },bindings());
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ auth:{ userId:entry.session.user.id,workspaceId },input });
});

it("forwards the Canvases and Sidekicks shell's route families, and refuses the Thread families, token minting and ingress",async () => {
  const entry = await login();
  const workspaceId = workspace(entry.session.user.id,"member");
  await request("workspace/select",entry.cookie,{ workspaceId });
  const api = new Hono<HonoAppEnv>();
  api.use("*",requireIdentityAuth);
  api.all("*",(c) => c.json({ path:new URL(c.req.url).pathname,workspaceId:getIdentityAuth(c).workspaceId }));
  const browser = new Hono<HonoAppEnv>();
  browser.route("/browser",createBrowserRoutes((forwarded,c) => api.fetch(forwarded,c.env)));
  browser.onError(errorHandler);
  for (const family of ["canvases","conversations","sidekicks","automations","sharing","resources","search","onboarding/account","onboarding/organization-suggestion","digest","push-devices","connections","workspaces"]) {
    const response = await browser.request(`${apiOrigin}/browser/api/${workspaceId}/${family}/probe`,{ headers:{ cookie:entry.cookie } },bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path:`/${family}/probe`,workspaceId });
  }
  for (const family of ["workstreams","spaces","projects","navigation","work-opportunities","auth","internal","ingest","access","slack","dev"]) {
    const response = await browser.request(`${apiOrigin}/browser/api/${workspaceId}/${family}/probe`,{ headers:{ cookie:entry.cookie } },bindings());
    expect(response.status).toBe(404);
  }
  // These onboarding steps answer with bearer tokens, which browser JavaScript must never hold.
  for (const path of ["onboarding","onboarding/workspace","onboarding/workspace/activate","onboarding/invitations/abc/accept","onboarding-account"]) {
    const response = await browser.request(`${apiOrigin}/browser/api/${workspaceId}/${path}`,{ headers:{ cookie:entry.cookie } },bindings());
    expect(response.status).toBe(404);
  }
});

it("keeps promotion on the same session and refuses an old workspace incarnation after rejoin",async () => {
  const entry = await login(), service = new BrowserSessionService(bindings());
  const workspaceId = workspace(entry.session.user.id);
  await service.select(entry.credential,workspaceId);
  const old = await service.read(entry.credential,workspaceId);
  db.prepare("UPDATE workspace_members SET access_class='member',role='member' WHERE workspace_id=?").run(workspaceId);
  expect(await service.read(entry.credential,workspaceId)).toMatchObject({ sessionId:old.sessionId,role:"member" });
  db.prepare("DELETE FROM workspace_members WHERE workspace_id=?").run(workspaceId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status) VALUES (?,?,'guest',NULL,'active')")
    .run(workspaceId,entry.session.user.id);
  await expect(service.read(entry.credential,workspaceId)).rejects.toMatchObject({ status:401 });
  await service.select(entry.credential,workspaceId);
  expect((await service.read(entry.credential,workspaceId)).sessionId).not.toBe(old.sessionId);
});

it("renews against the existing session ceiling and never revives revoked sessions",async () => {
  const entry = await login(), service = new BrowserSessionService(bindings());
  const workspaceId = workspace(entry.session.user.id);
  await service.select(entry.credential,workspaceId);
  const root = await service.read(entry.credential);
  const created = new Date(Date.now()-89*24*60*60*1000).toISOString();
  db.prepare("UPDATE sessions SET created_at=?").run(created);
  const renewed = await service.renew(entry.credential);
  expect(Date.parse(renewed.expiresAt)).toBeLessThanOrEqual(Date.parse(created)+90*24*60*60*1000);
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at>?").get(renewed.expiresAt)).toEqual({ n:0 });
  db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(new Date().toISOString(),root.sessionId);
  await expect(service.renew(entry.credential)).rejects.toMatchObject({ status:401 });
  await expect(service.read(entry.credential,workspaceId)).rejects.toMatchObject({ status:401 });
});

it("logs out every workspace session attached to the browser and clears its cookie",async () => {
  const entry = await login();
  for (const workspaceId of [workspace(entry.session.user.id),workspace(entry.session.user.id)]) {
    await request("workspace/select",entry.cookie,{ workspaceId });
  }
  const response = await request("logout",entry.cookie,{});
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").get()).toEqual({ n:0 });
  expect((await request("session",entry.cookie)).status).toBe(401);
  expect((await request("logout",entry.cookie,{})).status).toBe(204);
});

it("creates an organization for an email-only account and opens it with the cookie, holding no bearer",async () => {
  const entry = await login();
  // The real object class: creation initializes the Organization's object before it issues anything.
  const workspaceObject = creatingWorkspaceObjectBinding(db);
  const env = { ...bindings(),WORKSPACE_DOS:workspaceObject.binding };
  const create = (body:unknown, cookie:string | null = entry.cookie) => createApp().request(`${apiOrigin}/browser/workspace/create`,{ method:"POST",
    headers:{ origin,"content-type":"application/json",...(cookie ? { cookie } : {}) },body:JSON.stringify(body) },env);
  const operationId = "01920000-0000-7000-8000-000000000001";
  try {
    const response = await create({ name:"Acme Research",operationId });
    expect(response.status).toBe(201);
    const created = await response.json() as { region:string; workspaceId:string };
    expect(Object.keys(created).sort()).toEqual(["region","workspaceId"]);
    expect(created.region).toBe("global");
    expect(db.prepare("SELECT name FROM workspaces WHERE id=?").get(created.workspaceId)).toEqual({ name:"Acme Research" });
    // The session the create path minted is revoked; only the browser's identity session stays open.
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").get()).toEqual({ n:1 });
    // A retry of the same operation returns the same organization rather than a second.
    const retry = await create({ name:"Acme Research",operationId });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(created);
    expect(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n:1 });
    const selected = await request("workspace/select",entry.cookie,{ workspaceId:created.workspaceId });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ workspace:{ id:created.workspaceId,name:"Acme Research",role:"owner" } });
    expect((await create({ name:"Acme Research",operationId:crypto.randomUUID() },null)).status).toBe(401);
    // A new creator sets the organization up; one already a member elsewhere keeps their exemption.
    expect(db.prepare("SELECT onboarding_eligible FROM users WHERE id=?").get(entry.session.user.id)).toEqual({ onboarding_eligible:1 });
    db.prepare("UPDATE users SET onboarding_eligible=0 WHERE id=?").run(entry.session.user.id);
    // A second organization is a fresh operation and a fresh organization, even
    // under the same name in the same minute.
    const second = await create({ name:"Acme Research",operationId:"01920000-0000-7000-8000-000000000002" });
    expect(second.status).toBe(201);
    expect(db.prepare("SELECT onboarding_eligible FROM users WHERE id=?").get(entry.session.user.id)).toEqual({ onboarding_eligible:0 });
  } finally { for (const database of workspaceObject.databases) database.close(); }
});

it("leaves an account's setup exemption alone when the create fails or it belongs to an organization in another deployment",async () => {
  const eligible = (userId:string) => db.prepare("SELECT onboarding_eligible FROM users WHERE id=?").get(userId);
  const create = (cookie:string, env:ReturnType<typeof bindings>, operationId:string) => createApp().request(`${apiOrigin}/browser/workspace/create`,{ method:"POST",
    headers:{ origin,"content-type":"application/json",cookie },body:JSON.stringify({ name:"Acme Research",operationId }) },env);
  const entry = await login();
  const now = new Date().toISOString();
  const workspaceObject = creatingWorkspaceObjectBinding(db);
  const env = { ...bindings(),WORKSPACE_DOS:workspaceObject.binding };
  // An operation id another account already used is refused before anything is created.
  const taken = "01920000-0000-7000-8000-000000000011";
  db.prepare(`INSERT INTO platform_workspace_operations(operation_id,platform_user_id,action,request_fingerprint,region,workspace_id,
    placement_affinity,status,created_at,updated_at) VALUES (?,?,'create','other','global',?,'wnam','pending',?,?)`)
    .run(taken,crypto.randomUUID(),crypto.randomUUID(),now,now);
  expect((await create(entry.cookie,env,taken)).status).toBe(409);
  expect(eligible(entry.session.user.id)).toEqual({ onboarding_eligible:0 });
  // A member elsewhere: the binding to another deployment is all Global knows of it.
  db.prepare(`INSERT INTO platform_workspace_bindings(platform_user_id,region,workspace_id,status,operation_id,created_at,updated_at)
    VALUES (?,'enterprise',?,'active',?,?,?)`).run(entry.session.user.id,crypto.randomUUID(),crypto.randomUUID(),now,now);
  try {
    expect((await create(entry.cookie,env,"01920000-0000-7000-8000-000000000012")).status).toBe(201);
    expect(eligible(entry.session.user.id)).toEqual({ onboarding_eligible:0 });
  } finally { for (const database of workspaceObject.databases) database.close(); }
});
