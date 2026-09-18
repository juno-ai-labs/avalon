import type { Env } from "../src/env";
import { SignJWT } from "jose";
import { createApp } from "../src/app";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";
import { ScopeInvitationStorage } from "../src/durable-objects/scope-invitation-storage";
import { decryptString } from "../src/lib/crypto";
import { BrowserSessionService } from "../src/services/browser-session-service";
import { openEmailLoginSecret } from "../src/services/email-login-service";
import { promoteWorkspaceGuest } from "../src/services/workspace-relationship-service";
import { workstreamDOName } from "../src/durable-objects/names";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000091");
const parentId = asWorkstreamId("00000000-0000-4000-8000-000000000092");
const actorId = asUserId("00000000-0000-4000-8000-000000000093");
const recipientId = asUserId("00000000-0000-4000-8000-000000000094");
const childId = asSubstreamId("00000000-0000-4000-8000-000000000095");
const child: ScopeGrantTarget = { kind: "conversation", workspaceId, parentId, substreamId: childId };
const main: ScopeGrantTarget = { ...child, substreamId: asSubstreamId("0") };
const room = (id = parentId) => env.WORKSTREAM_DOS.getByName(workstreamDOName("global", workspaceId, id));
const invitation = (targets: ScopeGrantTarget[] = [child]) => ({ operationId: crypto.randomUUID(), workspaceId, parentId,
  actorUserId: actorId, emails: ["guest@example.test"], targets, expiresAt: null });

async function tokenFor(id: string, parent = parentId): Promise<string> {
  const encrypted = await runInDurableObject(room(parent), (_instance, state) =>
    new ScopeInvitationStorage(state.storage).read(id)!.deliveryEncrypted);
  const sealed = JSON.parse(encrypted) as { ciphertext: string; iv: string };
  const delivery = JSON.parse(await decryptString(sealed.ciphertext, sealed.iv,
    env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)) as { text: string };
  const link = delivery.text.split("\n").find((line) => line.startsWith("https://app.test/invite"));
  if (!link) throw new Error("invitation link missing");
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
}

async function create(targets: ScopeGrantTarget[] = [child]) {
  const result = await room().createScopeInvitations(invitation(targets));
  if (result.status !== "created" || !result.invitations[0]) throw new Error(JSON.stringify(result));
  const id = result.invitations[0].id;
  return { workspaceId, parentId, invitationId: id, userId: recipientId, token: await tokenFor(id) };
}

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id) VALUES (?)").bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      revision INTEGER NOT NULL DEFAULT 1, joined_at TEXT, last_seen_at TEXT, PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status,incarnation) VALUES (?,?,'member','owner','active','actor-membership')")
      .bind(workspaceId, actorId),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, analytics_person_id TEXT, name TEXT, email TEXT)"),
    env.DB.prepare("INSERT INTO users (id) VALUES (?), (?)").bind(actorId, recipientId),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT,
      region TEXT, workspace_incarnation TEXT, revoked_at TEXT, expires_at TEXT)`),
    env.DB.prepare("INSERT INTO sessions VALUES ('actor-session', ?, ?, 'global', 'actor-membership', NULL, '2099-01-01T00:00:00.000Z')").bind(actorId, workspaceId),
    env.DB.prepare("INSERT INTO sessions VALUES ('recipient-session', ?, NULL, 'global', NULL, NULL, '2099-01-01T00:00:00.000Z')").bind(recipientId),
    env.DB.prepare("CREATE TABLE user_verified_emails (email TEXT PRIMARY KEY, user_id TEXT)") ,
    env.DB.prepare("INSERT INTO user_verified_emails VALUES ('guest@example.test',?)").bind(recipientId),
  ]);
  await room().authority({ workspaceId, parentId });
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO workstream_metadata
      (id,workspace_id,workstream_id,region,authority_generation,title,description,preview,scope,exact_state,last_activity_at,created_at,updated_at)
      VALUES (1,?,?,'global',1,'Private parent','','','personal','idle',0,0,0)`,workspaceId,parentId);
    state.storage.sql.exec("INSERT INTO conversation_children (substream_id,kind,created_at) VALUES ('0','main',0), (?,'child',0)", childId);
    state.storage.sql.exec("INSERT INTO main_participant_migration VALUES (1, ?, '{}', 'complete')", crypto.randomUUID());
    state.storage.sql.exec("INSERT INTO child_participant_migrations VALUES (?, ?, 'complete')", childId, crypto.randomUUID());
    const grants = new ScopeGrantStorage(state.storage, { workspaceId, parentId });
    for (const target of [main, child]) grants.mutate({ operationId: crypto.randomUUID(), actorUserId: actorId,
      userId: actorId, target, active: true, expectedRevision: 0 }, "actor-membership");
  });
});

