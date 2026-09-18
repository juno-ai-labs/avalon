/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { seedOpenWorkstreamAuthority } from "./helpers/substream-fixture";
import { listSharedDirectory } from "../src/services/shared-directory-service";
import { AuthorizationService } from "../src/services/authorization-service";
import type { Env } from "../src/env";
import { consumeEffectBodies, pendingParentEffects } from "./helpers/conversation-effects";
import { conversationObjectName, workspaceDOName, workstreamDOName } from "../src/durable-objects/names";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000071");
const parentId = asWorkstreamId("00000000-0000-4000-8000-000000000072");
const actorId = asUserId("00000000-0000-4000-8000-000000000073");
const recipientId = asUserId("00000000-0000-4000-8000-000000000074");
const childId = asSubstreamId("00000000-0000-4000-8000-000000000075");
const child: ScopeGrantTarget = { kind: "conversation", workspaceId, parentId, substreamId: childId };
const main: ScopeGrantTarget = { ...child, substreamId: asSubstreamId("0") };
const parent: ScopeGrantTarget = { kind: "workstream", workspaceId, parentId };
const room = () => env.WORKSTREAM_DOS.getByName(workstreamDOName("global", workspaceId, parentId));
const mutation = (target: ScopeGrantTarget = child) => ({ operationId: crypto.randomUUID(), actorUserId: actorId,
  userId: recipientId, target, active: true, expectedRevision: 0 });

async function seedActorGrant(target: ScopeGrantTarget) {
  await runInDurableObject(room(), (_instance) => {
    _instance['scopeGrants']({ workspaceId, parentId }).mutate({
      operationId: crypto.randomUUID(), actorUserId: actorId, userId: actorId, target, active: true, expectedRevision: 0,
    }, actorId);
  });
}

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam')"),
    env.DB.prepare("INSERT INTO workspaces (id) VALUES (?)").bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT,revision INTEGER)`),
    ...[actorId,recipientId].map((id) => env.DB.prepare("INSERT INTO workspace_members VALUES (?,?,'guest',NULL,'active',?,1)")
      .bind(workspaceId,id,id)),
  ]);
  await room().authority({ workspaceId, parentId });
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO workstream_metadata
      (id,workspace_id,workstream_id,region,authority_generation,title,description,preview,scope,exact_state,last_activity_at,created_at,updated_at)
      VALUES (1,?,?,'global',1,'Private parent','','','personal','idle',0,0,0)`,workspaceId,parentId);
    state.storage.sql.exec("INSERT INTO conversation_children (substream_id,kind,created_at) VALUES ('0','main',0), (?,'child',0)", childId);
  });
});

it("admits and shares an independent child without granting Main or parent mutation", async () => {
  await seedActorGrant(child);
  expect(await room().mutateScopeGrant(mutation())).toMatchObject({ status: "committed" });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true, writable: true });
  for (const target of [main,parent]) {
    expect(await room().readScopeAccess({ userId: recipientId, target })).toEqual({ allowed: false, reason: "grant_required" });
    expect(await room().mutateScopeGrant(mutation(target))).toEqual({ status: "denied", reason: "sharing_required" });
  }
  await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(recipientId).run();
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toEqual({ allowed: false, reason: "relationship_required" });
});

it("refuses a legacy Main migration over an existing parent grant ledger", async () => {
  await seedActorGrant(parent);
  expect(await room().beginMainParticipantMigration({ workspaceId,parentId })).toEqual({ status:"conflict" });
  await runInDurableObject(room(), (_instance,state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM main_participant_migration").toArray()).toEqual([]);
    expect(_instance['scopeGrants'](parent).forUser(actorId)).toHaveLength(1);
  });
});

it("refuses a legacy child migration over an existing conversation grant ledger", async () => {
  await seedActorGrant(child);
  expect(await room().beginChildParticipantMigration({ workspaceId,parentId,substreamId:childId })).toEqual({ status:"conflict" });
  await runInDurableObject(room(), (_instance,state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM child_participant_migrations").toArray()).toEqual([]);
    expect(_instance['scopeGrants'](parent).forUser(actorId)).toHaveLength(1);
  });
});

