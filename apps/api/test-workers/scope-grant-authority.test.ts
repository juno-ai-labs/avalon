/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { seedOpenWorkstreamAuthority } from "./helpers/substream-fixture";
import { listSharedDirectory, listSharedNavigationDirectory } from "../src/services/shared-directory-service";
import { AuthorizationService } from "../src/services/authorization-service";
import type { Env } from "../src/env";
import { pendingParentEffects } from "./helpers/conversation-effects";
import { conversationObjectName } from "../src/durable-objects/names";
import { countingEnv } from "./helpers/counting-namespace";
import { hostedParentStub, insertChannelRow, readSharedWorkstream, withHostedParent } from "./helpers/hosted-parent";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";
import { changeRelationships } from "./helpers/workspace-relationship-events";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000071");
const parentId = asWorkstreamId("00000000-0000-4000-8000-000000000072");
const actorId = asUserId("00000000-0000-4000-8000-000000000073");
const recipientId = asUserId("00000000-0000-4000-8000-000000000074");
const childId = asSubstreamId("00000000-0000-4000-8000-000000000075");
const siblingId = asSubstreamId("00000000-0000-4000-8000-000000000081");
const firstSpaceId = "00000000-0000-4000-8000-000000000076";
const secondSpaceId = "00000000-0000-4000-8000-000000000077";
const privateSpaceId = "00000000-0000-4000-8000-000000000080";
const secondParentId = asWorkstreamId("00000000-0000-4000-8000-000000000078");
const secondChildId = asSubstreamId("00000000-0000-4000-8000-000000000079");
const child: ScopeGrantTarget = { kind: "conversation", workspaceId, parentId, substreamId: childId };
const secondChild: ScopeGrantTarget = { kind: "conversation", workspaceId, parentId: secondParentId, substreamId: secondChildId };
const main: ScopeGrantTarget = { ...child, substreamId: asSubstreamId("0") };
const parent: ScopeGrantTarget = { kind: "workstream", workspaceId, parentId };
// Both Channels' parents, and the Organization directory, are one object now.
const room = () => hostedParentStub(env, workspaceId);
const secondRoom = room;
const mutation = (target: ScopeGrantTarget = child) => ({ operationId: crypto.randomUUID(), actorUserId: actorId,
  userId: recipientId, target, active: true, expectedRevision: 0 });

/** Runs `sql` against the Organization object that hosts every parent here. */
async function exec(sql: string, ...bindings: unknown[]) {
  await runInDurableObject(room(), (_instance, state) => { state.storage.sql.exec(sql, ...bindings); });
}

function insertParentMetadata(state: DurableObjectState, id: string, title: string): void {
  state.storage.sql.exec(`INSERT INTO parent_metadata
    (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
    VALUES (?,'workstream',?,'global',1,0,0)`, id, workspaceId);
  insertChannelRow(state, id, title);
}

async function seedActorGrant(target: ScopeGrantTarget) {
  await withHostedParent(room(), parentId, (hosted) => {
    hosted['scopeGrants']({ workspaceId, parentId }).mutate({
      operationId: crypto.randomUUID(), actorUserId: actorId, userId: actorId, target, active: true, expectedRevision: 0,
    }, actorId);
  });
}

async function initializeSecondRoom() {
  await withHostedParent(secondRoom(), secondParentId, (hosted, state) => {
    insertParentMetadata(state, secondParentId, "Research channel");
    state.storage.sql.exec(`INSERT INTO parent_children (parent_id,substream_id,kind,created_at,title)
      VALUES (?,'0','main',0,'Main'), (?,?,'child',0,'Research breakout')`, secondParentId, secondParentId, secondChildId);
    hosted['scopeGrants']({ workspaceId, parentId: secondParentId }).mutate({
      operationId: crypto.randomUUID(), actorUserId: actorId, userId: actorId,
      target: secondChild, active: true, expectedRevision: 0,
    }, actorId);
  });
}

