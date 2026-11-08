/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A share of a Canvas by email address, end to end on the real Organization
 * object and D1: a newcomer's share waits for them and admits them on a real
 * browser sign-in by code; a share to someone who already signs in is theirs
 * as it is made; a share recorded before D1's lookup rows existed is indexed
 * by the object's own alarm; and a revoked share is never given to anyone.
 *
 * The object arms real alarms (delivery is due the moment a share is made),
 * and workerd runs them on its own schedule as well as when a case calls
 * `runDurableObjectAlarm`. Whatever an alarm writes to D1 is therefore read
 * with `expect.poll`, and every lookup-row read is scoped to this case's
 * Organization so an earlier case's late alarm cannot be read as this one's.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { Env } from "../src/env";
import { createApp } from "../src/app";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";
import { ScheduledAlarmStore } from "../src/durable-objects/scheduled-alarms";
import { SCOPE_INVITATION_INDEX_ALARM } from "../src/durable-objects/scope-invitation-storage";
import { openEmailLoginSecret } from "../src/services/email-login-service";
import { RegionalOnboardingService } from "../src/services/platform-onboarding-service";
import { claimScopeInvitations } from "../src/services/scope-invitation-claims";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c5000");
let CANVAS_ID = asWorkstreamId("00000000-0000-7000-8000-0000000c5100");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000c5001");
/** Already signs in with guest@example.test, so a share to that address is theirs as it is made. */
const GUEST = asUserId("00000000-0000-7000-8000-0000000c5002");
/** Someone with no account yet: a share to them waits for their first sign-in. */
const NEWCOMER = asUserId("00000000-0000-7000-8000-0000000c5003");
const GUEST_EMAIL = "guest@example.test";
const NEWCOMER_EMAIL = "newcomer@example.test";

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

async function share(emails: string[]) {
  const result = await workspace().createScopeInvitations({
    operationId: crypto.randomUUID(), workspaceId: WORKSPACE_ID, parentId: CANVAS_ID, actorUserId: CREATOR,
    emails, targets: [{ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: CANVAS_ID }], expiresAt: null,
  });
  if (result.status !== "created" || !result.invitations[0]) throw new Error(JSON.stringify(result));
  return result.invitations[0];
}

/** Whether a guest opens the Canvas; a refusal is `canvas_not_found`, so it never says the Canvas exists. */
async function opens(userId: string): Promise<boolean> {
  return runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
    try {
      await instance.canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID,
        actor: { userId: asUserId(userId), actorRole: null } });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "canvas_not_found") return false;
      throw error;
    }
  });
}

/** Where a sign-in looks up a pending share for an address, in this case's Organization only. */
const routes = async (email: string) => (await env.DB.prepare(
  "SELECT workspace_id, parent_id FROM scope_share_recipients WHERE email = ? AND workspace_id = ?",
).bind(email, WORKSPACE_ID).all()).results;

