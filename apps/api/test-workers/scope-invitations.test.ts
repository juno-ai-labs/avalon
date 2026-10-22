import type { Env } from "../src/env";
import { SignJWT } from "jose";
import { createApp } from "../src/app";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { WorkspaceRelationshipSchema, type ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { SCOPE_INVITATION_INDEX_ALARM, ScopeInvitationStorage } from "../src/durable-objects/scope-invitation-storage";
import { ScheduledAlarmStore } from "../src/durable-objects/scheduled-alarms";
import { decryptString } from "../src/lib/crypto";
import { BrowserSessionService } from "../src/services/browser-session-service";
import { RegionalOnboardingService } from "../src/services/platform-onboarding-service";
import { openEmailLoginSecret } from "../src/services/email-login-service";
import { claimScopeInvitations } from "../src/services/scope-invitation-claims";
import { promoteWorkspaceGuest } from "../src/services/workspace-relationship-service";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";
import { changeRelationships } from "./helpers/workspace-relationship-events";
import { hostedParentStub, insertChannelRow, withHostedParent } from "./helpers/hosted-parent";
import { conversationObjectName } from "../src/durable-objects/names";
import { boot, seedParticipantMessage, seedOpenWorkstreamAuthority, seedWorkstreamRoot } from "./helpers/substream-fixture";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000091");
const parentId = asWorkstreamId("00000000-0000-4000-8000-000000000092");
const actorId = asUserId("00000000-0000-4000-8000-000000000093");
/** Already signs in with guest@example.test, so a share to that address is theirs as it is made. */
const recipientId = asUserId("00000000-0000-4000-8000-000000000094");
/** Someone with no account yet: a share to them waits for their first sign-in. */
const newcomerId = asUserId("00000000-0000-4000-8000-000000000098");
const NEWCOMER = "newcomer@example.test";
const childId = asSubstreamId("00000000-0000-4000-8000-000000000095");
const child: ScopeGrantTarget = { kind: "conversation", workspaceId, parentId, substreamId: childId };
const main: ScopeGrantTarget = { ...child, substreamId: asSubstreamId("0") };
/** The Organization object, which hosts every Channel parent in the workspace. */
const room = () => hostedParentStub(env, workspaceId);
const invitation = (targets: ScopeGrantTarget[] = [child], emails = ["guest@example.test"]) => ({ operationId: crypto.randomUUID(),
  workspaceId, parentId, actorUserId: actorId, emails, targets, expiresAt: null });

async function deliveredParts(id: string, parent = parentId): Promise<{ text: string; html?: string }> {
  const encrypted = await runInDurableObject(room(), (_instance, state) =>
    new ScopeInvitationStorage(state.storage, parent).read(id)!.deliveryEncrypted);
  const sealed = JSON.parse(encrypted) as { ciphertext: string; iv: string };
  return JSON.parse(await decryptString(sealed.ciphertext, sealed.iv,
    env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)) as { text: string; html?: string };
}

/** The URL the recipient receives, read out of the durable encrypted body the sender delivers. */
async function deliveredLink(id: string, parent = parentId): Promise<URL> {
  const link = (await deliveredParts(id, parent)).text.split("\n").find((line) => line.startsWith("https://app.test/"));
  if (!link) throw new Error("invitation link missing");
  return new URL(link);
}

async function create(targets: ScopeGrantTarget[] = [child], emails = ["guest@example.test"]) {
  const result = await room().createScopeInvitations(invitation(targets, emails));
  if (result.status !== "created" || !result.invitations[0]) throw new Error(JSON.stringify(result));
  return result.invitations[0];
}

/** Where a pending share for an address is looked up from. */
const routes = async (email: string) => (await env.DB.prepare(
  "SELECT workspace_id, parent_id FROM scope_share_recipients WHERE email = ?").bind(email).all()).results;

/** The newcomer verifies their mailbox: from here, signing in claims what waits for it. */
async function verifyNewcomer() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, NULL)").bind(newcomerId),
    env.DB.prepare("INSERT INTO user_verified_emails VALUES (?, ?)").bind(NEWCOMER, newcomerId),
  ]);
}

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'Shared workspace')").bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      revision INTEGER NOT NULL DEFAULT 1, joined_at TEXT, last_seen_at TEXT, PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status,incarnation) VALUES (?,?,'member','owner','active','actor-membership')")
      .bind(workspaceId, actorId),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, analytics_person_id TEXT, name TEXT, email TEXT)"),
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, 'Adam Owner'), (?, NULL)").bind(actorId, recipientId),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT,
      region TEXT, workspace_incarnation TEXT, revoked_at TEXT, expires_at TEXT, impersonator_user_id TEXT)`),
    env.DB.prepare("INSERT INTO sessions VALUES ('actor-session', ?, ?, 'global', 'actor-membership', NULL, '2099-01-01T00:00:00.000Z', NULL)").bind(actorId, workspaceId),
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
    env.DB.prepare("INSERT INTO user_verified_emails VALUES ('guest@example.test',?)").bind(recipientId),
  ]);
  await seedParent(parentId, "Private parent", [main, child]);
});

/**
 * A Channel parent with a Main and one child, both past the participant
 * handoff, where the actor holds a grant on each of `actorTargets`.
 */
async function seedParent(id: string, title: string, actorTargets: ScopeGrantTarget[]) {
  await room().authority({ workspaceId, parentId: id });
  await withHostedParent(room(), id, (parent, state) => {
    // The title lives only on the directory row; the parent's own row is identity.
    state.storage.sql.exec(`INSERT INTO parent_metadata
      (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
      VALUES (?,'workstream',?,'global',1,0,0)`, id, workspaceId);
    insertChannelRow(state, id, title);
    state.storage.sql.exec("INSERT INTO parent_children (parent_id,substream_id,kind,created_at) VALUES (?,'0','main',0), (?,?,'child',0)", id, id, childId);
    state.storage.sql.exec("INSERT INTO parent_participant_migrations (parent_id, substream_id, transfer_id, incarnations_json, phase) VALUES (?, '0', ?, '{}', 'complete')", id, crypto.randomUUID());
    state.storage.sql.exec("INSERT INTO parent_participant_migrations (parent_id, substream_id, transfer_id, incarnations_json, phase) VALUES (?, ?, ?, NULL, 'complete')", id, childId, crypto.randomUUID());
    const grants = parent['scopeGrants']({ workspaceId, parentId: id });
    for (const target of actorTargets) grants.mutate({ operationId: crypto.randomUUID(), actorUserId: actorId,
      userId: actorId, target, active: true, expectedRevision: 0 }, "actor-membership");
  });
}

/** The real D1 columns browser email sign-in and the session ledger read, on top of this file's slim fixture. */
async function prepareBrowserSignIn() {
  const at = new Date().toISOString();
  await env.DB.batch([
    ...["slug TEXT", "timezone TEXT", "created_at TEXT"].map((column) =>
      env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN ${column}`)),
    ...["avatar_url TEXT", "timezone TEXT DEFAULT 'UTC'", "created_at TEXT", "updated_at TEXT", "platform_user_id TEXT", "onboarding_eligible INTEGER", "signup_flow_id TEXT", "signup_client_platform TEXT", "signup_path TEXT", "signup_completed_at TEXT", "onboarding_introduced INTEGER DEFAULT 0"].map((column) =>
      env.DB.prepare(`ALTER TABLE users ADD COLUMN ${column}`)),
    ...["refresh_token_hash TEXT", "created_at TEXT"].map((column) =>
      env.DB.prepare(`ALTER TABLE sessions ADD COLUMN ${column}`)),
    env.DB.prepare("UPDATE workspaces SET name='Shared workspace',slug='shared',timezone='UTC',created_at=?").bind(at),
    env.DB.prepare("UPDATE users SET name='Guest',email='guest@example.test',timezone='UTC',created_at=? WHERE id=?").bind(at, recipientId),
    env.DB.prepare(`CREATE TRIGGER bind_session_incarnation AFTER INSERT ON sessions WHEN NEW.workspace_id IS NOT NULL
      BEGIN UPDATE sessions SET workspace_incarnation=(SELECT incarnation FROM workspace_members
      WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND status='active') WHERE id=NEW.id; END`),
    env.DB.prepare("ALTER TABLE user_verified_emails ADD COLUMN verified_at TEXT"),
    env.DB.prepare("CREATE TABLE user_login_identities(provider TEXT,subject TEXT,user_id TEXT,verified_at TEXT,PRIMARY KEY(provider,subject))"),
    env.DB.prepare(`CREATE TABLE email_login_challenges (
      id TEXT PRIMARY KEY,email TEXT NOT NULL,magic_hash TEXT NOT NULL,otp_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,max_failed_attempts INTEGER,failed_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_payload_encrypted TEXT NOT NULL,delivery_sent_at INTEGER,created_at INTEGER NOT NULL,
      redeemed_at INTEGER,redemption_id TEXT,user_id TEXT,session_id TEXT UNIQUE,session_secret_encrypted TEXT,telemetry_flow_id TEXT,telemetry_client_platform TEXT,signup_created INTEGER DEFAULT 0)`),
    env.DB.prepare("CREATE TABLE browser_sessions(session_id TEXT PRIMARY KEY,credential_hash TEXT UNIQUE)"),
    env.DB.prepare("CREATE TABLE browser_workspace_sessions(browser_session_id TEXT,workspace_id TEXT,session_id TEXT UNIQUE,PRIMARY KEY(browser_session_id,workspace_id))"),
  ]);
  return { ...env, RESEND_FROM_EMAIL: "Rally <login@example.test>",
    EMAIL_LOGIN_POLICY_JSON: JSON.stringify({ otpDigits: 6, ttlSeconds: 600, maxFailedAttempts: 3 }) };
}

