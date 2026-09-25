import type { Env } from "../src/env";
import { SignJWT } from "jose";
import { createApp } from "../src/app";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { WorkspaceRelationshipSchema, type ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { ScopeInvitationStorage } from "../src/durable-objects/scope-invitation-storage";
import { decryptString } from "../src/lib/crypto";
import { openScopeInvitationCredential } from "../src/services/scope-invitation-link";
import { BrowserSessionService } from "../src/services/browser-session-service";
import { openEmailLoginSecret } from "../src/services/email-login-service";
import { promoteWorkspaceGuest } from "../src/services/workspace-relationship-service";
import { LINK_PAYLOADS_TABLE } from "./helpers/link-payloads-table";
import { changeRelationships } from "./helpers/workspace-relationship-events";
import { hostedParentStub, withHostedParent } from "./helpers/hosted-parent";
import { conversationObjectName } from "../src/durable-objects/names";
import { boot, seedParticipantMessage, seedOpenWorkstreamAuthority, seedWorkstreamRoot } from "./helpers/substream-fixture";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000091");
const parentId = asWorkstreamId("00000000-0000-4000-8000-000000000092");
const actorId = asUserId("00000000-0000-4000-8000-000000000093");
const recipientId = asUserId("00000000-0000-4000-8000-000000000094");
const childId = asSubstreamId("00000000-0000-4000-8000-000000000095");
const child: ScopeGrantTarget = { kind: "conversation", workspaceId, parentId, substreamId: childId };
const main: ScopeGrantTarget = { ...child, substreamId: asSubstreamId("0") };
/** The Organization object, which hosts every Channel parent in the workspace. */
const room = () => hostedParentStub(env, workspaceId);
const invitation = (targets: ScopeGrantTarget[] = [child]) => ({ operationId: crypto.randomUUID(), workspaceId, parentId,
  actorUserId: actorId, emails: ["guest@example.test"], targets, expiresAt: null });

/** The URL the recipient receives, read out of the durable encrypted body the sender delivers. */
async function deliveredLink(id: string, parent = parentId): Promise<URL> {
  const encrypted = await runInDurableObject(room(), (_instance, state) =>
    new ScopeInvitationStorage(state.storage, parent).read(id)!.deliveryEncrypted);
  const sealed = JSON.parse(encrypted) as { ciphertext: string; iv: string };
  const delivery = JSON.parse(await decryptString(sealed.ciphertext, sealed.iv,
    env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)) as { text: string };
  const link = delivery.text.split("\n").find((line) => line.startsWith("https://app.test/invite"));
  if (!link) throw new Error("invitation link missing");
  return new URL(link);
}

const credentialFor = async (id: string, parent = parentId) => ({ link: (await deliveredLink(id, parent)).hash.slice(1) });

async function deliveredParts(id: string, parent = parentId): Promise<{ text: string; html?: string }> {
  const encrypted = await runInDurableObject(room(), (_instance, state) =>
    new ScopeInvitationStorage(state.storage, parent).read(id)!.deliveryEncrypted);
  const sealed = JSON.parse(encrypted) as { ciphertext: string; iv: string };
  return JSON.parse(await decryptString(sealed.ciphertext, sealed.iv,
    env.OAUTH_STATE_ENCRYPTION_KEY, `scope-invitation:${id}`)) as { text: string; html?: string };
}

async function tokenFor(id: string, parent = parentId): Promise<string> {
  const address = await openScopeInvitationCredential(env, await credentialFor(id, parent));
  if (!address) throw new Error("invitation credential unreadable");
  return address.token;
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
      region TEXT, workspace_incarnation TEXT, revoked_at TEXT, expires_at TEXT)`),
    env.DB.prepare("INSERT INTO sessions VALUES ('actor-session', ?, ?, 'global', 'actor-membership', NULL, '2099-01-01T00:00:00.000Z')").bind(actorId, workspaceId),
    env.DB.prepare("INSERT INTO sessions VALUES ('recipient-session', ?, NULL, 'global', NULL, NULL, '2099-01-01T00:00:00.000Z')").bind(recipientId),
    env.DB.prepare("CREATE TABLE user_verified_emails (email TEXT PRIMARY KEY, user_id TEXT)") ,
    env.DB.prepare(LINK_PAYLOADS_TABLE),
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
    state.storage.sql.exec(`INSERT INTO parent_metadata
      (parent_id,parent_kind,workspace_id,region,authority_generation,title,description,preview,scope,exact_state,last_activity_at,created_at,updated_at)
      VALUES (?,'workstream',?,'global',1,?,'','','personal','idle',0,0,0)`, id, workspaceId, title);
    state.storage.sql.exec("INSERT INTO parent_children (parent_id,substream_id,kind,created_at) VALUES (?,'0','main',0), (?,?,'child',0)", id, id, childId);
    state.storage.sql.exec("INSERT INTO parent_participant_migrations VALUES (?, '0', ?, '{}', 'complete')", id, crypto.randomUUID());
    state.storage.sql.exec("INSERT INTO parent_participant_migrations VALUES (?, ?, ?, NULL, 'complete')", id, childId, crypto.randomUUID());
    const grants = parent['scopeGrants']({ workspaceId, parentId: id });
    for (const target of actorTargets) grants.mutate({ operationId: crypto.randomUUID(), actorUserId: actorId,
      userId: actorId, target, active: true, expectedRevision: 0 }, "actor-membership");
  });
}

it("retries one email batch without replacing invitation credentials or its durable delivery", async () => {
  const request = invitation();
  const first = await room().createScopeInvitations(request);
  expect(first.status).toBe("created");
  expect(await room().createScopeInvitations(request)).toEqual(first);
  expect(await room().createScopeInvitations({ ...request, emails: ["someone-else@example.test"] }))
    .toMatchObject({ status: "denied", reason: "operation_conflict" });
  await runDurableObjectAlarm(room());
  await runInDurableObject(room(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM parent_invitations WHERE parent_id = ?", parentId).toArray()).toHaveLength(1);
    expect(state.storage.sql.exec<{ delivered_at: number }>("SELECT delivered_at FROM parent_invitations WHERE parent_id = ?", parentId).one().delivered_at).toBeGreaterThan(0);
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
  await withHostedParent(room(), parentId, (parent) => {
    const grants = parent['scopeGrants'](child);
    grants.mutateCurrent({ operationId: crypto.randomUUID(), actorUserId: actorId, userId: recipientId, target: child, active: false },
      grants.forUser(recipientId)[0]!.membershipIncarnation);
  });
  expect(await room().acceptScopeInvitation(request)).toEqual(accepted);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: false });
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(recipientId));
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
    state.storage.sql.exec(`CREATE TRIGGER reject_child_grant BEFORE INSERT ON parent_grants
      WHEN NEW.user_id='${recipientId}' AND NEW.substream_id='${childId}'
      BEGIN SELECT RAISE(ABORT,'simulated child write failure'); END`);
  });
  // Catch the deliberate runtime rejection inside the object: the test RPC
  // bridge otherwise reports the same expected rejection as unhandled as well.
  await expect(runInDurableObject(room(), (instance) => instance.acceptScopeInvitation(request)))
    .rejects.toThrow("simulated child write failure");
  await withHostedParent(room(), parentId, (parent, state) => {
    expect(parent['scopeGrants'](child).forUser(recipientId)).toEqual([]);
    expect(new ScopeInvitationStorage(state.storage, parentId).read(request.invitationId)?.summary.status).toBe("pending");
    state.storage.sql.exec("DROP TRIGGER reject_child_grant");
  });
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "accepted" });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
});

it("does not use an invitation after the sharer's membership is replaced", async () => {
  const request = await create();
  expect(await room().describeScopeInvitation({ workspaceId, parentId, invitationId: request.invitationId, token: request.token }))
    .toMatchObject({ status: "ready" });
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspace_members SET incarnation='replacement' WHERE user_id=?").bind(actorId));
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "denied", reason: "sharing_required" });
  // The preview goes with it. It answers what acceptance would answer, or it is
  // a mailbox oracle: a name for an invitation nobody can accept any more, and
  // one the holder could not have learned by accepting.
  expect(await room().describeScopeInvitation({ workspaceId, parentId, invitationId: request.invitationId, token: request.token }))
    .toMatchObject({ status: "denied", reason: "invitation_unavailable" });
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

it("names the field when an invitation is asked to expire past the end of time", async () => {
  const app = createApp();
  const headers = { authorization: `Bearer ${await bearer(actorId, "actor-session", workspaceId)}`, "content-type": "application/json" };
  // Past the largest instant a `Date` can hold and still a safe integer, which
  // is the whole band `z.number().int()` lets through: `expiresAt` reached
  // `new Date(value).toISOString()` in the link store and came back as a bare
  // `RangeError: Invalid time value`, naming neither the field nor the caller's
  // value. Anything larger was already refused for not being an integer, which
  // is why the ceiling has to be the `Date` range rather than that one.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const response = await app.request("/sharing", { method: "POST", headers, body: JSON.stringify({
      operationId: crypto.randomUUID(), parentId, emails: ["guest@example.test"], targets: [child],
      expiresAt: 9_000_000_000_000_000 }) }, { ...env, LOG_LEVEL: "warn" as const });
    // A rejection, not a 500, and the diagnostic names the field rather than
    // carrying one run's `RangeError` message.
    expect(response.status).toBe(400);
    expect(warn.mock.calls.map(([entry]) => entry as { validation_issues?: unknown }).flatMap((entry) =>
      Array.isArray(entry?.validation_issues) ? entry.validation_issues : []))
      .toContainEqual(expect.objectContaining({ path: "expiresAt" }));
  } finally {
    warn.mockRestore();
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM link_payloads").first<{ n: number }>()).toMatchObject({ n: 0 });
});

it("emails one opaque credential, fills in the mailbox it was sent to, and accepts by that credential alone", async () => {
  const created = await room().createScopeInvitations(invitation());
  if (created.status !== "created") throw new Error(JSON.stringify(created));
  const invitationId = created.invitations[0]!.id;
  const link = await deliveredLink(invitationId);
  const credential = { link: link.hash.slice(1) };
  // Nothing a recipient can read out of the link says which deployment,
  // workspace, work stream or invitation it addresses: one typed prefix and
  // 256 bits, with everything it stands for in this region's own row.
  expect(link.pathname).toBe("/invite");
  expect(link.search).toBe("");
  expect(credential.link).toMatch(/^inv_[A-Za-z0-9_-]{43}$/u);
  expect(link.toString()).toHaveLength(`${new URL("/invite", link).toString()}#inv_`.length + 43);
  // The token is the credential, so the link carries it; what it must not carry
  // is anything that says what the credential addresses.
  expect(credential.link).toBe(await tokenFor(invitationId));
  for (const routing of [workspaceId, parentId, invitationId, "region", "global"]) {
    expect(link.toString()).not.toContain(routing);
  }
  // The row holds the digest of the token in the email, never the token, and
  // no second secret beside the address: a dump of this table cannot be
  // replayed through the addressed request body that is still accepted.
  const stored = await env.DB.prepare("SELECT type, payload FROM link_payloads").first<{ type: string; payload: string }>();
  expect(stored?.type).toBe("inv");
  expect(JSON.parse(stored!.payload)).toEqual({ workspaceId, parentId, invitationId });
  expect(stored!.payload).not.toContain(credential.link.slice(4));
  expect(await env.DB.prepare("SELECT 1 FROM link_payloads WHERE token_hash = ?").bind(credential.link).first()).toBeNull();
  expect(await room().acceptScopeInvitation({ workspaceId, parentId, invitationId,
    userId: recipientId, ...JSON.parse(stored!.payload), token: "whatever a dump gives you" }))
    .toMatchObject({ status: "denied", reason: "invitation_unavailable" });

  const app = createApp();
  const origin = { origin: "https://app.test", "content-type": "application/json" };
  const preview = async (body: unknown) => app.request("/browser/invitation",
    { method: "POST", headers: origin, body: JSON.stringify(body) }, env);
  // No session: the sign-in form has to fill this in before there is one.
  const filled = await preview(credential);
  expect(filled.status, await filled.clone().text()).toBe(200);
  expect(await filled.json()).toEqual({ email: "guest@example.test" });
  const edited = `${credential.link.slice(0, -1)}${credential.link.endsWith("A") ? "B" : "A"}`;
  expect((await preview({ link: edited })).status).toBe(403);
  // The addressed body is refused here, though acceptance still takes it. On
  // that branch nothing is looked up, so the caller's own identifiers would
  // reach a Durable Object stub with no session behind the request at all —
  // and a link minted in that format never carried a mailbox to prefill.
  const addressed = { workspaceId, parentId, invitationId, token: await tokenFor(invitationId) };
  expect((await preview(addressed)).status).toBe(400);
  expect((await preview({ ...addressed, parentId: crypto.randomUUID() })).status).toBe(400);

  const headers = { authorization: `Bearer ${await bearer(recipientId, "recipient-session", null)}`, "content-type": "application/json" };
  const acceptance = await app.request("/sharing/accept", { method: "POST", headers, body: JSON.stringify(credential) }, env);
  expect(acceptance.status, await acceptance.clone().text()).toBe(200);
  expect(await acceptance.json()).toMatchObject({ status: "accepted", invitation: { acceptedByUserId: recipientId } });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true });
  expect((await app.request("/sharing/accept", { method: "POST", headers, body: JSON.stringify({ link: edited }) }, env)).status).toBe(403);
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

  const offered = await room().createScopeInvitations(invitation([child]));
  if (offered.status !== "created") throw new Error(JSON.stringify(offered));
  const { text } = await deliveredParts(offered.invitations[0]!.id);
  // The whole point of a scoped invitation: an offer of one conversation must
  // not put a sibling's or the parent's work into an unauthenticated mailbox.
  expect(text).toContain("Child transcript, which is what was offered.");
  expect(text).not.toContain("Main transcript");
  // And only what people said. Tool output and system notices are not
  // conversation and never leave the product this way.
  expect(text).not.toContain("A system notice");

  const whole = await room().createScopeInvitations(invitation([main]));
  if (whole.status !== "created") throw new Error(JSON.stringify(whole));
  const mainParts = await deliveredParts(whole.invitations[0]!.id);
  expect(mainParts.text).toContain("Main transcript, not shared here.");
  expect(mainParts.text).not.toContain("Child transcript");
});