it("retries one email batch without replacing invitation credentials or its durable delivery", async () => {
  const request = invitation();
  const first = await room().createScopeInvitations(request);
  expect(first.status).toBe("created");
  expect(await room().createScopeInvitations(request)).toEqual(first);
  expect(await room().createScopeInvitations({ ...request, emails: ["someone-else@example.test"] }))
    .toMatchObject({ status: "denied", reason: "operation_conflict" });
  await runDurableObjectAlarm(room());
  await runInDurableObject(room(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM scope_invitations").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec<{ delivered_at: number }>("SELECT delivered_at FROM scope_invitations").one().delivered_at).toBeGreaterThan(0);
  });
});

it("accepts only a verified recipient and grants a child without Main", async () => {
  const request = await create();
  expect(await room().acceptScopeInvitation({ ...request, token: "wrong" })).toMatchObject({ status: "denied" });
  expect(await room().acceptScopeInvitation({ ...request, userId: actorId }))
    .toMatchObject({ status: "denied", reason: "verified_email_required" });
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "accepted" });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true, writable: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: false });
  expect(await env.DB.prepare("SELECT access_class,role FROM workspace_members WHERE user_id=?").bind(recipientId).first())
    .toEqual({ access_class: "guest", role: null });
});

it("never restores a revoked grant or a removed membership when acceptance is replayed", async () => {
  const request = await create();
  const accepted = await room().acceptScopeInvitation(request);
  await runInDurableObject(room(), (_instance, state) => {
    const grants = new ScopeGrantStorage(state.storage, child);
    grants.mutateCurrent({ operationId: crypto.randomUUID(), actorUserId: actorId, userId: recipientId, target: child, active: false },
      grants.forUser(recipientId)[0]!.membershipIncarnation);
  });
  expect(await room().acceptScopeInvitation(request)).toEqual(accepted);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: false });
  await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(recipientId).run();
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "denied", reason: "relationship_required" });
  expect(await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(recipientId).first()).toBeNull();
});

it("a revoked invitation cannot be accepted, even with its original proof", async () => {
  const request = await create();
  expect(await room().revokeScopeInvitation({ workspaceId, parentId, actorUserId: actorId,
    invitationId: request.invitationId, expectedRevision: 1 })).toMatchObject({ status: "revoked" });
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "denied", reason: "invitation_unavailable" });
  expect(await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(recipientId).first()).toBeNull();
});

it("commits all target grants with acceptance, or retries after rolling every grant back", async () => {
  const request = await create([main, child]);
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec(`CREATE TRIGGER reject_child_grant BEFORE INSERT ON scope_grants
      WHEN NEW.user_id='${recipientId}' AND NEW.substream_id='${childId}'
      BEGIN SELECT RAISE(ABORT,'simulated child write failure'); END`);
  });
  // Catch the deliberate runtime rejection inside the object: the test RPC
  // bridge otherwise reports the same expected rejection as unhandled as well.
  await expect(runInDurableObject(room(), (instance) => instance.acceptScopeInvitation(request)))
    .rejects.toThrow("simulated child write failure");
  await runInDurableObject(room(), (_instance, state) => {
    expect(new ScopeGrantStorage(state.storage, child).forUser(recipientId)).toEqual([]);
    expect(new ScopeInvitationStorage(state.storage).read(request.invitationId)?.summary.status).toBe("pending");
    state.storage.sql.exec("DROP TRIGGER reject_child_grant");
  });
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "accepted" });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
});