const originHeaders = { origin: "https://app.test", "content-type": "application/json" };

/** A real browser email sign-in by one-time code: what a recipient does after opening their link. */
async function signInByCode(apiEnv: Env, address: string) {
  const app = createApp();
  const challengeId = crypto.randomUUID();
  const started = await app.request("/browser/email/start", { method: "POST", headers: originHeaders,
    body: JSON.stringify({ challengeId, email: address }) }, apiEnv);
  expect(started.status, await started.clone().text()).toBe(202);
  const challenge = await env.DB.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?")
    .bind(challengeId).first<{ delivery_payload_encrypted: string }>();
  const email = await openEmailLoginSecret(apiEnv, challengeId, challenge!.delivery_payload_encrypted) as { text: string };
  const otp = /code is (\d+)\./u.exec(email.text)![1]!;
  const proof = { challengeId, redemptionId: crypto.randomUUID(), method: "otp", credential: otp };
  const redeem = (request: typeof proof) => app.request("/browser/email/redeem", { method: "POST", headers: originHeaders,
    body: JSON.stringify(request) }, apiEnv);
  return { app, proof, redeem };
}

it("retries one email batch without replacing the share or its durable delivery", async () => {
  const request = invitation();
  const first = await room().createScopeInvitations(request);
  expect(first.status).toBe("created");
  expect(await room().createScopeInvitations(request)).toEqual(first);
  expect(await room().createScopeInvitations({ ...request, emails: ["someone-else@example.test"] }))
    .toMatchObject({ status: "denied", reason: "operation_conflict" });
  await runDurableObjectAlarm(room());
  await runInDurableObject(room(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM parent_invitations WHERE parent_id = ?", parentId).toArray()).toHaveLength(1);
    // Delivered even though it was claimed as it was made: the email is how
    // someone who already has an account hears of the share.
    expect(state.storage.sql.exec<{ delivered_at: number }>("SELECT delivered_at FROM parent_invitations WHERE parent_id = ?", parentId).one().delivered_at).toBeGreaterThan(0);
  });
});