it("does not turn workspace-public member reading into sharing authority", async () => {
  await env.DB.prepare("UPDATE workspace_members SET access_class='member',role='member' WHERE user_id=?").bind(actorId).run();
  await runInDurableObject(room(), (_instance,state) => { state.storage.sql.exec("UPDATE workstream_metadata SET scope='workspace'"); });
  expect(await room().readScopeAccess({ userId: actorId, target: main })).toMatchObject({ allowed: true, workspaceMemberAccess: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: false });
  expect(await room().mutateScopeGrant(mutation(main))).toEqual({ status: "denied", reason: "sharing_required" });
  await seedOpenWorkstreamAuthority(env.DB);
  const mainSource = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, parentId));
  await mainSource.bootstrapRuntime({ workspaceId, parentId, substreamId: asSubstreamId("0"), parentKind: "workstream", generation: 1 });
  expect((await mainSource.executeIdentityOperation({ workspaceId, workstreamId: parentId, substreamId: asSubstreamId("0"),
    operation: "provision", args: [{ title: "Unowned public workstream", objective: "Sharing authority",
      scope: "workspace", originType: "ad_hoc", createdByUserId: actorId, participantUserIds: [], harnessStatus: "idle",
      emailAddress: null, emailRouteStatus: null, systemKind: null, automationRunId: null, plannedFor: null,
      modelOverride: null, now: Date.now() }] })).status).toBe(200);
  // An ownerless public parent does not let a reader manufacture sharing
  // authority through invitation preparation or its advisory UI choices.
  expect(await room().scopeSharingOptions({ workspaceId, parentId, actorUserId: actorId }))
    .toEqual({ scopes: [], completeWorkstreamTargets: null });
  expect(await room().createScopeInvitations({ workspaceId, parentId, actorUserId: actorId,
    operationId: crypto.randomUUID(), emails: ["invitee@example.test"], expiresAt: null, targets: [main] }))
    .toMatchObject({ status: "denied" });
  await runInDurableObject(room(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM main_participant_migration").toArray()).toEqual([]);
    expect(state.storage.sql.exec("SELECT 1 FROM scope_invitations").toArray()).toEqual([]);
  });
});

it("inherits a whole-workstream grant only into Main and explicitly inheriting children", async () => {
  await seedActorGrant(parent);
  expect(await room().mutateScopeGrant(mutation(parent))).toMatchObject({ status: "committed" });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: false });
  await runInDurableObject(room(), (_instance,state) => { state.storage.sql.exec("UPDATE conversation_children SET audience='inherits_workstream' WHERE substream_id=?",childId); });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true, writable: true });
});

it("rejects inactive actors, inactive recipients, archived scopes and abandoned workspaces", async () => {
  await seedActorGrant(child);
  await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(recipientId).run();
  expect(await room().mutateScopeGrant(mutation())).toEqual({ status: "denied", reason: "recipient_relationship_required" });
  await env.DB.prepare("UPDATE workspace_members SET status='active'").run();
  await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId).run();
  expect(await room().mutateScopeGrant(mutation())).toEqual({ status: "denied", reason: "sharing_required" });
  await env.DB.prepare("UPDATE workspace_members SET status='active'").run();
  await runInDurableObject(room(), (_instance,state) => { state.storage.sql.exec("UPDATE workstream_metadata SET archived_at=1"); });
  expect(await room().mutateScopeGrant(mutation())).toEqual({ status: "denied", reason: "sharing_required" });
  expect(await room().readScopeAccess({ userId: actorId, target: child })).toMatchObject({ allowed: true, writable: false });
  await env.DB.prepare("UPDATE workspaces SET abandoned_at='now'").run();
  expect(await room().readScopeAccess({ userId: actorId, target: child })).toEqual({ allowed: false, reason: "relationship_required" });
});