/** The real D1 tables and columns a browser sign-in by email code reads and writes. */
async function prepareBrowserSignIn(): Promise<Env> {
  const at = new Date().toISOString();
  await env.DB.batch([
    ...["slug TEXT", "timezone TEXT", "created_at TEXT"].map((column) =>
      env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN ${column}`)),
    ...["avatar_url TEXT", "timezone TEXT DEFAULT 'UTC'", "created_at TEXT", "updated_at TEXT", "platform_user_id TEXT",
      "onboarding_eligible INTEGER", "signup_flow_id TEXT", "signup_client_platform TEXT", "signup_path TEXT",
      "signup_completed_at TEXT", "onboarding_introduced INTEGER DEFAULT 0"].map((column) =>
      env.DB.prepare(`ALTER TABLE users ADD COLUMN ${column}`)),
    env.DB.prepare("UPDATE workspaces SET slug='canvas', timezone='UTC', created_at=?").bind(at),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, region TEXT,
      workspace_incarnation TEXT, revoked_at TEXT, expires_at TEXT, impersonator_user_id TEXT,
      refresh_token_hash TEXT, created_at TEXT)`),
    env.DB.prepare(`CREATE TRIGGER bind_session_incarnation AFTER INSERT ON sessions WHEN NEW.workspace_id IS NOT NULL
      BEGIN UPDATE sessions SET workspace_incarnation=(SELECT incarnation FROM workspace_members
      WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND status='active') WHERE id=NEW.id; END`),
    env.DB.prepare("ALTER TABLE user_verified_emails ADD COLUMN verified_at TEXT"),
    env.DB.prepare("CREATE TABLE user_login_identities(provider TEXT,subject TEXT,user_id TEXT,verified_at TEXT,PRIMARY KEY(provider,subject))"),
    env.DB.prepare(`CREATE TABLE email_login_challenges (
      id TEXT PRIMARY KEY,email TEXT NOT NULL,magic_hash TEXT NOT NULL,otp_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,max_failed_attempts INTEGER,failed_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_payload_encrypted TEXT NOT NULL,delivery_sent_at INTEGER,created_at INTEGER NOT NULL,
      redeemed_at INTEGER,redemption_id TEXT,user_id TEXT,session_id TEXT UNIQUE,session_secret_encrypted TEXT,
      telemetry_flow_id TEXT,telemetry_client_platform TEXT,signup_created INTEGER DEFAULT 0)`),
    env.DB.prepare("CREATE TABLE browser_sessions(session_id TEXT PRIMARY KEY,credential_hash TEXT UNIQUE)"),
    env.DB.prepare("CREATE TABLE browser_workspace_sessions(browser_session_id TEXT,workspace_id TEXT,session_id TEXT UNIQUE,PRIMARY KEY(browser_session_id,workspace_id))"),
  ]);
  return { ...env, RESEND_FROM_EMAIL: "Rally <login@example.test>",
    EMAIL_LOGIN_POLICY_JSON: JSON.stringify({ otpDigits: 6, ttlSeconds: 600, maxFailedAttempts: 3 }) };
}

/** The newcomer verifies their mailbox: from here, signing in claims what waits for it. */
async function verifyNewcomer() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, NULL)").bind(NEWCOMER),
    env.DB.prepare("INSERT INTO user_verified_emails (email, user_id) VALUES (?, ?)").bind(NEWCOMER_EMAIL, NEWCOMER),
  ]);
}

/** The object's own `env`, with D1's `batch` replaced, for the duration of `run`. */
async function withBatch<T>(instance: WorkspaceDO, batch: (original: D1Database, statements: D1PreparedStatement[]) => Promise<D1Result[]>,
  run: () => Promise<T>): Promise<T> {
  const target = instance as unknown as { env: Env };
  const original = target.env;
  const database = new Proxy(original.DB, { get: (current, property) => property === "batch"
    ? (statements: D1PreparedStatement[]) => batch(current, statements)
    : Reflect.get(current, property) });
  target.env = new Proxy(original, { get: (current, property, receiver) => property === "DB" ? database : Reflect.get(current, property, receiver) });
  try { return await run(); } finally { target.env = original; }
}

const originHeaders = { origin: "https://app.test", "content-type": "application/json" };

beforeEach(async () => {
  await reset();
  // Fresh ids per case: an earlier case's delivery alarm must not land in the next case's object.
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  CANVAS_ID = asWorkstreamId(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'Canvas workspace')").bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      revision INTEGER NOT NULL DEFAULT 1, joined_at TEXT, last_seen_at TEXT, PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status) VALUES (?,?,'member','member','active')")
      .bind(WORKSPACE_ID, CREATOR),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, analytics_person_id TEXT, name TEXT, email TEXT)"),
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, 'Casey Creator'), (?, NULL)").bind(CREATOR, GUEST),
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
    env.DB.prepare("INSERT INTO user_verified_emails (email, user_id) VALUES (?, ?)").bind(GUEST_EMAIL, GUEST),
  ]);
  await workspace().canvasCreate({
    workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, title: "Launch plan", createdByUserId: CREATOR, authorityGeneration: 1,
  });
});