it("gives a share to someone who already signs in with that address as it is made, child without Main", async () => {
  const share = await create();
  expect(share).toMatchObject({ status: "accepted", acceptedByUserId: recipientId });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true, writable: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: false });
  expect(await env.DB.prepare("SELECT access_class,role FROM workspace_members WHERE user_id=?").bind(recipientId).first())
    .toEqual({ access_class: "guest", role: null });
  // Nothing is left to claim for that address here, so nothing points here for it.
  expect(await routes("guest@example.test")).toEqual([]);
});

it("holds a share for an address with no account, and gives it to whoever verifies that address", async () => {
  const share = await create([child], [NEWCOMER]);
  expect(share).toMatchObject({ status: "pending", acceptedByUserId: null });
  expect(await routes(NEWCOMER)).toEqual([{ workspace_id: workspaceId, parent_id: parentId }]);
  // Someone else signing in claims nothing: the share belongs to the mailbox.
  // Even when a stray lookup row (from a share later revoked, say) sends their
  // claim to this very Channel.
  await env.DB.prepare("INSERT INTO scope_share_recipients VALUES ('guest@example.test', ?, ?, '')").bind(workspaceId, parentId).run();
  await claimScopeInvitations(env, recipientId);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: false });

  await verifyNewcomer();
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: true, writable: true });
  expect(await room().readScopeAccess({ userId: newcomerId, target: main })).toMatchObject({ allowed: false });
  expect(await env.DB.prepare("SELECT access_class FROM workspace_members WHERE user_id=?").bind(newcomerId).first())
    .toEqual({ access_class: "guest" });
  expect(await routes(NEWCOMER)).toEqual([]);
});

it("claims for an address Global verified that this deployment has not recorded", async () => {
  // Discovery's case: a person known here only through the platform link,
  // whose verified address arrives with Global's identity.
  await create([child], [NEWCOMER]);
  await env.DB.prepare("INSERT INTO users (id, name) VALUES (?, NULL)").bind(newcomerId).run();
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: false });
  await claimScopeInvitations(env, newcomerId, "Newcomer@Example.test");
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: true });
});

it("claims on a real browser sign-in by code, with no acceptance step after it", async () => {
  await create([child], [NEWCOMER]);
  const apiEnv = await prepareBrowserSignIn();
  const { app, proof, redeem } = await signInByCode(apiEnv, "Newcomer@Example.test");
  const redeemed = await redeem(proof);
  expect(redeemed.status, await redeemed.clone().text()).toBe(200);
  const signedIn = await redeemed.json() as { user: { id: string } };
  expect(await room().readScopeAccess({ userId: asUserId(signedIn.user.id), target: child }))
    .toMatchObject({ allowed: true, writable: true });
  // Straight into the Organization the share named: select needs no other step.
  const cookie = redeemed.headers.get("set-cookie")!.split(";")[0]!;
  const selected = await app.request("/browser/workspace/select", { method: "POST",
    headers: { ...originHeaders, cookie }, body: JSON.stringify({ workspaceId }) }, apiEnv);
  expect(selected.status, await selected.clone().text()).toBe(200);
  expect(await selected.json()).toMatchObject({ user: { id: signedIn.user.id }, workspace: { id: workspaceId } });
});