it("does not use an invitation after the sharer's membership is replaced", async () => {
  const request = await create();
  await env.DB.prepare("UPDATE workspace_members SET incarnation='replacement' WHERE user_id=?").bind(actorId).run();
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "denied", reason: "sharing_required" });
});

async function bearer(userId: typeof actorId, sessionId: string, workspace: typeof workspaceId | null) {
  return new SignJWT({ sid: sessionId, wid: workspace, region: "global" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(userId)
    .setIssuer("avalon-api").setAudience("avalon-desktop").setIssuedAt().setExpirationTime("15m")
    .sign(new TextEncoder().encode(env.SESSION_SIGNING_KEY));
}

it("routes sharing from the authenticated actor and accepts from an identity-only session", async () => {
  const app = createApp();
  const actorHeaders = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}`, "content-type": "application/json" };
  const body = { operationId: crypto.randomUUID(), parentId, emails: ["guest@example.test"], targets: [child], expiresAt: null };
  expect((await app.request("/sharing", { method: "POST", headers: actorHeaders,
    body: JSON.stringify({ ...body, actorUserId: recipientId }) }, env)).status).toBe(400);
  const created = await app.request("/sharing", { method: "POST", headers: actorHeaders, body: JSON.stringify(body) }, env);
  expect(created.status).toBe(201);
  const result = await created.json() as { invitations: Array<{ id: string }> };
  const invitationId = result.invitations[0]!.id;
  const headers = { authorization: `Bearer ${await bearer(recipientId, "recipient-session", null)}`, "content-type": "application/json" };
  const accepted = await app.request("/sharing/accept", { method: "POST", headers,
    body: JSON.stringify({ workspaceId, parentId, invitationId, token: await tokenFor(invitationId) }) }, env);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ status: "accepted", invitation: { acceptedByUserId: recipientId } });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
});

it("preserves a full member's administrative role when accepting a scope share", async () => {
  await env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status) VALUES (?,?,'member','admin','active')")
    .bind(workspaceId, recipientId).run();
  const before = await env.DB.prepare("SELECT incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first();
  expect(await room().acceptScopeInvitation(await create())).toMatchObject({ status: "accepted" });
  expect(await env.DB.prepare("SELECT access_class,role,incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first())
    .toMatchObject({ ...before, access_class: "member", role: "admin" });
});

it("preserves browser sessions and independent shares across a second workstream and guest promotion", async () => {
  const firstInvitation = await create();
  const at = new Date().toISOString();
  // Real D1 browser-session columns and the production incarnation binding.
  await env.DB.batch([
    ...["name TEXT", "slug TEXT", "timezone TEXT", "created_at TEXT"].map((column) =>
      env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN ${column}`)),
    ...["avatar_url TEXT", "timezone TEXT", "created_at TEXT", "updated_at TEXT", "platform_user_id TEXT", "onboarding_eligible INTEGER"].map((column) =>
      env.DB.prepare(`ALTER TABLE users ADD COLUMN ${column}`)),
    ...["refresh_token_hash TEXT", "created_at TEXT"].map((column) =>
      env.DB.prepare(`ALTER TABLE sessions ADD COLUMN ${column}`)),
    env.DB.prepare("UPDATE workspaces SET name='Shared workspace',slug='shared',timezone='UTC',created_at=?").bind(at),
    env.DB.prepare("UPDATE users SET name='Guest',email='guest@example.test',timezone='UTC',created_at=? WHERE id=?").bind(at,recipientId),
    env.DB.prepare("UPDATE sessions SET created_at=?").bind(at),
    env.DB.prepare(`CREATE TRIGGER bind_session_incarnation AFTER INSERT ON sessions WHEN NEW.workspace_id IS NOT NULL
      BEGIN UPDATE sessions SET workspace_incarnation=(SELECT incarnation FROM workspace_members
      WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND status='active') WHERE id=NEW.id; END`),
    env.DB.prepare("ALTER TABLE user_verified_emails ADD COLUMN verified_at TEXT"),
    env.DB.prepare("CREATE TABLE user_login_identities(provider TEXT,subject TEXT,user_id TEXT,verified_at TEXT,PRIMARY KEY(provider,subject))"),
    env.DB.prepare(`CREATE TABLE email_login_challenges (
      id TEXT PRIMARY KEY,email TEXT NOT NULL,magic_hash TEXT NOT NULL,otp_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,max_failed_attempts INTEGER,failed_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_payload_encrypted TEXT NOT NULL,delivery_sent_at INTEGER,created_at INTEGER NOT NULL,
      redeemed_at INTEGER,redemption_id TEXT,user_id TEXT,session_id TEXT UNIQUE,session_secret_encrypted TEXT)`),
    env.DB.prepare("CREATE TABLE browser_sessions(session_id TEXT PRIMARY KEY,credential_hash TEXT UNIQUE)"),
    env.DB.prepare("CREATE TABLE browser_workspace_sessions(browser_session_id TEXT,workspace_id TEXT,session_id TEXT UNIQUE,PRIMARY KEY(browser_session_id,workspace_id))"),
  ]);
  const apiEnv = { ...env,RESEND_FROM_EMAIL:"Rally <login@example.test>",
    EMAIL_LOGIN_POLICY_JSON:JSON.stringify({ otpDigits:6,ttlSeconds:600,maxFailedAttempts:3 }) };
  const browser = new BrowserSessionService(apiEnv);
  const app = createApp();
  const originHeaders = { origin:"https://app.test","content-type":"application/json" };
  const challengeId = crypto.randomUUID();
  const started = await app.request("/browser/email/start",{ method:"POST",headers:originHeaders,
    body:JSON.stringify({ challengeId,email:"Guest@Example.test" }) },apiEnv);
  expect(started.status,await started.clone().text()).toBe(202);
  const challenge = await env.DB.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?")
    .bind(challengeId).first<{ delivery_payload_encrypted:string }>();
  const email = await openEmailLoginSecret(apiEnv,challengeId,challenge!.delivery_payload_encrypted) as { text:string };
  const otp = /code is (\d+)\./u.exec(email.text)![1]!;
  const proof = { challengeId,redemptionId:crypto.randomUUID(),method:"otp",credential:otp };
  expect((await app.request("/browser/email/redeem",{},apiEnv)).status).toBe(405);
  const wrong = await app.request("/browser/email/redeem",{ method:"POST",headers:originHeaders,
    body:JSON.stringify({ ...proof,credential:"incorrect" }) },apiEnv);
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get("set-cookie")).toBeNull();
  const redeem = (request = proof) => app.request("/browser/email/redeem",{ method:"POST",headers:originHeaders,
    body:JSON.stringify(request) },apiEnv);
  const redeemed = await redeem();
  expect(redeemed.status,await redeemed.clone().text()).toBe(200);
  expect(await redeemed.json()).toMatchObject({ user:{ id:recipientId,email:"guest@example.test" },workspace:null });
  const cookieHeader = redeemed.headers.get("set-cookie")!;
  expect(cookieHeader).toContain("HttpOnly");
  expect(cookieHeader).toContain("Secure");
  const cookiePair = cookieHeader.split(";")[0]!;
  const credential = decodeURIComponent(cookiePair.slice(cookiePair.indexOf("=")+1));
  const retry = await redeem();
  expect(retry.status).toBe(200);
  expect(retry.headers.get("set-cookie")!.split(";")[0]).toBe(cookiePair);
  expect((await redeem({ ...proof,redemptionId:crypto.randomUUID() })).status).toBe(401);
  const browserHeaders = { ...originHeaders,cookie:cookiePair };
  const firstAccepted = await app.request("/browser/api/_/sharing/accept",{ method:"POST",headers:browserHeaders,
    body:JSON.stringify({ workspaceId,parentId,invitationId:firstInvitation.invitationId,token:firstInvitation.token }),
  },apiEnv);
  expect(firstAccepted.status,await firstAccepted.clone().text()).toBe(200);
  await browser.select(credential,workspaceId);
  const browserBefore = await browser.read(credential,workspaceId);
  expect(browserBefore).toMatchObject({ userId:recipientId,accessClass:"guest",role:null });
  const before = await env.DB.prepare("SELECT incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first();
  const secondParent = asWorkstreamId("00000000-0000-4000-8000-000000000096");
  const secondChild: ScopeGrantTarget = { ...child, parentId: secondParent };
  await room(secondParent).authority({ workspaceId, parentId: secondParent });
  await runInDurableObject(room(secondParent), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO workstream_metadata
      (id,workspace_id,workstream_id,region,authority_generation,title,description,preview,scope,exact_state,last_activity_at,created_at,updated_at)
      VALUES (1,?,?,'global',1,'Second parent','','','personal','idle',0,0,0)`,workspaceId,secondParent);
    state.storage.sql.exec("INSERT INTO conversation_children (substream_id,kind,created_at) VALUES ('0','main',0), (?,'child',0)", childId);
    state.storage.sql.exec("INSERT INTO main_participant_migration VALUES (1, ?, '{}', 'complete')", crypto.randomUUID());
    state.storage.sql.exec("INSERT INTO child_participant_migrations VALUES (?, ?, 'complete')", childId, crypto.randomUUID());
    new ScopeGrantStorage(state.storage, secondChild).mutate({ operationId: crypto.randomUUID(), actorUserId: actorId,
      userId: actorId, target: secondChild, active: true, expectedRevision: 0 }, "actor-membership");
  });
  const result = await room(secondParent).createScopeInvitations({ ...invitation([secondChild]), parentId: secondParent });
  if (result.status !== "created") throw new Error(JSON.stringify(result));
  const invitationId = result.invitations[0]!.id;
  const acceptance = await app.request("/browser/api/_/sharing/accept", { method:"POST",headers:browserHeaders,
    body:JSON.stringify({ workspaceId,parentId:secondParent,invitationId,token:await tokenFor(invitationId,secondParent) }),
  },env);
  expect(acceptance.status,await acceptance.clone().text()).toBe(200);
  expect(await acceptance.json()).toMatchObject({ status:"accepted",invitation:{ acceptedByUserId:recipientId } });
  expect(await browser.read(credential,workspaceId)).toEqual(browserBefore);
  expect(await env.DB.prepare("SELECT incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first()).toEqual(before);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
  expect(await room(secondParent).readScopeAccess({ userId: recipientId, target: secondChild })).toMatchObject({ allowed: true });
  expect(await room(secondParent).readScopeAccess({ userId: recipientId, target: { ...main, parentId: secondParent } })).toMatchObject({ allowed: false });
  const relationship = await env.DB.prepare("SELECT incarnation,revision FROM workspace_members WHERE workspace_id=? AND user_id=?")
    .bind(workspaceId,recipientId).first<{ incarnation:string;revision:number }>();
  expect(await promoteWorkspaceGuest(env.DB,{ workspaceId,userId:recipientId,actorUserId:actorId,
    incarnation:relationship!.incarnation,expectedRevision:relationship!.revision })).toMatchObject({ status:"promoted" });
  const browserAfter = await browser.read(credential,workspaceId);
  expect(browserAfter).toMatchObject({ sessionId:browserBefore.sessionId,userId:recipientId,accessClass:"member",role:"member" });
  const selected = await app.request("/browser/workspace/select",{ method:"POST",headers:browserHeaders,
    body:JSON.stringify({ workspaceId }) },env);
  expect(selected.status,await selected.clone().text()).toBe(200);
  expect(await selected.json()).toMatchObject({ user:{ id:recipientId },workspace:{ id:workspaceId,role:"member" } });
  for (const target of [child,secondChild]) {
    expect(await room(asWorkstreamId(target.parentId)).readScopeAccess({ userId:recipientId,target })).toMatchObject({ allowed:true,writable:true });
    expect(await room(asWorkstreamId(target.parentId)).readScopeAccess({ userId:recipientId,target:{ ...target,substreamId:asSubstreamId("0") } }))
      .toMatchObject({ allowed:false });
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?")
    .bind(workspaceId,recipientId).first()).toEqual({ n:1 });
});

it("refuses to strand a new grant ahead of its legacy participant handoff", async () => {
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM child_participant_migrations WHERE substream_id=?", childId);
  });
  expect(await room().createScopeInvitations(invitation())).toMatchObject({ status: "denied", reason: "migration_pending" });
  await runInDurableObject(room(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM scope_invitations").toArray()).toEqual([]);
  });
});

it("lists invitation summaries only when the actor can share every target", async () => {
  const childOnly = await room().createScopeInvitations(invitation([child]));
  await room().createScopeInvitations({ ...invitation([main]), emails: ["main@example.test"] });
  await room().createScopeInvitations({ ...invitation([main, child]), emails: ["both@example.test"] });
  const request = { actorUserId: actorId, target: child };
  expect(await room().listScopeInvitations(request)).toMatchObject({ status: "ready", invitations: expect.any(Array) });
  const before = await room().listScopeInvitations(request);
  if (before.status !== "ready") throw new Error("expected sharing authority");
  expect(before.invitations.map((item) => item.email).sort()).toEqual(["both@example.test", "guest@example.test"]);
  expect(JSON.stringify(before)).not.toMatch(/token|Encrypted|grantOperationIds/);
  await runInDurableObject(room(), (_instance, state) => {
    const grants = new ScopeGrantStorage(state.storage, main);
    grants.mutateCurrent({ operationId: crypto.randomUUID(), actorUserId: actorId, userId: actorId,
      target: main, active: false }, "actor-membership");
  });
  if (childOnly.status !== "created") throw new Error("expected invitation");
  expect(await room().listScopeInvitations(request)).toEqual({ status: "ready", invitations: childOnly.invitations });
  expect(await room().listScopeInvitations({ actorUserId: actorId, target: main })).toEqual({ status: "denied", reason: "sharing_required" });
  await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId).run();
  expect(await room().listScopeInvitations(request)).toEqual({ status: "denied", reason: "sharing_required" });
});

it("lists invitations through authenticated scope routing without allowing an actor override", async () => {
  const created = await room().createScopeInvitations(invitation());
  const app = createApp();
  const headers = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}`, "content-type": "application/json" };
  expect((await app.request("/sharing/list", { method: "POST", headers,
    body: JSON.stringify({ target: child, actorUserId: recipientId }) }, env)).status).toBe(400);
  const response = await app.request("/sharing/list", { method: "POST", headers, body: JSON.stringify({ target: child }) }, env);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  if (created.status !== "created") throw new Error("expected invitation");
  expect(await response.json()).toEqual({ status: "ready", invitations: created.invitations });
});