it("names the sender and the workspace, and still sends when the conversation cannot be previewed", async () => {
  const created = await room().createScopeInvitations(invitation());
  if (created.status !== "created") throw new Error(JSON.stringify(created));
  const { text, html } = await deliveredParts(created.invitations[0]!.id);
  expect(text.split("\n")[0]).toBe("Adam Owner invited you to Shared workspace on Rally.");
  expect(text).toContain("Sign in with guest@example.test and accept:");
  expect(text).toContain((await deliveredLink(created.invitations[0]!.id)).toString());
  expect(text).toContain("This invitation does not grant access until you sign in and accept it.");
  expect(text.trimEnd().endsWith("work it through together.")).toBe(true);
  // This work stream's conversation object was never provisioned, so the
  // preview cannot be read. An invitation is not a preview: it goes anyway,
  // with nothing quoted.
  expect(text).not.toContain(">");
  // Both parts are composed once and stored together, so a delivery retry
  // sends the message that was composed rather than one rendered again later.
  expect(html).toContain("Adam Owner");
  expect(html).toContain("Shared workspace");
  expect(html).toContain(`href="${(await deliveredLink(created.invitations[0]!.id)).toString()}"`);
});

it("takes back the links it minted for a creation it did not record", async () => {
  const rows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM link_payloads").first<{ n: number }>())!.n;
  const operationId = crypto.randomUUID();
  const two = { ...invitation(), operationId, emails: ["guest@example.test", "second@example.test"] };
  expect(await room().createScopeInvitations(two)).toMatchObject({ status: "created" });
  expect(await rows()).toBe(2);

  // A replay of the same operation reports the first attempt's invitations, so
  // the links it minted on the way there address nothing. Nothing else can
  // reach them: the row is keyed by a digest of a token only this call held.
  expect(await room().createScopeInvitations(two)).toMatchObject({ status: "created" });
  expect(await rows()).toBe(2);

  // Same for a creation nobody was allowed to make. The invitation is refused
  // before it is recorded, and its rows go with it.
  expect(await room().createScopeInvitations({ ...invitation(), actorUserId: recipientId }))
    .toMatchObject({ status: "denied", reason: "sharing_required" });
  expect(await rows()).toBe(2);
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
    expect(await room().createScopeInvitations(invitation())).toMatchObject({ status: "created" });
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

it("stops describing an invitation past its deadline, accepted or not", async () => {
  const soon = Date.now() + 60_000;
  const created = await room().createScopeInvitations({ ...invitation(), expiresAt: soon });
  if (created.status !== "created") throw new Error(JSON.stringify(created));
  const invitationId = created.invitations[0]!.id;
  const token = await tokenFor(invitationId);
  const request = { workspaceId, parentId, invitationId, userId: recipientId, token };
  expect(await room().describeScopeInvitation({ workspaceId, parentId, invitationId, token }))
    .toMatchObject({ status: "ready", email: "guest@example.test" });
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "accepted" });

  // An accepted invitation stays replayable past its deadline, so that someone
  // who already holds the grant can retry an interrupted acceptance. Releasing
  // the mailbox is a disclosure rather than idempotence, and ends at the
  // deadline either way.
  await runInDurableObject(room(), (_instance, state) => {
    // The deadline lives in the stored summary, so age it there.
    const stored = state.storage.sql.exec<{ summary_json: string }>(
      "SELECT summary_json FROM parent_invitations WHERE parent_id = ? AND id = ?", parentId, invitationId).one();
    state.storage.sql.exec("UPDATE parent_invitations SET summary_json = ? WHERE parent_id = ? AND id = ?",
      JSON.stringify({ ...JSON.parse(stored.summary_json), expiresAt: Date.now() - 1_000 }), parentId, invitationId);
  });
  expect(await room().acceptScopeInvitation(request)).toMatchObject({ status: "accepted" });
  expect(await room().describeScopeInvitation({ workspaceId, parentId, invitationId, token }))
    .toMatchObject({ status: "denied", reason: "invitation_unavailable" });
});