it("claims during regional discovery, which desktop sign-in and workspace switching use", async () => {
  await create([child], [NEWCOMER]);
  const at = new Date().toISOString();
  await env.DB.batch([
    ...["slug TEXT", "timezone TEXT", "created_at TEXT"].map((column) => env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN ${column}`)),
    env.DB.prepare("UPDATE workspaces SET slug='shared', timezone='UTC', created_at=?").bind(at),
    ...["platform_user_id TEXT", "google_subject TEXT", "avatar_url TEXT", "updated_at TEXT", "presentation_json TEXT"]
      .map((column) => env.DB.prepare(`ALTER TABLE users ADD COLUMN ${column}`)),
    // Known here only through the platform link: no verified-address row.
    env.DB.prepare("INSERT INTO users (id, name, email, platform_user_id, google_subject) VALUES (?, 'Newcomer', ?, ?, 'google-newcomer')")
      .bind(newcomerId, NEWCOMER, newcomerId),
    env.DB.prepare(`CREATE TABLE workspace_invitations (id TEXT, workspace_id TEXT, email TEXT, role TEXT,
      invited_by_user_id TEXT, expires_at TEXT, accepted_at TEXT, revoked_at TEXT, created_at TEXT)`),
    env.DB.prepare("CREATE TABLE demo_operations (workspace_id TEXT, ready_at TEXT)"),
    env.DB.prepare(`CREATE TABLE user_login_identities (provider TEXT NOT NULL, subject TEXT NOT NULL,
      user_id TEXT NOT NULL, verified_at TEXT NOT NULL, PRIMARY KEY (provider, subject))`),
  ]);
  const discovery = await new RegionalOnboardingService(env).discover({ platformUserId: newcomerId,
    loginIdentities: [{ provider: "google", subject: "google-newcomer" }], email: "Newcomer@Example.test", name: "Newcomer", avatarUrl: null,
    timezone: "UTC", createdAt: at });
  expect(discovery.workspaces).toEqual([expect.objectContaining({ id: workspaceId, accessClass: "guest" })]);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: true });
});

it("indexes a share that was pending before lookup rows existed, once, on the object's own schedule", async () => {
  // Such a share has no lookup row. Migration 93 schedules one alarm per
  // parent with a pending share; the alarm writes the rows.
  await create([child], [NEWCOMER]);
  await env.DB.prepare("DELETE FROM scope_share_recipients").run();
  await runInDurableObject(room(), (_instance, state) => {
    new ScheduledAlarmStore(state.storage.sql).schedule({ kind: SCOPE_INVITATION_INDEX_ALARM, key: parentId, dueAt: Date.now() });
  });
  await runDurableObjectAlarm(room());
  expect(await routes(NEWCOMER)).toEqual([{ workspace_id: workspaceId, parent_id: parentId }]);
  await verifyNewcomer();
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: true });
});

it("signs in without the share, rather than failing, when the claim lookup itself fails", async () => {
  await create([child], [NEWCOMER]);
  await verifyNewcomer();
  const broken = { ...env, DB: new Proxy(env.DB, { get: (database, property, receiver) => property === "batch"
    ? () => Promise.reject(new Error("D1_ERROR: simulated outage"))
    : Reflect.get(database, property, receiver) }) } as typeof env;
  await expect(claimScopeInvitations(broken, newcomerId)).resolves.toBeUndefined();
  // The lookup row is untouched, so the next sign-in claims it.
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: true });
});

it("keeps the lookup row for a share recorded while a cleanup was deleting it", async () => {
  // Revoking the address's last share deletes its row. A new share to the same
  // address, recorded while that delete is in flight, must keep a row.
  const first = await create([child], [NEWCOMER]);
  await runInDurableObject(room(), async (instance) => {
    const target = instance as unknown as { env: Env };
    const originalEnv = target.env;
    let raced = false;
    const database = new Proxy(originalEnv.DB, { get: (current, property) => property === "batch"
      ? async (statements: D1PreparedStatement[]) => {
        if (!raced && JSON.stringify(statements.map((statement) => (statement as unknown as { statement?: string }).statement ?? String(statement))).includes("DELETE")) {
          raced = true;
          // The new share lands, row and all, before the delete does.
          target.env = originalEnv;
          await instance.createScopeInvitations(invitation([child], [NEWCOMER]));
          target.env = proxied;
        }
        return current.batch(statements);
      }
      : Reflect.get(current, property) });
    const proxied = new Proxy(originalEnv, { get: (current, property, receiver) => property === "DB" ? database : Reflect.get(current, property, receiver) });
    target.env = proxied;
    try {
      expect(await instance.revokeScopeInvitation({ workspaceId, parentId, actorUserId: actorId,
        invitationId: first.id, expectedRevision: 1 })).toMatchObject({ status: "revoked" });
      expect(raced).toBe(true);
    } finally { target.env = originalEnv; }
  });
  expect(await routes(NEWCOMER)).toEqual([{ workspace_id: workspaceId, parent_id: parentId }]);
});

it("reports a revocation as done when only its lookup-row cleanup fails", async () => {
  const share = await create([child], [NEWCOMER]);
  await runInDurableObject(room(), async (instance) => {
    const target = instance as unknown as { env: Env };
    const originalEnv = target.env;
    const database = new Proxy(originalEnv.DB, { get: (current, property) => property === "batch"
      ? () => Promise.reject(new Error("D1_ERROR: simulated outage"))
      : Reflect.get(current, property) });
    target.env = new Proxy(originalEnv, { get: (current, property, receiver) => property === "DB" ? database : Reflect.get(current, property, receiver) });
    try {
      // Committed in the object; the stale row it leaves is harmless and a
      // later claim removes it. Reporting failure would send the sharer into
      // a retry that can only answer `revision_conflict`.
      expect(await instance.revokeScopeInvitation({ workspaceId, parentId, actorUserId: actorId,
        invitationId: share.id, expectedRevision: 1 })).toMatchObject({ status: "revoked" });
    } finally { target.env = originalEnv; }
  });
  expect(await routes(NEWCOMER)).toHaveLength(1);
  await verifyNewcomer();
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: false });
  expect(await routes(NEWCOMER)).toEqual([]);
});

it("never restores a revoked grant or a removed membership when a claim runs again", async () => {
  const share = await create();
  await withHostedParent(room(), parentId, (parent) => {
    const grants = parent['scopeGrants'](child);
    grants.mutateCurrent({ operationId: crypto.randomUUID(), actorUserId: actorId, userId: recipientId, target: child, active: false },
      grants.forUser(recipientId)[0]!.membershipIncarnation);
  });
  await claimScopeInvitations(env, recipientId);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: false });
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(recipientId));
  await claimScopeInvitations(env, recipientId);
  expect(await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(recipientId).first()).toBeNull();
  expect((await room().listScopeInvitations({ actorUserId: actorId, target: child }))).toMatchObject({
    status: "ready", invitations: [{ id: share.id, status: "accepted", acceptedByUserId: recipientId }] });
});

it("never gives a revoked share to the address it was for", async () => {
  const share = await create([child], [NEWCOMER]);
  expect(await room().revokeScopeInvitation({ workspaceId, parentId, actorUserId: actorId,
    invitationId: share.id, expectedRevision: 1 })).toMatchObject({ status: "revoked" });
  expect(await routes(NEWCOMER)).toEqual([]);
  await verifyNewcomer();
  await claimScopeInvitations(env, newcomerId);
  expect(await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(newcomerId).first()).toBeNull();
});

it("never gives an expired share to the address it was for", async () => {
  const created = await room().createScopeInvitations({ ...invitation([child], [NEWCOMER]), expiresAt: Date.now() + 60_000 });
  if (created.status !== "created") throw new Error(JSON.stringify(created));
  const invitationId = created.invitations[0]!.id;
  await runInDurableObject(room(), (_instance, state) => {
    // The deadline lives in the stored summary, so age it there.
    const stored = state.storage.sql.exec<{ summary_json: string }>(
      "SELECT summary_json FROM parent_invitations WHERE parent_id = ? AND id = ?", parentId, invitationId).one();
    state.storage.sql.exec("UPDATE parent_invitations SET summary_json = ? WHERE parent_id = ? AND id = ?",
      JSON.stringify({ ...JSON.parse(stored.summary_json), expiresAt: Date.now() - 1_000 }), parentId, invitationId);
  });
  await verifyNewcomer();
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: false });
  expect(await routes(NEWCOMER)).toEqual([]);
});

it("commits all target grants with the claim, or leaves the share pending after rolling every grant back", async () => {
  const share = await create([main, child], [NEWCOMER]);
  await verifyNewcomer();
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec(`CREATE TRIGGER reject_child_grant BEFORE INSERT ON parent_grants
      WHEN NEW.user_id='${newcomerId}' AND NEW.substream_id='${childId}'
      BEGIN SELECT RAISE(ABORT,'simulated child write failure'); END`);
  });
  // Catch the deliberate runtime rejection inside the object: the test RPC
  // bridge otherwise reports the same expected rejection as unhandled as well.
  const claim = { workspaceId, parentId, userId: newcomerId, emails: [NEWCOMER] };
  await expect(runInDurableObject(room(), (instance) => instance.claimScopeInvitations(claim)))
    .rejects.toThrow("simulated child write failure");
  await withHostedParent(room(), parentId, (parent, state) => {
    expect(parent['scopeGrants'](child).forUser(newcomerId)).toEqual([]);
    expect(parent['scopeGrants'](main).forUser(newcomerId)).toEqual([]);
    expect(new ScopeInvitationStorage(state.storage, parentId).read(share.id)?.summary.status).toBe("pending");
    state.storage.sql.exec("DROP TRIGGER reject_child_grant");
  });
  // The lookup row survived the failure, so the next sign-in tries again.
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: main })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: true });
});

it("retires, rather than grants, a share whose sharer's membership was replaced", async () => {
  const share = await create([child], [NEWCOMER]);
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspace_members SET incarnation='replacement' WHERE user_id=?").bind(actorId));
  await verifyNewcomer();
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: false });
  // Rejoining never restores the old share's authority, so it cannot become
  // claimable: it is retired, and its lookup row stops costing every sign-in.
  await withHostedParent(room(), parentId, (_parent, state) => {
    expect(new ScopeInvitationStorage(state.storage, parentId).read(share.id)?.summary.status).toBe("revoked");
  });
  expect(await routes(NEWCOMER)).toEqual([]);
});

it("keeps the lookup row for a share that cannot be claimed yet", async () => {
  await create([child], [NEWCOMER]);
  // The sharer loses the share but keeps their membership: that can change back.
  await withHostedParent(room(), parentId, (parent) => {
    const grants = parent['scopeGrants'](child);
    grants.mutateCurrent({ operationId: crypto.randomUUID(), actorUserId: actorId, userId: actorId, target: child, active: false }, "actor-membership");
  });
  await verifyNewcomer();
  await claimScopeInvitations(env, newcomerId);
  expect(await room().readScopeAccess({ userId: newcomerId, target: child })).toMatchObject({ allowed: false });
  expect(await routes(NEWCOMER)).toHaveLength(1);
});

async function bearer(userId: typeof actorId, sessionId: string, workspace: typeof workspaceId | null) {
  return new SignJWT({ sid: sessionId, wid: workspace, region: "global" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(userId)
    .setIssuer("avalon-api").setAudience("avalon-desktop").setIssuedAt().setExpirationTime("15m")
    .sign(new TextEncoder().encode(env.SESSION_SIGNING_KEY));
}

it("answers a sharing request for a Space id as a scope that does not exist", async () => {
  // Grants, invitations and sharing are Channel-only. The Organization object
  // refuses a Space id, and the route turns that into a 404 rather than a 500.
  const spaceId = "00000000-0000-7000-8000-0000000005a1";
  await runInDurableObject(hostedParentStub(env, workspaceId), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO parent_metadata
      (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
      VALUES (?,'space',?,'global',1,0,0)`, spaceId, workspaceId);
  });
  const app = createApp();
  const actorHeaders = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}` };
  const response = await app.request(`/sharing/${spaceId}/options`, { headers: actorHeaders }, env);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "scope_not_found" } });
});

it("routes sharing from the authenticated actor, and there is no acceptance route", async () => {
  const app = createApp();
  const actorHeaders = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}`, "content-type": "application/json" };
  const body = { operationId: crypto.randomUUID(), parentId, emails: ["guest@example.test"], targets: [child], expiresAt: null };
  expect((await app.request("/sharing", { method: "POST", headers: actorHeaders,
    body: JSON.stringify({ ...body, actorUserId: recipientId }) }, env)).status).toBe(400);
  const created = await app.request("/sharing", { method: "POST", headers: actorHeaders, body: JSON.stringify(body) }, env);
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ status: "created", invitations: [{ acceptedByUserId: recipientId }] });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
  expect((await app.request("/sharing/accept", { method: "POST", headers: actorHeaders, body: "{}" }, env)).status).toBe(404);
});