it("offers independent share scopes and refuses incomplete workstream coverage", async () => {
  const address = { workspaceId, parentId, actorUserId: actorId };
  const parent: ScopeGrantTarget = { kind: "workstream", workspaceId, parentId };
  expect(await room().scopeSharingOptions(address)).toMatchObject({ completeWorkstreamTargets: null });
  await runInDurableObject(room(), (_instance, state) => {
    new ScopeGrantStorage(state.storage, parent).mutate({ operationId: crypto.randomUUID(),
      actorUserId: actorId, userId: actorId, target: parent, active: true, expectedRevision: 0 }, "actor-membership");
  });
  const options = await room().scopeSharingOptions(address);
  expect(options.scopes.map((scope) => scope.target)).toEqual([parent, main, child]);
  expect(options.completeWorkstreamTargets).toEqual([parent, child]);
  expect(await room().createScopeInvitations({ ...invitation([parent]), completeWorkstream: true }))
    .toEqual({ status: "denied", reason: "scope_changed" });
  const request = { ...invitation([parent, child]), completeWorkstream: true };
  const created = await room().createScopeInvitations(request);
  expect(created.status).toBe("created");
  // A later restricted child does not rewrite an already committed invitation.
  const laterChild = "00000000-0000-4000-8000-000000000097";
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("INSERT INTO conversation_children(substream_id,kind,status,created_at) VALUES (?,'child','ready',0)", laterChild);
  });
  expect((await room().scopeSharingOptions(address)).completeWorkstreamTargets).toBeNull();
  expect(await room().createScopeInvitations(request)).toEqual(created);
  expect(await room().createScopeInvitations({ ...request, operationId: crypto.randomUUID() }))
    .toEqual({ status: "denied", reason: "scope_changed" });
});