it("serves migrated child grants without reading Main and retains admission revisions after delivery", async () => {
  await seedActorGrant(child);
  const added = await room().mutateScopeGrant(mutation());
  if (added.status !== "committed") throw new Error("Expected child grant");
  const transferId = crypto.randomUUID();
  const revision = await runInDurableObject(room(), (_instance,state) => {
    state.storage.sql.exec("INSERT INTO child_participant_migrations(substream_id,transfer_id,phase) VALUES (?,?,'pending')",childId,transferId);
    const store = _instance['scopeGrants'](parent);
    store.registerParticipantProjection(childId,transferId);
    const projection = store.participantProjection(childId,recipientId)!;
    store.acknowledgeParticipantProjection(childId,recipientId,projection.revision);
    return projection.revision;
  });
  const request = { workspaceId,parentId,userId:recipientId,substreamId:childId };
  expect(await room().authorizeViewer(request)).toMatchObject({ authorized:false });
  await runInDurableObject(room(), (_instance,state) => {
    state.storage.sql.exec("UPDATE child_participant_migrations SET phase='complete' WHERE substream_id=?",childId);
  });
  expect(await room().authorizeViewer(request)).toMatchObject({ authorized:true,membershipVersion:revision });
  const authorization = new AuthorizationService(env);
  const subject = { workspaceId,userId:recipientId,delegation:null };
  const resource = { kind:"conversation" as const,workspaceId,parentId,substreamId:childId };
  expect(await authorization.checkMany(subject,[resource])).toMatchObject([{ status:"allowed" }]);
  // No Main agent has been provisioned in this fixture. Reading its identity
  // cannot be a prerequisite for independently shared conversation access.
  expect(await room().readAuthorizationFacts({ workspaceId,parentId,userId:recipientId,substreamIds:[childId] }))
    .toMatchObject({ exists:true,authority:"grants",scopes:[{ substreamId:childId,access:{ allowed:true } }] });
  expect(await room().authorizeViewer({ ...request,substreamId:asSubstreamId("0") })).toMatchObject({ authorized:false });
  const revoked = await room().mutateScopeGrant({ ...mutation(),operationId:crypto.randomUUID(),active:false,expectedRevision:added.grant.revision });
  expect(revoked.status).toBe("committed");
  expect(await room().authorizeViewer(request)).toMatchObject({ authorized:false });
  expect(await authorization.checkMany(subject,[resource])).toMatchObject([{ status:"denied" }]);
  expect(await room().readAuthorizationFacts({ workspaceId,parentId,userId:recipientId,substreamIds:[childId] }))
    .toMatchObject({ authority:"grants",scopes:[{ access:{ allowed:false,reason:"grant_required" } }] });
  await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId).run();
  expect(await room().authorizeViewer({ ...request,userId:actorId })).toMatchObject({ authorized:false });
});

it("requires a fresh grant after membership removal and rejoin", async () => {
  await seedActorGrant(child);
  const command = mutation();
  const added = await room().mutateScopeGrant(command);
  if (added.status !== "committed") throw new Error("Expected grant");
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:true });
  await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(recipientId).run();
  await env.DB.prepare("INSERT INTO workspace_members VALUES (?,?,'guest',NULL,'active','replacement',1)").bind(workspaceId,recipientId).run();
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:false });
  // Replaying the old operation is a receipt, never admission for the new membership.
  expect(await room().mutateScopeGrant(command)).toEqual(added);
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:false });
  const renewed = await room().mutateScopeGrant({ ...mutation(),expectedRevision:added.grant.revision });
  expect(renewed).toMatchObject({ status:"committed",grant:{ membershipIncarnation:"replacement" } });
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:true });
});


it("hands committed grants to the durable parent outbox even when Queue delivery fails", async () => {
  await runInDurableObject(room(), (instance) => {
    const target = instance as unknown as { env: Env };
    const refused = () => Promise.reject(new Error("effect_queue_parked_by_test"));
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "ACTIVITY_QUEUE"
        ? { send: refused, sendBatch: refused } : Reflect.get(current, property, receiver),
    });
  });
  await seedActorGrant(child);
  const added = await room().mutateScopeGrant(mutation());
  expect(added).toMatchObject({ status: "committed" });
  if (added.status !== "committed") throw new Error("expected committed grant");
  await runDurableObjectAlarm(room());
  const effects = (await pendingParentEffects(room())).filter((item) => item.effect.kind === "scope_grant_directory");
  expect(effects).toHaveLength(2);
  expect(effects).toEqual(expect.arrayContaining([expect.objectContaining({
    parentId, workspaceId, effect: expect.objectContaining({ grant: expect.objectContaining({
      userId: recipientId, active: true, membershipIncarnation: recipientId, target: child,
    }) }),
  })]));
  await runInDurableObject(room(), (_instance) => {
    expect(_instance['scopeGrants']({ workspaceId, parentId }).pendingDeliveries()).toEqual([]);
  });
  const directory = env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
  await directory.initializeWorkspace(workspaceId, "wnam");
  expect(await consumeEffectBodies(env, effects)).toEqual({ acked: 2, retried: 0 });
  expect(await directory.listScopeGrantCandidates({ workspaceId, userId: recipientId,
    membershipIncarnation: recipientId })).toEqual([parentId]);
  expect(await listSharedDirectory(env, workspaceId, recipientId)).toEqual({ workstreams: [{
    parentId, title: null, conversations: [{ substreamId: childId, title: "Shared substream", archived: false }],
  }] });
  await room().mutateScopeGrant({ ...mutation(), active: false, expectedRevision: added.grant.revision });
  // The workspace still contains the added candidate, but the canonical grant
  // has already been revoked. No Queue flush is needed to stop exposing labels.
  expect(await directory.listScopeGrantCandidates({ workspaceId, userId: recipientId,
    membershipIncarnation: recipientId })).toEqual([parentId]);
  expect(await listSharedDirectory(env, workspaceId, recipientId)).toEqual({ workstreams: [] });
});