it("publishes the guest relationship a share created without waiting for the cron", async () => {
  // The slice of D1's durable relationship publication this route reads: the
  // intent row the membership trigger writes, as migration 0109 does.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workspace_relationship_deliveries (sequence INTEGER PRIMARY KEY,
      workspace_id TEXT, user_id TEXT, incarnation TEXT, revision INTEGER, change_kind TEXT, access_class TEXT,
      role TEXT, status TEXT, dispatched_at TEXT, processed_at TEXT)`),
    env.DB.prepare(`CREATE TRIGGER workspace_member_delivery_insert AFTER INSERT ON workspace_members BEGIN
      INSERT INTO workspace_relationship_deliveries
        (workspace_id, user_id, incarnation, revision, change_kind, access_class, role, status)
      VALUES (NEW.workspace_id, NEW.user_id, NEW.incarnation, NEW.revision, 'upsert', NEW.access_class, NEW.role, NEW.status);
    END`),
  ]);
  const send = vi.spyOn(env.ACCESS_REVOCATION_QUEUE, "send");
  const app = createApp();
  const headers = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}`, "content-type": "application/json" };
  const created = await app.request("/sharing", { method: "POST", headers, body: JSON.stringify({
    operationId: crypto.randomUUID(), parentId, emails: ["guest@example.test"], targets: [child], expiresAt: null }) }, env);
  expect(created.status).toBe(201);
  await vi.waitFor(async () => {
    expect(await env.DB.prepare("SELECT dispatched_at FROM workspace_relationship_deliveries WHERE user_id = ?")
      .bind(recipientId).first()).toEqual({ dispatched_at: expect.any(String) as unknown });
  }, { timeout: 5_000, interval: 25 });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    kind: "workspace_relationship_changed", removed: false,
    relationship: expect.objectContaining({ userId: recipientId, accessClass: "guest" }) as unknown,
  }));
});