it("manages accepted grants by exact scope and preserves later shares on retry", async () => {
  await room().acceptScopeInvitation(await create([child, main]));
  await env.DB.prepare("UPDATE users SET name='Guest',email='guest@example.test' WHERE id=?").bind(recipientId).run();
  const app = createApp();
  const headers = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}`, "content-type": "application/json" };
  const listed = await app.request("/sharing/grants/list", { method: "POST", headers, body: JSON.stringify({ target: child }) }, env);
  expect(listed.status).toBe(200); expect(listed.headers.get("cache-control")).toBe("no-store");
  const result = await listed.json() as { status: string; grants: Array<{ grant: { id: string; userId: string; revision: number; target: ScopeGrantTarget }; name: string; email: string }> };
  expect(result.status).toBe("ready");
  expect(result.grants.every((entry) => JSON.stringify(entry.grant.target) === JSON.stringify(child))).toBe(true);
  const guest = result.grants.find((entry) => entry.grant.userId === recipientId)!;
  expect(guest).toMatchObject({ name: "Guest", email: "guest@example.test" });
  const request = { operationId: crypto.randomUUID(), target: child, userId: recipientId, expectedRevision: guest.grant.revision };
  expect((await app.request("/sharing/grants/revoke", { method: "POST", headers,
    body: JSON.stringify({ ...request, actorUserId: recipientId }) }, env)).status).toBe(400);
  const revoke = () => app.request("/sharing/grants/revoke", { method: "POST", headers, body: JSON.stringify(request) }, env);
  const removed = await revoke(); expect(removed.status).toBe(200);
  const receipt = await removed.json() as { status: string; grant: { revision: number; active: boolean } };
  expect(receipt).toMatchObject({ status: "committed", grant: { active: false } });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: false });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: true });
  const after = await room().listManagedScopeGrants({ actorUserId: actorId, target: child });
  if (after.status !== "ready") throw new Error("expected authority");
  expect(after.grants.some((entry) => entry.grant.userId === recipientId)).toBe(false);
  await room().mutateScopeGrant({ ...request, operationId: crypto.randomUUID(), actorUserId: actorId, active: true,
    expectedRevision: receipt.grant.revision });
  expect(await (await revoke()).json()).toEqual(receipt);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
  expect(await room().mutateScopeGrant({ ...request, operationId: crypto.randomUUID(), actorUserId: actorId, active: false }))
    .toMatchObject({ status: "conflict" });
  await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId).run();
  expect(await room().listManagedScopeGrants({ actorUserId: actorId, target: child }))
    .toEqual({ status: "denied", reason: "sharing_required" });
});


it("rechecks management authority after profile reads interleave with suspension", async () => {
  let release = () => {}, started = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { started = resolve; });
  await runInDurableObject(room(), (instance) => {
    const target = instance as unknown as { env: Env };
    const original = target.env.DB;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(current, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(current.bind(...values));
        if (property === "first") return async () => {
          const value = await current.first(); started(); await gate; return value;
        };
        const value = Reflect.get(current, property);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });
    const database = new Proxy(original, {
      get(current, property) {
        if (property === "prepare") return (sql: string) => sql === "SELECT name,email FROM users WHERE id=?"
          ? wrap(current.prepare(sql)) : current.prepare(sql);
        const value = Reflect.get(current, property);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });
    target.env = new Proxy(target.env, { get: (current, property, receiver) => property === "DB" ? database : Reflect.get(current, property, receiver) });
  });
  const listing = room().listManagedScopeGrants({ actorUserId: actorId, target: child });
  try {
    await reading;
    await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId).run();
  } finally { release(); }
  expect(await listing).toEqual({ status: "denied", reason: "sharing_required" });
});