it("releases only canonical shared conversation labels and hides Main metadata from child-only guests", async () => {
  await seedActorGrant(parent);
  await seedActorGrant(child);
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("UPDATE conversation_children SET title='Visible child' WHERE substream_id=?", childId);
  });
  const request = { workspaceId, parentId, userId: recipientId, membershipIncarnation: recipientId };
  expect(await room().readSharedWorkstream(request)).toBeNull();
  await room().mutateScopeGrant(mutation());
  expect(await room().readSharedWorkstream(request)).toEqual({ parentId, title: null,
    conversations: [{ substreamId: childId, title: "Visible child", archived: false }] });
  expect(await room().readSharedWorkstream({ ...request, membershipIncarnation: "replacement" })).toBeNull();
  await room().mutateScopeGrant(mutation(main));
  expect(await room().readSharedWorkstream(request)).toEqual({ parentId, title: "Private parent",
    conversations: [{ substreamId: "0", title: "Main", archived: false }, { substreamId: childId, title: "Visible child", archived: false }] });
  await env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(recipientId).run();
  expect(await room().readSharedWorkstream(request)).toBeNull();
});

it("lists inherited and archived readable children but omits restricted and unready scopes", async () => {
  await seedActorGrant(parent);
  await room().mutateScopeGrant(mutation(parent));
  const request = { workspaceId, parentId, userId: recipientId, membershipIncarnation: recipientId };
  expect((await room().readSharedWorkstream(request))?.conversations).toEqual([{ substreamId: "0", title: "Main", archived: false }]);
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("UPDATE conversation_children SET audience='inherits_workstream' WHERE substream_id=?", childId);
  });
  expect((await room().readSharedWorkstream(request))?.conversations).toHaveLength(2);
  for (const status of ["reserved", "failed"]) {
    await runInDurableObject(room(), (_instance, state) => {
      state.storage.sql.exec("UPDATE conversation_children SET status=? WHERE substream_id=?", status, childId);
    });
    expect((await room().readSharedWorkstream(request))?.conversations).toEqual([{ substreamId: "0", title: "Main", archived: false }]);
  }
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("UPDATE conversation_children SET status='ready', archived_at=1 WHERE substream_id=?", childId);
  });
  expect((await room().readSharedWorkstream(request))?.conversations).toHaveLength(2);
  await runInDurableObject(room(), (_instance, state) => { state.storage.sql.exec("UPDATE workstream_metadata SET archived_at=1"); });
  expect((await room().readSharedWorkstream(request))?.conversations).toHaveLength(2);
});


it("requires a parent grant for guest recommendation management and observes its revocation", async () => {
  await seedActorGrant(main);
  const input = { workspaceId, parentId, userId: actorId };
  const recommendation = { ...input, sidekickId: crypto.randomUUID(), attached: true };
  // Main collaboration is insufficient even when it remains after revocation.
  await expect((async () => room().setSidekickRecommendation(recommendation))()).rejects.toThrow("sidekick_attachment_participant_required");
  await seedActorGrant(parent);
  expect(await room().readManagementAccess(input)).toMatchObject({ allowed: true, writable: true });
  expect(await room().setSidekickRecommendation(recommendation)).toEqual([recommendation.sidekickId]);
  // Another collaborator retains parent access; last-participant protection
  // must not be the reason this later management mutation is rejected.
  expect(await room().mutateScopeGrant(mutation(parent))).toMatchObject({ status: "committed" });
  const revision = await runInDurableObject(room(), (_instance) =>
    _instance['scopeGrants'](parent).read(actorId, parent)!.revision);
  const removed = await room().mutateScopeGrant({ operationId: crypto.randomUUID(), actorUserId: actorId,
    userId: actorId, target: parent, active: false, expectedRevision: revision });
  expect(removed).toMatchObject({ status: "committed" });
  await expect((async () => room().setSidekickRecommendation({ ...recommendation, attached: false }))())
    .rejects.toThrow("sidekick_attachment_participant_required");
  expect(await room().recommendedSidekickIds({ workspaceId, parentId })).toEqual([recommendation.sidekickId]);
});