it("names the field when an invitation is asked to expire past the end of time", async () => {
  const app = createApp();
  const headers = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}`, "content-type": "application/json" };
  // Past the largest instant a `Date` can hold and still a safe integer, which
  // is the whole band `z.number().int()` lets through. Anything larger was
  // already refused for not being an integer, which is why the ceiling has to
  // be the `Date` range rather than that one.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const response = await app.request("/sharing", { method: "POST", headers, body: JSON.stringify({
      operationId: crypto.randomUUID(), parentId, emails: [NEWCOMER], targets: [child],
      expiresAt: 9_000_000_000_000_000 }) }, { ...env, LOG_LEVEL: "warn" as const });
    // A rejection, not a 500, and the diagnostic names the field.
    expect(response.status).toBe(400);
    expect(warn.mock.calls.map(([entry]) => entry as { validation_issues?: unknown }).flatMap((entry) =>
      Array.isArray(entry?.validation_issues) ? entry.validation_issues : []))
      .toContainEqual(expect.objectContaining({ path: "expiresAt" }));
  } finally {
    warn.mockRestore();
  }
  expect(await routes(NEWCOMER)).toEqual([]);
});

it("emails the conversation's own address, carrying no secret", async () => {
  const share = await create([child], [NEWCOMER]);
  const link = await deliveredLink(share.id);
  // A child share opens the child; nothing in the link is a credential, so a
  // forwarded copy opens nothing for anyone who cannot sign in as the address.
  expect(link.toString()).toBe(`https://app.test/app/workspaces/global/${workspaceId}/workstreams/${parentId}/substreams/${childId}`);
  const whole = await create([main], ["main@example.test"]);
  expect((await deliveredLink(whole.id)).toString()).toBe(`https://app.test/app/workspaces/global/${workspaceId}/workstreams/${parentId}`);
});


/**
 * A real conversation object with a real transcript in it, so a preview reads
 * one rather than failing. Every other test in this file leaves these objects
 * unprovisioned, which is what makes the preview absent there.
 */
async function seedConversation(substreamId: string, turns: Array<{ text: string; messageType?: "text" | "system" }>) {
  await seedOpenWorkstreamAuthority(env.DB);
  const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", workspaceId, parentId, asSubstreamId(substreamId))));
  await boot(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    // The fixture's root always calls itself Main; a child object has to say
    // which substream it is, or the port refuses the read as a misroute.
    state.storage.sql.exec("UPDATE substream_agent_identity SET external_substream_id = ? WHERE id = 1", substreamId);
    let sequence = 0;
    for (const turn of turns) {
      sequence += 1;
      await seedParticipantMessage(state, {
        id: `00000000-0000-7000-8000-${substreamId.slice(-4)}${String(sequence).padStart(8, "0")}`,
        sequence, text: turn.text, authorType: "human", messageType: turn.messageType ?? "text",
      });
    }
  });
}


it("quotes the conversation being offered and nothing beside it", async () => {
  await seedConversation("0", [{ text: "Main transcript, not shared here." }]);
  await seedConversation(childId, [
    { text: "A system notice, which is not conversation.", messageType: "system" },
    { text: "Child transcript, which is what was offered." },
  ]);

  const offered = await room().createScopeInvitations(invitation([child], [NEWCOMER]));
  if (offered.status !== "created") throw new Error(JSON.stringify(offered));
  const { text } = await deliveredParts(offered.invitations[0]!.id);
  // The whole point of a scoped invitation: an offer of one conversation must
  // not put a sibling's or the parent's work into an unauthenticated mailbox.
  expect(text).toContain("Child transcript, which is what was offered.");
  expect(text).not.toContain("Main transcript");
  // And only what people said. Tool output and system notices are not
  // conversation and never leave the product this way.
  expect(text).not.toContain("A system notice");

  const whole = await room().createScopeInvitations(invitation([main], [NEWCOMER]));
  if (whole.status !== "created") throw new Error(JSON.stringify(whole));
  const mainParts = await deliveredParts(whole.invitations[0]!.id);
  expect(mainParts.text).toContain("Main transcript, not shared here.");
  expect(mainParts.text).not.toContain("Child transcript");
});


it("names the sender and the workspace, and still sends when the conversation cannot be previewed", async () => {
  const share = await create([child], [NEWCOMER]);
  const { text, html } = await deliveredParts(share.id);
  const link = (await deliveredLink(share.id)).toString();
  expect(text.split("\n")[0]).toBe("Adam Owner invited you to Shared workspace on Rally.");
  expect(text).toContain(`Sign in with ${NEWCOMER} to open it:\n${link}`);
  expect(text).toContain("Only someone signed in with this email address can open it.");
  expect(text).not.toContain("accept");
  expect(text.trimEnd().endsWith("work it through together.")).toBe(true);
  // This work stream's conversation object was never provisioned, so the
  // preview cannot be read. An invitation is not a preview: it goes anyway,
  // with nothing quoted.
  expect(text).not.toContain(">");
  // Both parts are composed once and stored together, so a delivery retry
  // sends the message that was composed rather than one rendered again later.
  expect(html).toContain("Adam Owner");
  expect(html).toContain("Shared workspace");
  expect(html).toContain(`href="${link}"`);
  expect(html).toContain("Open in Rally");
  // A Main invitation names the Channel from its directory row.
  const whole = await create([main], ["main-title@example.test"]);
  expect((await deliveredParts(whole.id)).text).toContain("Private parent");
});

/** A warning is written in the object's isolate, so the collector and the level it needs live there too. */
type WarnCaptureScope = typeof globalThis & { __rallyWarnLog?: unknown[]; __rallyWarnOriginal?: typeof console.warn };