/** Directory rows never cross the Queue now; refusing it proves the directory does not depend on it. */
async function parkEffectQueue(stub: ReturnType<typeof room>) {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    const refused = () => Promise.reject(new Error("effect_queue_parked_by_test"));
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "ACTIVITY_QUEUE"
        ? { send: refused, sendBatch: refused } : Reflect.get(current, property, receiver),
    });
  });
}

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT)"),
    ...[actorId, recipientId].map((id) => env.DB.prepare("INSERT INTO users VALUES (?, 'Person', 'person@example.test', NULL, 'UTC', '2026-09-18T00:00:00.000Z')").bind(id)),
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam')"),
    env.DB.prepare("INSERT INTO workspaces (id) VALUES (?)").bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT,revision INTEGER)`),
    ...[actorId,recipientId].map((id) => env.DB.prepare("INSERT INTO workspace_members VALUES (?,?,'guest',NULL,'active',?,1)")
      .bind(workspaceId,id,id)),
  ]);
  // A live Organization object knows its identity; a relationship change
  // event is refused by one that does not.
  await room().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(room(), (_instance, state) => {
    insertParentMetadata(state, parentId, "Private parent");
    state.storage.sql.exec("INSERT INTO parent_children (parent_id,substream_id,kind,created_at) VALUES (?,'0','main',0), (?,?,'child',0)",
      parentId, parentId, childId);
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
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(recipientId));
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toEqual({ allowed: false, reason: "relationship_required" });
});

it("lets guests resolve only their granted conversation", async () => {
  await seedActorGrant(child);
  await room().mutateScopeGrant(mutation());
  expect(await room().resolveConversation({ workspaceId, parentId, substreamId: childId, userId: recipientId }))
    .toEqual({ outcome: "resolved" });
  expect(await room().resolveConversation({ workspaceId, parentId, substreamId: asSubstreamId("0"), userId: recipientId }))
    .toEqual({ outcome: "forbidden" });
  await seedActorGrant(main);
  await room().mutateScopeGrant(mutation(main));
  expect(await room().resolveConversation({ workspaceId, parentId, substreamId: asSubstreamId("0"), userId: recipientId }))
    .toEqual({ outcome: "resolved" });
});

it("refuses a legacy Main migration over an existing parent grant ledger", async () => {
  await seedActorGrant(parent);
  expect(await room().beginMainParticipantMigration({ workspaceId,parentId })).toEqual({ status:"conflict" });
  await withHostedParent(room(), parentId, (hosted,state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM parent_participant_migrations WHERE parent_id=? AND substream_id='0'", parentId).toArray()).toEqual([]);
    expect(hosted['scopeGrants'](parent).forUser(actorId)).toHaveLength(1);
  });
});

it("refuses a legacy child migration over an existing conversation grant ledger", async () => {
  await seedActorGrant(child);
  expect(await room().beginChildParticipantMigration({ workspaceId,parentId,substreamId:childId })).toEqual({ status:"conflict" });
  await withHostedParent(room(), parentId, (hosted,state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", parentId, childId).toArray()).toEqual([]);
    expect(hosted['scopeGrants'](parent).forUser(actorId)).toHaveLength(1);
  });
});

it("does not turn workspace-public member reading into sharing authority", async () => {
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspace_members SET access_class='member',role='member' WHERE user_id=?").bind(actorId));
  await exec("UPDATE channels SET scope='workspace' WHERE workstream_id=?", parentId);
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
    expect(state.storage.sql.exec("SELECT phase FROM parent_participant_migrations WHERE parent_id=? AND substream_id='0'", parentId).toArray()).toEqual([{ phase: "complete" }]);
    expect(state.storage.sql.exec("SELECT 1 FROM parent_invitations WHERE parent_id=?", parentId).toArray()).toEqual([]);
  });
});

it("inherits a whole-workstream grant only into Main and explicitly inheriting children", async () => {
  await seedActorGrant(parent);
  expect(await room().mutateScopeGrant(mutation(parent))).toMatchObject({ status: "committed" });
  expect(await room().readScopeAccess({ userId: recipientId, target: main })).toMatchObject({ allowed: true });
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: false });
  await exec("UPDATE parent_children SET audience='inherits_workstream' WHERE parent_id=? AND substream_id=?", parentId, childId);
  expect(await room().readScopeAccess({ userId: recipientId, target: child })).toMatchObject({ allowed: true, writable: true });
});

it("rejects inactive actors, inactive recipients, archived scopes and abandoned workspaces", async () => {
  await seedActorGrant(child);
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(recipientId));
  expect(await room().mutateScopeGrant(mutation())).toEqual({ status: "denied", reason: "recipient_relationship_required" });
  await changeRelationships(env, workspaceId, [actorId, recipientId], env.DB.prepare("UPDATE workspace_members SET status='active'"));
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId));
  expect(await room().mutateScopeGrant(mutation())).toEqual({ status: "denied", reason: "sharing_required" });
  await changeRelationships(env, workspaceId, [actorId, recipientId], env.DB.prepare("UPDATE workspace_members SET status='active'"));
  await exec("UPDATE channels SET archived_at=1 WHERE workstream_id=?", parentId);
  expect(await room().mutateScopeGrant(mutation())).toEqual({ status: "denied", reason: "sharing_required" });
  expect(await room().readScopeAccess({ userId: actorId, target: child })).toMatchObject({ allowed: true, writable: false });
  // Closing a workspace suspends its last active member in the same batch,
  // and that suspension is the event the Organization hears.
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspaces SET abandoned_at='now'"),
    env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId));
  expect(await room().readScopeAccess({ userId: actorId, target: child })).toEqual({ allowed: false, reason: "relationship_required" });
});


it("serves migrated child grants without reading Main and retains admission revisions after delivery", async () => {
  await seedActorGrant(child);
  const added = await room().mutateScopeGrant(mutation());
  if (added.status !== "committed") throw new Error("Expected child grant");
  const transferId = crypto.randomUUID();
  const revision = await withHostedParent(room(), parentId, (hosted,state) => {
    state.storage.sql.exec("INSERT INTO parent_participant_migrations(parent_id,substream_id,transfer_id,phase) VALUES (?,?,?,'pending')",parentId,childId,transferId);
    const store = hosted['scopeGrants'](parent);
    store.registerParticipantProjection(childId,transferId);
    const projection = store.participantProjection(childId,recipientId)!;
    store.acknowledgeParticipantProjection(childId,recipientId,projection.revision);
    return projection.revision;
  });
  const request = { workspaceId,parentId,userId:recipientId,substreamId:childId };
  expect(await room().authorizeViewer(request)).toMatchObject({ authorized:false });
  await exec("UPDATE parent_participant_migrations SET phase='complete' WHERE parent_id=? AND substream_id=?", parentId, childId);
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
  // Direct grant mutations now deliver to the actual source before returning.
  await seedOpenWorkstreamAuthority(env.DB);
  const source = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, parentId, childId));
  await source.bootstrapRuntime({ workspaceId, parentId, substreamId: childId, parentKind: "workstream", generation: 1 });
  await source.transferParticipantAuthority({ workspaceId, parentId, substreamId: childId, transferId, phase: "prepare" });
  await source.transferParticipantAuthority({ workspaceId, parentId, substreamId: childId, transferId, phase: "commit" });
  const revoked = await room().mutateScopeGrant({ ...mutation(),operationId:crypto.randomUUID(),active:false,expectedRevision:added.grant.revision });
  expect(revoked.status).toBe("committed");
  expect(await room().authorizeViewer(request)).toMatchObject({ authorized:false });
  expect(await authorization.checkMany(subject,[resource])).toMatchObject([{ status:"denied" }]);
  expect(await room().readAuthorizationFacts({ workspaceId,parentId,userId:recipientId,substreamIds:[childId] }))
    .toMatchObject({ authority:"grants",scopes:[{ access:{ allowed:false,reason:"grant_required" } }] });
  await changeRelationships(env, workspaceId, [actorId], env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(actorId));
  expect(await room().authorizeViewer({ ...request,userId:actorId })).toMatchObject({ authorized:false });
});

it("requires a fresh grant after membership removal and rejoin", async () => {
  await seedActorGrant(child);
  const command = mutation();
  const added = await room().mutateScopeGrant(command);
  if (added.status !== "committed") throw new Error("Expected grant");
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:true });
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(recipientId));
  await changeRelationships(env, workspaceId, [recipientId],
    env.DB.prepare("INSERT INTO workspace_members VALUES (?,?,'guest',NULL,'active','replacement',1)").bind(workspaceId,recipientId));
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:false });
  // Replaying the old operation is a receipt, never admission for the new membership.
  expect(await room().mutateScopeGrant(command)).toEqual(added);
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:false });
  const renewed = await room().mutateScopeGrant({ ...mutation(),expectedRevision:added.grant.revision });
  expect(renewed).toMatchObject({ status:"committed",grant:{ membershipIncarnation:"replacement" } });
  expect(await room().readScopeAccess({ userId:recipientId,target:child })).toMatchObject({ allowed:true });
});


it("applies committed grants to the grant directory in the same object even when Queue delivery fails", async () => {
  // The grant directory used to be a Queue hop away, and this test proved the
  // grant waited in the parent outbox while the Queue refused it. The
  // directory is now in the same object, applied straight after the write, so
  // a refused Queue must not keep the grant from being discoverable.
  await parkEffectQueue(room());
  await seedActorGrant(child);
  const added = await room().mutateScopeGrant(mutation());
  expect(added).toMatchObject({ status: "committed" });
  if (added.status !== "committed") throw new Error("expected committed grant");
  // Nothing is left waiting for the Queue: both grants were applied locally.
  expect((await pendingParentEffects(room())).filter((item) => item.effect.kind === "scope_grant_directory")).toEqual([]);
  const directory = room();
  await directory.initializeWorkspace(workspaceId, "wnam");
  expect(await directory.listScopeGrantCandidates({ workspaceId, userId: actorId,
    membershipIncarnation: actorId, accessClass: "guest" })).toEqual([parentId]);
  await runInDurableObject(directory, (_instance, state) => {
    for (const [spaceId, title, appearance, createdAt] of [
      [firstSpaceId, "Product", '{"icon":"rocket","color":"violet"}', 1],
      [secondSpaceId, "Research", '{"icon":"lightbulb","color":"teal"}', 2],
    ] as const) {
      state.storage.sql.exec(`INSERT INTO spaces (
        space_id, title, scope, appearance_json, archived_at, created_by_user_id,
        system_role, authority_generation, source_version, payload_hash, revision,
        created_at, updated_at, source_created_at, source_updated_at
      ) VALUES (?, ?, 'workspace', ?, NULL, ?, NULL, 1, 1, ?, 1, ?, ?, ?, ?)`,
      spaceId, title, appearance, actorId, `hash-${spaceId}`, createdAt, createdAt, createdAt, createdAt);
      state.storage.sql.exec(`INSERT INTO space_channel_memberships
        (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
        VALUES (?, ?, 'active', 1, 1, 1, NULL)`, spaceId, parentId);
    }
  });
  expect(await directory.listScopeGrantCandidates({ workspaceId, userId: recipientId,
    membershipIncarnation: recipientId, accessClass: "guest" })).toEqual([parentId]);
  expect(await listSharedDirectory(env, workspaceId, recipientId)).toEqual({ workstreams: [{
    parentId, title: null, archived: false, conversations: [{ substreamId: childId, title: "Shared breakout", archived: false }],
  }] });
  // A released desktop asks without `shell` and parses strictly: it must get
  // exactly the keys it knows, or it rejects the whole read.
  expect(await listSharedNavigationDirectory(env, workspaceId, recipientId)).toEqual({
    spaces: [
      { id: firstSpaceId, name: "Product", iconKey: "rocket", colorKey: "violet", scope: "workspace", workstreamIds: [parentId] },
      { id: secondSpaceId, name: "Research", iconKey: "lightbulb", colorKey: "teal", scope: "workspace", workstreamIds: [parentId] },
    ],
    workstreams: [{ parentId, title: "Private parent", scope: "personal", archived: false,
      conversations: [{ substreamId: childId, title: "Shared breakout", scope: "personal", archived: false }] }],
  });
  expect(await listSharedNavigationDirectory(env, workspaceId, recipientId, false, true)).toEqual({
    spaces: [
      { id: firstSpaceId, name: "Product", iconKey: "rocket", colorKey: "violet", scope: "workspace", systemRole: null, workstreamIds: [parentId] },
      { id: secondSpaceId, name: "Research", iconKey: "lightbulb", colorKey: "teal", scope: "workspace", systemRole: null, workstreamIds: [parentId] },
    ],
    workstreams: [{ parentId, title: "Private parent", scope: "personal", archived: false,
      conversations: [{ substreamId: childId, title: "Shared breakout", scope: "personal", archived: false, originTurnId: null }] }],
  });
  expect((await listSharedNavigationDirectory(env, workspaceId, recipientId, true))
    .workstreams[0]?.conversations[0]?.needsAttention).toBe(false);
  // The revocation's directory row lands in the revocation's own transaction.
  await room().mutateScopeGrant({ ...mutation(), active: false, expectedRevision: added.grant.revision });
  expect(await directory.listScopeGrantCandidates({ workspaceId, userId: recipientId,
    membershipIncarnation: recipientId, accessClass: "guest" })).toEqual([]);
  // A candidate index that still named the Channel (a directory row restored
  // from before the revocation) would not expose it either: the canonical
  // grant is what the listing reads.
  await exec(`UPDATE scope_grant_directory SET active = 1 WHERE parent_id = ? AND user_id = ?`, parentId, recipientId);
  expect(await directory.listScopeGrantCandidates({ workspaceId, userId: recipientId,
    membershipIncarnation: recipientId, accessClass: "guest" })).toEqual([parentId]);
  expect(await listSharedDirectory(env, workspaceId, recipientId)).toEqual({ workstreams: [] });
  expect(await listSharedNavigationDirectory(env, workspaceId, recipientId)).toEqual({ spaces: [], workstreams: [] });
});

it("shows every containing Organization-wide Space when a guest has shared Breakouts, reading every Channel in one round trip", async () => {
  await initializeSecondRoom();
  await parkEffectQueue(room());
  await seedActorGrant(child);
  expect(await room().mutateScopeGrant(mutation())).toMatchObject({ status: "committed" });
  expect(await secondRoom().mutateScopeGrant({
    ...mutation(secondChild),
    target: secondChild,
  })).toMatchObject({ status: "committed" });

  const directory = room();
  await directory.initializeWorkspace(workspaceId, "wnam");
  // Both Channels' grants reached the directory without the Queue.
  expect((await pendingParentEffects(room())).filter((item) => item.effect.kind === "scope_grant_directory")).toEqual([]);
  await runInDurableObject(directory, (_instance, state) => {
    for (const [spaceId, title, appearance, workstreamId, createdAt] of [
      [firstSpaceId, "Product", '{"icon":"rocket","color":"violet"}', parentId, 1],
      [secondSpaceId, "Research", '{"icon":"lightbulb","color":"teal"}', secondParentId, 2],
    ] as const) {
      state.storage.sql.exec(`INSERT INTO spaces (
        space_id, title, scope, appearance_json, archived_at, created_by_user_id,
        system_role, authority_generation, source_version, payload_hash, revision,
        created_at, updated_at, source_created_at, source_updated_at
      ) VALUES (?, ?, 'workspace', ?, NULL, ?, NULL, 1, 1, ?, 1, ?, ?, ?, ?)`,
      spaceId, title, appearance, actorId, `hash-${spaceId}`, createdAt, createdAt, createdAt, createdAt);
      state.storage.sql.exec(`INSERT INTO space_channel_memberships
        (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
        VALUES (?, ?, 'active', 1, 1, 1, NULL)`, spaceId, workstreamId);
    }
    state.storage.sql.exec(`INSERT INTO spaces (
      space_id, title, scope, appearance_json, archived_at, created_by_user_id,
      system_role, authority_generation, source_version, payload_hash, revision,
      created_at, updated_at, source_created_at, source_updated_at
    ) VALUES (?, 'Private planning', 'personal', '{"icon":"star","color":"red"}', NULL, ?, NULL, 1, 1, 'private-hash', 1, 3, 3, 3, 3)`,
    privateSpaceId, actorId);
    state.storage.sql.exec(`INSERT INTO space_channel_memberships
      (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
      VALUES (?, ?, 'active', 1, 1, 1, NULL)`, privateSpaceId, parentId);
  });

  const calls: string[] = [];
  expect(await listSharedNavigationDirectory(countingEnv(calls), workspaceId, recipientId, false, true)).toEqual({
    spaces: [
      { id: firstSpaceId, name: "Product", iconKey: "rocket", colorKey: "violet", scope: "workspace", systemRole: null, workstreamIds: [parentId] },
      { id: secondSpaceId, name: "Research", iconKey: "lightbulb", colorKey: "teal", scope: "workspace", systemRole: null, workstreamIds: [secondParentId] },
      // A private Channel stays unnamed to anybody outside it, a guest reached
      // through a shared thread included.
    ],
    workstreams: [
      { parentId, title: "Private parent", scope: "personal", archived: false,
        conversations: [{ substreamId: childId, title: "Shared breakout", scope: "personal", archived: false, originTurnId: null }] },
      { parentId: secondParentId, title: "Research channel", scope: "personal", archived: false,
        conversations: [{ substreamId: secondChildId, title: "Research breakout", scope: "personal", archived: false, originTurnId: null }] },
    ],
  });
  // Two shared Channels, one read for both of them: the round trips do not
  // grow with the number of Channels shared.
  expect(calls.filter((call) => call === "readSharedWorkstreams")).toHaveLength(1);
});

it("answers a batch read Channel by Channel, withholding one while releasing the other", async () => {
  await initializeSecondRoom();
  expect(await secondRoom().mutateScopeGrant(mutation(secondChild))).toMatchObject({ status: "committed" });
  expect(await room().readSharedWorkstreams({ workspaceId, parentIds: [parentId, secondParentId],
    userId: recipientId, membershipIncarnation: recipientId })).toEqual([
    null,
    { parentId: secondParentId, title: "Research channel", scope: "personal", archived: false,
      conversations: [{ substreamId: secondChildId, title: "Research breakout", scope: "personal", archived: false, originTurnId: null }] },
  ]);
});


it("releases canonical Channel and shared conversation labels without granting Main", async () => {
  await seedActorGrant(parent);
  await seedActorGrant(child);
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec("UPDATE parent_children SET title='Visible child' WHERE parent_id=? AND substream_id=?", parentId, childId);
    for (const [substreamId, icon, color] of [["0", "briefcase", "blue"], [childId, "star", "red"]] as const) {
      state.storage.sql.exec(`INSERT INTO parent_child_projections
        (parent_id, substream_id, source_version, payload_hash, effect_json, updated_at)
        VALUES (?, ?, 1, ?, json(?), 1)`, parentId, substreamId, `hash-${substreamId}`, JSON.stringify({
        kind: "directory_common",
        appearance: { icon, color },
        title: substreamId === "0" ? "Private parent" : "Visible child",
        description: "",
        preview: "",
        scope: "personal",
        state: "idle",
        systemKind: null,
        lastActivityAt: "2026-09-18T00:00:00.000Z",
        completedAt: null,
        archivedAt: null,
      }));
    }
  });
  const request = { workspaceId, parentId, userId: recipientId, membershipIncarnation: recipientId };
  expect(await readSharedWorkstream(room(), request)).toBeNull();
  await room().mutateScopeGrant(mutation());
  expect(await readSharedWorkstream(room(), request)).toEqual({ parentId, title: "Private parent", scope: "personal", archived: false,
    appearance: { icon: "briefcase", color: "blue" },
    conversations: [{ substreamId: childId, title: "Visible child", scope: "personal", archived: false, originTurnId: null,
      appearance: { icon: "star", color: "red" } }] });
  expect(await readSharedWorkstream(room(), { ...request, membershipIncarnation: "replacement" })).toBeNull();
  await room().mutateScopeGrant(mutation(main));
  expect(await readSharedWorkstream(room(), request)).toEqual({ parentId, title: "Private parent", scope: "personal", archived: false,
    appearance: { icon: "briefcase", color: "blue" },
    conversations: [{ substreamId: "0", title: "Main", scope: "personal", archived: false,
      appearance: { icon: "briefcase", color: "blue" } }, { substreamId: childId, title: "Visible child", scope: "personal", archived: false, originTurnId: null,
      appearance: { icon: "star", color: "red" } }] });
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").bind(recipientId));
  expect(await readSharedWorkstream(room(), request)).toBeNull();
});

it("opts guest navigation into attention for each granted Breakout without releasing Main", async () => {
  const sibling = { kind: "conversation" as const, workspaceId, parentId, substreamId: siblingId };
  await runInDurableObject(room(), (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO parent_children (parent_id,substream_id,kind,created_at,title) VALUES (?,?,'child',2,'Second shared breakout')",
      parentId, siblingId,
    );
    state.storage.sql.exec(`INSERT INTO parent_child_viewer_projections
      (parent_id,substream_id,user_id,source_version,payload_hash,effect_json,updated_at)
      VALUES (?,?,?,1,'sibling-attention',json(?),2)`, parentId, siblingId, recipientId, JSON.stringify({
      kind: "directory_user", userId: recipientId, isParticipant: true,
      unreadCount: 1, youAreMentioned: true, unseen: false, listable: true,
    }));
  });
  await seedActorGrant(child);
  await seedActorGrant(sibling);
  expect(await room().mutateScopeGrant(mutation())).toMatchObject({ status: "committed" });
  expect(await room().mutateScopeGrant(mutation(sibling))).toMatchObject({ status: "committed" });
  const request = { workspaceId, parentId, userId: recipientId, membershipIncarnation: recipientId };
  await exec("UPDATE parent_children SET resolved = 1 WHERE parent_id = ? AND substream_id = ?", parentId, childId);
  expect((await readSharedWorkstream(room(), { ...request, includeResolution: true }))?.conversations).toEqual([
    { substreamId: childId, title: "Shared breakout", scope: "personal", archived: false, originTurnId: null, resolved: true },
    { substreamId: siblingId, title: "Second shared breakout", scope: "personal", archived: false, originTurnId: null },
  ]);
  expect((await readSharedWorkstream(room(), request))?.conversations).toEqual([
    { substreamId: childId, title: "Shared breakout", scope: "personal", archived: false, originTurnId: null },
    { substreamId: siblingId, title: "Second shared breakout", scope: "personal", archived: false, originTurnId: null },
  ]);
  expect((await readSharedWorkstream(room(), { ...request, includeAttention: true }))?.conversations).toEqual([
    { substreamId: childId, title: "Shared breakout", scope: "personal", archived: false, originTurnId: null, needsAttention: false },
    { substreamId: siblingId, title: "Second shared breakout", scope: "personal", archived: false, originTurnId: null, needsAttention: true },
  ]);
});

it("lists inherited and archived readable children but omits restricted and unready scopes", async () => {
  await seedActorGrant(parent);
  await room().mutateScopeGrant(mutation(parent));
  const request = { workspaceId, parentId, userId: recipientId, membershipIncarnation: recipientId };
  expect((await readSharedWorkstream(room(), request))?.conversations).toEqual([{ substreamId: "0", title: "Main", scope: "personal", archived: false }]);
  await exec("UPDATE parent_children SET audience='inherits_workstream' WHERE parent_id=? AND substream_id=?", parentId, childId);
  expect((await readSharedWorkstream(room(), request))?.conversations).toHaveLength(2);
  for (const status of ["reserved", "failed"]) {
    await exec("UPDATE parent_children SET status=? WHERE parent_id=? AND substream_id=?", status, parentId, childId);
    expect((await readSharedWorkstream(room(), request))?.conversations).toEqual([{ substreamId: "0", title: "Main", scope: "personal", archived: false }]);
  }
  await exec("UPDATE parent_children SET status='ready', archived_at=1 WHERE parent_id=? AND substream_id=?", parentId, childId);
  expect((await readSharedWorkstream(room(), request))?.conversations).toHaveLength(2);
  expect((await readSharedWorkstream(room(), request))?.archived).toBe(false);
  await exec("UPDATE channels SET archived_at=1 WHERE workstream_id=?", parentId);
  expect((await readSharedWorkstream(room(), request))?.archived).toBe(true);
  expect((await readSharedWorkstream(room(), request))?.conversations).toHaveLength(2);
});


it("requires a parent grant for guest recommendation management and observes its revocation", async () => {
  await seedActorGrant(main);
  const input = { workspaceId, parentId, userId: actorId };
  const recommendation = { ...input, sidekickId: crypto.randomUUID(), attached: true };
  await exec(`INSERT INTO automation_directory
      (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
       owning_workstream_id, title, description, next_run_at, projected_at)
    VALUES (?, ?, ?, 1, 'test', 'active', 'workspace', NULL, 'Shared', '', NULL, 0)`,
  recommendation.sidekickId, workspaceId, actorId);
  // Main collaboration is insufficient even when it remains after revocation.
  await expect((async () => room().setSidekickRecommendation(recommendation))()).rejects.toThrow("sidekick_attachment_participant_required");
  await seedActorGrant(parent);
  expect(await room().readManagementAccess(input)).toMatchObject({ allowed: true, writable: true });
  expect(await room().setSidekickRecommendation(recommendation)).toEqual([recommendation.sidekickId]);
  // Another collaborator retains parent access; last-participant protection
  // must not be the reason this later management mutation is rejected.
  expect(await room().mutateScopeGrant(mutation(parent))).toMatchObject({ status: "committed" });
  const revision = await withHostedParent(room(), parentId, (hosted) =>
    hosted['scopeGrants'](parent).read(actorId, parent)!.revision);
  const removed = await room().mutateScopeGrant({ operationId: crypto.randomUUID(), actorUserId: actorId,
    userId: actorId, target: parent, active: false, expectedRevision: revision });
  expect(removed).toMatchObject({ status: "committed" });
  await expect((async () => room().setSidekickRecommendation({ ...recommendation, attached: false }))())
    .rejects.toThrow("sidekick_attachment_participant_required");
  expect(await room().recommendedSidekickIds({ workspaceId, parentId })).toEqual([recommendation.sidekickId]);
});

it("does not count grants from a previous relationship as remaining participants", async () => {
  await seedActorGrant(child);
  await room().mutateScopeGrant(mutation());
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("UPDATE workspace_members SET incarnation='replacement' WHERE user_id=?").bind(recipientId));
  expect(await room().mutateScopeGrant({ ...mutation(), userId: actorId, active: false,
    expectedRevision: 1 })).toEqual({ status: "denied", reason: "participant_required" });
});

it("retains implicit Main member admission after participant authority transfer", async () => {
  await changeRelationships(env, workspaceId, [recipientId], env.DB.prepare("UPDATE workspace_members SET access_class='member',role='member' WHERE user_id=?").bind(recipientId));
  const source = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, parentId));
  await seedOpenWorkstreamAuthority(env.DB);
  await source.bootstrapRuntime({ workspaceId, parentId, substreamId: asSubstreamId("0"), parentKind: "workstream", generation: 1 });
  await source.executeIdentityOperation({ workspaceId, workstreamId: parentId, substreamId: asSubstreamId("0"),
    operation: "provision", args: [{ title: "Public workstream", objective: "Member admission",
      scope: "workspace", originType: "ad_hoc", createdByUserId: actorId, participantUserIds: [actorId], harnessStatus: "idle",
      emailAddress: null, emailRouteStatus: null, systemKind: null, automationRunId: null, plannedFor: null,
      modelOverride: null, now: Date.now() }] });
  await exec("UPDATE channels SET scope='workspace' WHERE workstream_id=?", parentId);
  await room().beginMainParticipantMigration({ workspaceId, parentId });
  await withHostedParent(room(), parentId, async (hosted) => { await hosted['runMainParticipantMigration'](); });
  const admission = await room().authorizeViewer({ workspaceId, parentId, substreamId: asSubstreamId('0'), userId: recipientId });
  expect(admission).toMatchObject({ authorized: true, membershipVersion: 0 });
  await runInDurableObject(source, (instance) => {
    expect(instance['conversationMembershipAllows'](recipientId, admission.membershipVersion ?? 0)).toBe(true);
    expect(instance['conversationMembershipAllows'](recipientId, 999)).toBe(false);
  });
});