it("stops describing an invitation the sender revoked, holding back the mailbox with it", async () => {
  const request = await create();
  const credential = await credentialFor(request.invitationId);
  const app = createApp();
  const preview = () => app.request("/browser/invitation", { method: "POST",
    headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(credential) }, env);
  expect((await preview()).status).toBe(200);
  expect(await room().revokeScopeInvitation({ workspaceId, parentId, actorUserId: actorId,
    invitationId: request.invitationId, expectedRevision: 1 })).toMatchObject({ status: "revoked" });
  expect((await preview()).status).toBe(403);
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
    ...["slug TEXT", "timezone TEXT", "created_at TEXT"].map((column) =>
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
  await seedParent(secondParent, "Second parent", [secondChild]);
  const result = await room().createScopeInvitations({ ...invitation([secondChild]), parentId: secondParent });
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
  expect(await room().readScopeAccess({ userId: recipientId, target: secondChild })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: { ...main, parentId: secondParent } })).toMatchObject({ allowed: false });
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
    expect(await room().readScopeAccess({ userId:recipientId,target })).toMatchObject({ allowed:true,writable:true });
    expect(await room().readScopeAccess({ userId:recipientId,target:{ ...target,substreamId:asSubstreamId("0") } }))
      .toMatchObject({ allowed:false });
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?")
    .bind(workspaceId,recipientId).first()).toEqual({ n:1 });
});

it("reports missing legacy sharing authority without pretending migration is pending", async () => {
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", parentId, childId);
  });
  expect(await room().createScopeInvitations(invitation())).toMatchObject({ status: "denied", reason: "sharing_required" });
  await runInDurableObject(room(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM parent_invitations WHERE parent_id=?", parentId).toArray()).toEqual([]);
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