it("names which authority refused when a preview cannot be read", async () => {
  // Both inside the object: `logStructuredEvent` writes to the console of the
  // isolate it runs in rather than the runner's, and this Worker's test config
  // sets `LOG_LEVEL` to `error`, which drops the warning before it is written.
  // A spy taken outside, or taken without the level, records nothing and lets
  // the assertion below pass vacuously.
  await runInDurableObject(room(), (instance) => {
    const target = instance as unknown as { env: Env };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "LOG_LEVEL" ? "warn" : Reflect.get(current, property, receiver),
    });
    const scope = globalThis as WarnCaptureScope;
    scope.__rallyWarnLog = [];
    scope.__rallyWarnOriginal = console.warn;
    console.warn = (entry: unknown) => { scope.__rallyWarnLog!.push(entry); };
  });
  try {
    // This work stream's conversation object was never provisioned, so it
    // refuses the read and the port throws. Every port failure is one class, so
    // `error_name` is the constant "ObjectPortError" whatever went wrong; only
    // the code says that this object did not recognize the identity it was
    // asked about, rather than the protocol having drifted or the stub being
    // misrouted. Nothing here can fail an invitation, which makes this entry
    // the only evidence that the preview stopped rendering at all.
    expect(await room().createScopeInvitations(invitation([child], [NEWCOMER]))).toMatchObject({ status: "created" });
    const entries = await runInDurableObject(room(), () =>
      structuredClone((globalThis as WarnCaptureScope).__rallyWarnLog ?? [])) as Record<string, unknown>[];
    expect(entries.find((entry) => entry.event === "scope_invitation_preview_failed"))
      .toMatchObject({ error_name: "ObjectPortError", error_code: "workstream_message_identity_mismatch" });
  } finally {
    await runInDurableObject(room(), () => {
      const scope = globalThis as WarnCaptureScope;
      if (scope.__rallyWarnOriginal) console.warn = scope.__rallyWarnOriginal;
    });
  }
});


it("preserves full members, browser sessions and independent shares across a second Channel and guest promotion", async () => {
  await create();
  const apiEnv = await prepareBrowserSignIn();
  const browser = new BrowserSessionService(apiEnv);
  const { app, proof, redeem } = await signInByCode(apiEnv, "Guest@Example.test");
  expect((await app.request("/browser/email/redeem", {}, apiEnv)).status).toBe(405);
  const wrong = await redeem({ ...proof, credential: "incorrect" });
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get("set-cookie")).toBeNull();
  const redeemed = await redeem(proof);
  expect(redeemed.status, await redeemed.clone().text()).toBe(200);
  expect(await redeemed.json()).toMatchObject({ user: { id: recipientId, email: "guest@example.test" }, workspace: null });
  const cookieHeader = redeemed.headers.get("set-cookie")!;
  expect(cookieHeader).toContain("HttpOnly");
  expect(cookieHeader).toContain("Secure");
  const cookiePair = cookieHeader.split(";")[0]!;
  const credential = decodeURIComponent(cookiePair.slice(cookiePair.indexOf("=") + 1));
  const retry = await redeem(proof);
  expect(retry.status).toBe(200);
  expect(retry.headers.get("set-cookie")!.split(";")[0]).toBe(cookiePair);
  expect((await redeem({ ...proof, redemptionId: crypto.randomUUID() })).status).toBe(401);
  const browserHeaders = { ...originHeaders, cookie: cookiePair };
  await browser.select(credential, workspaceId);
  const browserBefore = await browser.read(credential, workspaceId);
  expect(browserBefore).toMatchObject({ userId: recipientId, accessClass: "guest", role: null });
  const before = await env.DB.prepare("SELECT incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first();
  const secondParent = asWorkstreamId("00000000-0000-4000-8000-000000000096");
  const secondChild: ScopeGrantTarget = { ...child, parentId: secondParent };
  await seedParent(secondParent, "Second parent", [secondChild]);
  const second = await room().createScopeInvitations({ ...invitation([secondChild]), parentId: secondParent });
  expect(second).toMatchObject({ status: "created", invitations: [{ acceptedByUserId: recipientId }] });
  expect(await browser.read(credential, workspaceId)).toEqual(browserBefore);
  expect(await env.DB.prepare("SELECT incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first()).toEqual(before);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: secondChild })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: { ...main, parentId: secondParent } })).toMatchObject({ allowed: false });
  const relationship = await env.DB.prepare("SELECT incarnation,revision FROM workspace_members WHERE workspace_id=? AND user_id=?")
    .bind(workspaceId, recipientId).first<{ incarnation: string; revision: number }>();
  expect(await promoteWorkspaceGuest(env.DB, { workspaceId, userId: recipientId, actorUserId: actorId,
    incarnation: relationship!.incarnation, expectedRevision: relationship!.revision })).toMatchObject({ status: "promoted" });
  const browserAfter = await browser.read(credential, workspaceId);
  expect(browserAfter).toMatchObject({ sessionId: browserBefore.sessionId, userId: recipientId, accessClass: "member", role: "member" });
  const selected = await app.request("/browser/workspace/select", { method: "POST", headers: browserHeaders,
    body: JSON.stringify({ workspaceId }) }, env);
  expect(selected.status, await selected.clone().text()).toBe(200);
  expect(await selected.json()).toMatchObject({ user: { id: recipientId }, workspace: { id: workspaceId, role: "member" } });
  // A full member stays one when a later share reaches them.
  const third = await room().createScopeInvitations({ ...invitation([main]) });
  expect(third).toMatchObject({ status: "created", invitations: [{ acceptedByUserId: recipientId }] });
  expect(await env.DB.prepare("SELECT access_class,role FROM workspace_members WHERE workspace_id=? AND user_id=?")
    .bind(workspaceId, recipientId).first()).toEqual({ access_class: "member", role: "member" });
  for (const target of [child, secondChild]) {
    expect(await room().readScopeAccess({ userId: recipientId, target })).toMatchObject({ allowed: true, writable: true });
  }
  expect(await room().readScopeAccess({ userId: recipientId, target: { ...secondChild, substreamId: asSubstreamId("0") } }))
    .toMatchObject({ allowed: false });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?")
    .bind(workspaceId, recipientId).first()).toEqual({ n: 1 });
});

it("preserves a full member's administrative role when a share reaches them", async () => {
  await env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status) VALUES (?,?,'member','admin','active')")
    .bind(workspaceId, recipientId).run();
  const before = await env.DB.prepare("SELECT incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first();
  expect(await create()).toMatchObject({ status: "accepted" });
  expect(await env.DB.prepare("SELECT access_class,role,incarnation FROM workspace_members WHERE user_id=?").bind(recipientId).first())
    .toMatchObject({ ...before, access_class: "member", role: "admin" });
});

it("refuses sharing while the addressed authority handoff is incomplete", async () => {
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("UPDATE parent_participant_migrations SET phase='pending' WHERE parent_id=? AND substream_id=?", parentId, childId);
  });
  expect(await room().createScopeInvitations(invitation())).toMatchObject({ status: "denied", reason: "migration_pending" });
  await runInDurableObject(room(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM parent_invitations WHERE parent_id=?", parentId).toArray()).toEqual([]);
  });
});