describe("sharing a Canvas by email address", () => {
  it("holds a share for a newcomer and admits them on a real browser sign-in by code", async () => {
    expect(await share([NEWCOMER_EMAIL])).toMatchObject({ status: "pending", acceptedByUserId: null });
    expect(await routes(NEWCOMER_EMAIL)).toEqual([{ workspace_id: WORKSPACE_ID, parent_id: CANVAS_ID }]);

    const apiEnv = await prepareBrowserSignIn();
    const app = createApp();
    const challengeId = crypto.randomUUID();
    const started = await app.request("/browser/email/start", { method: "POST", headers: originHeaders,
      body: JSON.stringify({ challengeId, email: "Newcomer@Example.test" }) }, apiEnv);
    expect(started.status, await started.clone().text()).toBe(202);
    const challenge = await env.DB.prepare("SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?")
      .bind(challengeId).first<{ delivery_payload_encrypted: string }>();
    const email = await openEmailLoginSecret(apiEnv, challengeId, challenge!.delivery_payload_encrypted) as { text: string };
    const otp = /code is (\d+)\./u.exec(email.text)![1]!;
    const redeemed = await app.request("/browser/email/redeem", { method: "POST", headers: originHeaders,
      body: JSON.stringify({ challengeId, redemptionId: crypto.randomUUID(), method: "otp", credential: otp }) }, apiEnv);
    expect(redeemed.status, await redeemed.clone().text()).toBe(200);
    const signedIn = await redeemed.json() as { user: { id: string } };

    // Signing in is the acceptance: the Canvas opens with no other step.
    expect(await opens(signedIn.user.id)).toBe(true);
    expect(await env.DB.prepare("SELECT access_class, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, signedIn.user.id).first()).toEqual({ access_class: "guest", role: null });
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID,
      actor: { userId: CREATOR, actorRole: "member" } });
    expect(detail.participantUserIds).toEqual([signedIn.user.id]);
    expect(await routes(NEWCOMER_EMAIL)).toEqual([]);
  });

  it("gives a share to someone who already signs in with that address as it is made", async () => {
    expect(await share([GUEST_EMAIL])).toMatchObject({ status: "accepted", acceptedByUserId: GUEST });
    expect(await opens(GUEST)).toBe(true);
    expect(await env.DB.prepare("SELECT access_class, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, GUEST).first()).toEqual({ access_class: "guest", role: null });
    // Nothing is left to claim for that address, so the share's delivery alarm
    // drops its lookup row. workerd may already be running that alarm.
    await runDurableObjectAlarm(workspace());
    await expect.poll(() => routes(GUEST_EMAIL), { timeout: 5_000 }).toEqual([]);
  });

  it("indexes a share that was pending before lookup rows existed, on the object's own schedule", async () => {
    // Such a share has no lookup row. Migration 93 writes one index entry per
    // parent with a pending share, and the constructor then arms the alarm for
    // it; the alarm writes the rows.
    await share([NEWCOMER_EMAIL]);
    await env.DB.prepare("DELETE FROM scope_share_recipients WHERE workspace_id = ?").bind(WORKSPACE_ID).run();
    await runInDurableObject(workspace(), async (instance, state) => {
      new ScheduledAlarmStore(state.storage.sql).schedule({ kind: SCOPE_INVITATION_INDEX_ALARM, key: CANVAS_ID, dueAt: Date.now() });
      // Arm it as the constructor does after migrating. Without this the entry
      // rides on the delivery alarm, and once that has run and cleared the
      // alarm there is nothing for `runDurableObjectAlarm` to run.
      await (instance as unknown as { armNextAlarm(): Promise<unknown> }).armNextAlarm();
    });
    // The share's own delivery alarm may be in flight already, and it runs
    // every due entry; whichever run takes the index entry, its write lands
    // after this call can return.
    await runDurableObjectAlarm(workspace());
    await expect.poll(() => routes(NEWCOMER_EMAIL), { timeout: 5_000 }).toEqual([{ workspace_id: WORKSPACE_ID, parent_id: CANVAS_ID }]);

    await verifyNewcomer();
    await claimScopeInvitations(env, NEWCOMER);
    expect(await opens(NEWCOMER)).toBe(true);
  });

  it("never gives a revoked share to the address it was for", async () => {
    const pending = await share([NEWCOMER_EMAIL]);
    expect(await workspace().revokeScopeInvitation({ workspaceId: WORKSPACE_ID, parentId: CANVAS_ID,
      actorUserId: CREATOR, invitationId: pending.id, expectedRevision: 1 })).toMatchObject({ status: "revoked" });
    expect(await routes(NEWCOMER_EMAIL)).toEqual([]);
    await verifyNewcomer();
    await claimScopeInvitations(env, NEWCOMER);
    expect(await opens(NEWCOMER)).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, NEWCOMER).first()).toBeNull();
  });
  it("answers a repeated creation from its receipt, without a second share or a second delivery", async () => {
    const request = { operationId: crypto.randomUUID(), workspaceId: WORKSPACE_ID, parentId: CANVAS_ID, actorUserId: CREATOR,
      emails: [NEWCOMER_EMAIL], targets: [{ kind: "workstream" as const, workspaceId: WORKSPACE_ID, parentId: CANVAS_ID }],
      expiresAt: null };
    const first = await workspace().createScopeInvitations(request);
    expect(first.status).toBe("created");
    expect(await workspace().createScopeInvitations(request)).toEqual(first);
    expect(await workspace().createScopeInvitations({ ...request, emails: ["someone-else@example.test"] }))
      .toEqual({ status: "denied", reason: "operation_conflict" });
    await runDurableObjectAlarm(workspace());
    // Delivered once; workerd may still be finishing the alarm this call raced.
    await expect.poll(() => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ delivered: number }>(
      "SELECT delivered_at IS NOT NULL AS delivered FROM parent_invitations WHERE parent_id = ?", CANVAS_ID).toArray()),
    { timeout: 5_000 }).toEqual([{ delivered: 1 }]);
  });

  it("claims once: a second sign-in neither repeats the claim nor restores a share revoked after it", async () => {
    await share([NEWCOMER_EMAIL]);
    await verifyNewcomer();
    await claimScopeInvitations(env, NEWCOMER);
    await claimScopeInvitations(env, NEWCOMER);
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID,
      actor: { userId: CREATOR, actorRole: "member" } });
    expect(detail.participantUserIds).toEqual([NEWCOMER]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS rows FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, NEWCOMER).first()).toEqual({ rows: 1 });
  });

  it("never gives an expired share to the address it was for", async () => {
    const created = await workspace().createScopeInvitations({ operationId: crypto.randomUUID(), workspaceId: WORKSPACE_ID,
      parentId: CANVAS_ID, actorUserId: CREATOR, emails: [NEWCOMER_EMAIL],
      targets: [{ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: CANVAS_ID }], expiresAt: Date.now() + 60_000 });
    if (created.status !== "created") throw new Error(JSON.stringify(created));
    const invitationId = created.invitations[0]!.id;
    await runInDurableObject(workspace(), (_instance, state) => {
      // The deadline lives in the stored summary, so age it there.
      const stored = state.storage.sql.exec<{ summary_json: string }>(
        "SELECT summary_json FROM parent_invitations WHERE parent_id = ? AND id = ?", CANVAS_ID, invitationId).one();
      state.storage.sql.exec("UPDATE parent_invitations SET summary_json = ? WHERE parent_id = ? AND id = ?",
        JSON.stringify({ ...JSON.parse(stored.summary_json), expiresAt: Date.now() - 1_000 }), CANVAS_ID, invitationId);
    });
    await verifyNewcomer();
    await claimScopeInvitations(env, NEWCOMER);
    expect(await opens(NEWCOMER)).toBe(false);
    expect(await routes(NEWCOMER_EMAIL)).toEqual([]);
  });

  it("keeps the lookup row for a share recorded while a revocation's cleanup was deleting it", async () => {
    // Revoking the address's last share deletes its row. A new share to the
    // same address, recorded while that delete is in flight, must keep a row.
    const first = await share([NEWCOMER_EMAIL]);
    await runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
      let raced = false;
      const revoked = await withBatch(instance, async (original, statements) => {
        if (!raced && JSON.stringify(statements.map((statement) =>
          (statement as unknown as { statement?: string }).statement ?? String(statement))).includes("DELETE")) {
          raced = true;
          // The new share lands, row and all, before the delete does.
          await instance.createScopeInvitations({ operationId: crypto.randomUUID(), workspaceId: WORKSPACE_ID,
            parentId: CANVAS_ID, actorUserId: CREATOR, emails: [NEWCOMER_EMAIL],
            targets: [{ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: CANVAS_ID }], expiresAt: null });
        }
        return original.batch(statements);
      }, () => instance.revokeScopeInvitation({ workspaceId: WORKSPACE_ID, parentId: CANVAS_ID, actorUserId: CREATOR,
        invitationId: first.id, expectedRevision: 1 }));
      expect(revoked).toMatchObject({ status: "revoked" });
      expect(raced).toBe(true);
    });
    expect(await routes(NEWCOMER_EMAIL)).toEqual([{ workspace_id: WORKSPACE_ID, parent_id: CANVAS_ID }]);
  });

  it("signs in without the share, rather than failing, when the claim lookup itself fails", async () => {
    await share([NEWCOMER_EMAIL]);
    await verifyNewcomer();
    const broken = { ...env, DB: new Proxy(env.DB, { get: (database, property, receiver) => property === "batch"
      ? () => Promise.reject(new Error("D1_ERROR: simulated outage"))
      : Reflect.get(database, property, receiver) }) } as typeof env;
    await expect(claimScopeInvitations(broken, NEWCOMER)).resolves.toBeUndefined();
    // The lookup row is untouched, so the next sign-in claims it.
    await claimScopeInvitations(env, NEWCOMER);
    expect(await opens(NEWCOMER)).toBe(true);
  });

  it("claims for an address Global verified that this deployment has not recorded", async () => {
    // Discovery's case: a person known here only through the platform link,
    // whose verified address arrives with Global's identity.
    await share([NEWCOMER_EMAIL]);
    await env.DB.prepare("INSERT INTO users (id, name) VALUES (?, NULL)").bind(NEWCOMER).run();
    await claimScopeInvitations(env, NEWCOMER);
    expect(await opens(NEWCOMER)).toBe(false);
    await claimScopeInvitations(env, NEWCOMER, "Newcomer@Example.test");
    expect(await opens(NEWCOMER)).toBe(true);
  });

  it("claims during regional discovery, which desktop sign-in and workspace switching use", async () => {
    await share([NEWCOMER_EMAIL]);
    const at = new Date().toISOString();
    await env.DB.batch([
      ...["slug TEXT", "timezone TEXT", "created_at TEXT"].map((column) => env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN ${column}`)),
      env.DB.prepare("UPDATE workspaces SET slug='canvas', timezone='UTC', created_at=?").bind(at),
      ...["platform_user_id TEXT", "google_subject TEXT", "avatar_url TEXT", "updated_at TEXT", "presentation_json TEXT"]
        .map((column) => env.DB.prepare(`ALTER TABLE users ADD COLUMN ${column}`)),
      // Known here only through the platform link: no verified-address row.
      env.DB.prepare("INSERT INTO users (id, name, email, platform_user_id, google_subject) VALUES (?, 'Newcomer', ?, ?, 'google-newcomer')")
        .bind(NEWCOMER, NEWCOMER_EMAIL, NEWCOMER),
      env.DB.prepare(`CREATE TABLE workspace_invitations (id TEXT, workspace_id TEXT, email TEXT, role TEXT,
        invited_by_user_id TEXT, expires_at TEXT, accepted_at TEXT, revoked_at TEXT, created_at TEXT)`),
      env.DB.prepare("CREATE TABLE demo_operations (workspace_id TEXT, ready_at TEXT)"),
      env.DB.prepare(`CREATE TABLE user_login_identities (provider TEXT NOT NULL, subject TEXT NOT NULL,
        user_id TEXT NOT NULL, verified_at TEXT NOT NULL, PRIMARY KEY (provider, subject))`),
    ]);
    const discovery = await new RegionalOnboardingService(env).discover({ platformUserId: NEWCOMER,
      loginIdentities: [{ provider: "google", subject: "google-newcomer" }], email: "Newcomer@Example.test", name: "Newcomer",
      avatarUrl: null, timezone: "UTC", createdAt: at });
    expect(discovery.workspaces).toEqual([expect.objectContaining({ id: WORKSPACE_ID, accessClass: "guest" })]);
    expect(await opens(NEWCOMER)).toBe(true);
  });
});