it("lists invitation summaries only when the actor can share every target", async () => {
  const childOnly = await room().createScopeInvitations(invitation([child]));
  await room().createScopeInvitations(invitation([main], ["main@example.test"]));
  await room().createScopeInvitations(invitation([main, child], ["both@example.test"]));
  const request = { actorUserId: actorId, target: child };
  expect(await room().listScopeInvitations(request)).toMatchObject({ status: "ready", invitations: expect.any(Array) });
  const before = await room().listScopeInvitations(request);
  if (before.status !== "ready") throw new Error("expected sharing authority");
  expect(before.invitations.map((item) => item.email).sort()).toEqual(["both@example.test", "guest@example.test"]);
  expect(JSON.stringify(before)).not.toMatch(/token|Encrypted|grantOperationIds/);
  await withHostedParent(room(), parentId, (parent) => {
    const grants = parent['scopeGrants'](main);
    grants.mutateCurrent({ operationId: crypto.randomUUID(), actorUserId: actorId, userId: actorId,
      target: main, active: false }, "actor-membership");
  });
  if (childOnly.status !== "created") throw new Error("expected invitation");
  expect(await room().listScopeInvitations(request)).toEqual({ status: "ready", invitations: childOnly.invitations });
  expect(await room().listScopeInvitations({ actorUserId: actorId, target: main })).toEqual({ status: "denied", reason: "sharing_required" });
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId));
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
  await withHostedParent(room(), parentId, (hosted) => {
    hosted['scopeGrants'](parent).mutate({ operationId: crypto.randomUUID(),
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
    state.storage.sql.exec("INSERT INTO parent_children(parent_id,substream_id,kind,status,created_at) VALUES (?,?,'child','ready',0)", parentId, laterChild);
  });
  expect((await room().scopeSharingOptions(address)).completeWorkstreamTargets).toBeNull();
  expect(await room().createScopeInvitations(request)).toEqual(created);
  expect(await room().createScopeInvitations({ ...request, operationId: crypto.randomUUID() }))
    .toEqual({ status: "denied", reason: "scope_changed" });
});


it("manages accepted grants by exact scope and preserves later shares on retry", async () => {
  await create([child, main]);
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
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId));
  expect(await room().listManagedScopeGrants({ actorUserId: actorId, target: child }))
    .toEqual({ status: "denied", reason: "sharing_required" });
});


it("rechecks management authority after profile reads interleave with suspension", async () => {
  await runInDurableObject(room(), async (instance) => {
    let release = () => {}, started = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const target = instance as unknown as { env: Env };
    const originalEnv = target.env;
    const original = originalEnv.DB;
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
        // Matched without whitespace, so a reformatted query cannot leave this
        // gate unarmed and the test waiting on a read that never comes.
        if (property === "prepare") return (sql: string) => sql.replace(/\s+/gu, "") === "SELECTname,emailFROMusersWHEREid=?"
          ? wrap(current.prepare(sql)) : current.prepare(sql);
        const value = Reflect.get(current, property);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });
    target.env = new Proxy(target.env, { get: (current, property, receiver) => property === "DB" ? database : Reflect.get(current, property, receiver) });
    const listing = instance.listManagedScopeGrants({ actorUserId: actorId, target: child });
    try {
      try {
        await reading;
        await original.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId).run();
        // The suspension's relationship event reaches the object while the
        // listing is still waiting on its profile read.
        const suspended = await original.prepare(`SELECT workspace_id AS workspaceId, user_id AS userId,
          access_class AS accessClass, role, status, incarnation, revision FROM workspace_members WHERE user_id = ?`)
          .bind(actorId).first();
        expect(await instance.applyMemberStatus({ workspaceId, sequence: 1, removed: false,
          relationship: WorkspaceRelationshipSchema.parse(suspended) })).toEqual({ applied: true });
      } finally { release(); }
      expect(await listing).toEqual({ status: "denied", reason: "sharing_required" });
    } finally { target.env = originalEnv; }
  });
});


it("refuses unconfigured sharing before a legacy authority handoff", async () => {
  await runInDurableObject(room(), async (instance, state) => {
    state.storage.sql.exec("DELETE FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", parentId, childId);
    const original = instance['env'];
    instance['env'] = new Proxy(original, { get: (target, key, receiver) =>
      key === 'BROWSER_APP_ORIGIN' ? undefined : Reflect.get(target, key, receiver) });
    try {
      expect(await instance.createScopeInvitations(invitation())).toEqual({ status: "denied", reason: "configuration_required" });
      expect(state.storage.sql.exec("SELECT 1 FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", parentId, childId).toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT 1 FROM parent_invitations WHERE parent_id=?", parentId).toArray()).toEqual([]);
    } finally { instance['env'] = original; }
  });
});
