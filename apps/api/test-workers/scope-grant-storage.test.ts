/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";
import type { ScopeGrantMutation } from "@rally/contracts/scope-grants";
import { PARTICIPANT_PROJECTION_ALARM, ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";
import type { HostedParent } from "../src/durable-objects/hosted-parent";
import { hostedParentStub, withHostedParent } from "./helpers/hosted-parent";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const parentId = "00000000-0000-4000-8000-000000000002";
const userId = asUserId("00000000-0000-4000-8000-000000000003");
const childId = asSubstreamId("00000000-0000-4000-8000-000000000004");
const address = { workspaceId, parentId };
function command(overrides: Partial<ScopeGrantMutation> = {}): ScopeGrantMutation {
  return { operationId: crypto.randomUUID(), actorUserId: userId, userId,
    target: { kind: "conversation", ...address, substreamId: childId },
    active: true, expectedRevision: 0, ...overrides };
}

function insertParentMetadata(state: DurableObjectState): void {
  state.storage.sql.exec(`INSERT OR IGNORE INTO parent_metadata
    (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
    VALUES (?,'workstream',?,'global',1,0,0)`, parentId, workspaceId);
}

/** The Organization object learns its own id, as a parent's first request teaches it. */
function learnIdentity(instance: unknown): void {
  (instance as { ensureIdentity(workspaceId: string, affinity: string): void }).ensureIdentity(workspaceId, "wnam");
}

/**
 * Each test gets its own Organization object, addressed by name as the legacy
 * tests addressed their own parent object: the file shares one storage, and
 * every parent here uses the same id.
 */
async function withStorage(name: string, run: (store: ScopeGrantStorage, state: DurableObjectState, parent: HostedParent) => void) {
  const stub = env.WORKSPACE_DOS.getByName(name);
  await runInDurableObject(stub, (instance) => learnIdentity(instance));
  await withHostedParent(stub, parentId, (parent, state) => {
    insertParentMetadata(state);
    run(parent['scopeGrants'](address), state, parent);
  });
}

/**
 * Every grant the parent published to the grant directory, in order: its own
 * record of each projection version. The directory applies each one in the
 * publishing transaction, so this is also what the directory received.
 */
function deliveries(state: DurableObjectState) {
  return state.storage.sql.exec<{ state_json: string }>(
    `SELECT state_json FROM parent_state_changes WHERE parent_id=? AND state_key LIKE 'grant:%'
      ORDER BY sequence`, parentId,
  ).toArray().map((row) => ({ grant: JSON.parse(row.state_json).grant, actorUserId: userId }));
}
/** What the Organization's grant directory holds for this person now. */
function directoryRow(state: DurableObjectState) {
  return state.storage.sql.exec<{ active: number; source_version: number }>(
    "SELECT active, source_version FROM scope_grant_directory WHERE parent_id=? AND user_id=?", parentId, userId,
  ).toArray();
}
function grantRevision(state: DurableObjectState): number {
  return state.storage.sql.exec<{ revision: number }>(
    "SELECT COALESCE(MAX(revision),0) AS revision FROM parent_grant_revision WHERE parent_id=?", parentId).one().revision;
}
function grantOperationCount(state: DurableObjectState): number {
  return state.storage.sql.exec<{ total: number }>(
    "SELECT COUNT(*) AS total FROM parent_grant_operations WHERE parent_id=?", parentId).one().total;
}

/**
 * A grant row as a Space seated it before WorkspaceDO migration 94: written
 * through the ordinary path, then marked `space` the way that path marked it.
 * No live code writes `source_kind = 'space'` any more.
 */
function seatLegacySpaceGrant(store: ScopeGrantStorage, state: DurableObjectState): void {
  if (store.mutate(command()).status !== "committed") throw new Error("Expected grant");
  state.storage.sql.exec(
    "UPDATE parent_grants SET source_kind = 'space', source_id = ? WHERE parent_id = ? AND user_id = ?",
    "00000000-0000-4000-8000-000000000005", parentId, userId,
  );
}

describe("workstream scope grants in real workerd", () => {
  it("replays revisionless participant commands without reapplying an old addition", async () => {
    await withStorage("scope-grant-participant-retry", (store, state) => {
      const add = { operationId:crypto.randomUUID(),actorUserId:userId,userId,target:command().target,active:true };
      const added = store.mutateCurrent(add);
      expect(added.status).toBe("committed");
      const removed = store.mutateCurrent({ ...add,operationId:crypto.randomUUID(),active:false });
      expect(removed.status).toBe("committed");
      expect(store.mutateCurrent(add)).toEqual(added);
      expect(store.read(userId,add.target)).toMatchObject({ active:false });
      expect(store.mutateCurrent({ ...add,active:false })).toMatchObject({ status: "conflict" });
      expect(deliveries(state)).toHaveLength(2);
    });
  });

  it("given a grant a Space seated before migration 94, when the Channel adds that reader, then the row becomes direct and is published", async () => {
    await withStorage("scope-grant-space-provenance", (store, state) => {
      const target = command().target;
      seatLegacySpaceGrant(store, state);
      expect(store.sourceKind(userId, target)).toBe("space");
      const published = deliveries(state).length;

      // Equal admission is not equal provenance: the add is the Channel taking
      // responsibility for this reader, so it writes and publishes even though
      // `active` stays true.
      expect(store.mutate(command({ active: true, expectedRevision: 1 })))
        .toMatchObject({ status: "committed", grant: { active: true, revision: 2 } });
      expect(store.sourceKind(userId, target)).toBe("direct");
      expect(deliveries(state)).toHaveLength(published + 1);
    });
  });

  // A Space no longer supplies any reader, so a reader one seated before is
  // the Channel's to remove like any other; nothing else still claims them.
  it("revokes a Space-seated grant on an ordinary removal", async () => {
    await withStorage("scope-grant-space-seated-removal", (store, state) => {
      const target = command().target;
      seatLegacySpaceGrant(store, state);
      expect(store.sourceKind(userId, target)).toBe("space");

      expect(store.mutate(command({ active: false, expectedRevision: 1 })))
        .toMatchObject({ status: "committed", grant: { active: false, revision: 2 } });
      expect(store.read(userId, target)).toMatchObject({ active: false, revision: 2 });
      expect(store.sourceKind(userId, target)).toBe("direct");
    });
  });

  it("given a migrated Channel, when a reader is added through the participant path, then the grant is direct and reaches the candidate index", async () => {
    // The whole authority, not the storage class: `mutateParticipantGrant` is
    // the method `substream-agent.ts` calls for every add on a Channel that
    // has moved to grant authority. A Space grants no reader, so every add is
    // the Channel's own and is published like a direct share.
    const readerId = asUserId("00000000-0000-4000-8000-000000000007");
    const target = { kind: "conversation" as const, ...address, substreamId: asSubstreamId("0") };
    // The relationship reads this authority makes before it decides. The
    // workerd suite's D1 starts with no schema, so the test declares them.
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam')"),
      env.DB.prepare("INSERT INTO workspaces (id) VALUES (?)").bind(workspaceId),
      env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, access_class TEXT,
        role TEXT, status TEXT, incarnation TEXT, revision INTEGER)`),
      ...[userId, readerId].map((id) => env.DB
        .prepare("INSERT INTO workspace_members VALUES (?,?,'guest',NULL,'active',?,1)")
        .bind(workspaceId, id, id)),
    ]);
    const stub = hostedParentStub(env, workspaceId);
    await runInDurableObject(stub, (instance) => learnIdentity(instance));
    await withHostedParent(stub, parentId, (parent, state) => {
      insertParentMetadata(state);
      state.storage.sql.exec("INSERT INTO parent_children (parent_id,substream_id,kind,created_at,status) VALUES (?,'0','main',0,'ready')", parentId);
      state.storage.sql.exec("INSERT INTO parent_participant_migrations(parent_id,substream_id,transfer_id,phase) VALUES (?,'0',?,'complete')", parentId, crypto.randomUUID());
      // The actor's own grant is what gives them sharing authority here.
      parent['scopeGrants'](address).mutate({ operationId: crypto.randomUUID(), actorUserId: userId,
        userId, target, active: true, expectedRevision: 0 }, userId);
    });

    expect(await stub.mutateParticipantGrant({ operationId: crypto.randomUUID(), actorUserId: userId,
      userId: readerId, target, active: true })).toMatchObject({ status: "committed" });

    await withHostedParent(stub, parentId, (parent, state) => {
      const store: ScopeGrantStorage = parent['scopeGrants'](address);
      expect(store.read(readerId, target)).toMatchObject({ active: true });
      expect(store.sourceKind(readerId, target)).toBe("direct");
      expect(deliveries(state).map((item) => item.grant.userId)).toEqual([userId, readerId]);
    });
    expect(await stub.listScopeGrantCandidates({ workspaceId, userId, membershipIncarnation: userId, accessClass: "guest" })).toEqual([parentId]);
    expect(await stub.listScopeGrantCandidates({ workspaceId, userId: readerId, membershipIncarnation: readerId, accessClass: "guest" })).toEqual([parentId]);
  });

  it("publishes combined access and does not acknowledge a newer projection with an old receipt", async () => {
    await withStorage("scope-grant-effective-projection", (store,state) => {
      state.storage.sql.exec("INSERT INTO parent_children(parent_id,substream_id,kind,created_at,audience) VALUES (?,'0','main',1,'restricted'),(?,?,'child',1,'inherits_workstream')",parentId,parentId,childId);
      store.registerParticipantProjection("0",crypto.randomUUID());
      store.registerParticipantProjection(childId,crypto.randomUUID());
      const parentTarget = { kind: "workstream" as const, ...address };
      const parentAdd = store.mutate(command({ target: parentTarget }));
      if (parentAdd.status !== "committed") throw new Error("Expected grant");
      const childAdd = store.mutate(command());
      if (childAdd.status !== "committed") throw new Error("Expected grant");
      expect(store.pendingParticipantProjection(childId,userId,childAdd.grant.revision)?.projection.active).toBe(true);
      const parentRemove = store.mutate(command({ target: parentTarget, active: false, expectedRevision: parentAdd.grant.revision }));
      if (parentRemove.status !== "committed") throw new Error("Expected revocation");
      expect(store.pendingParticipantProjection("0",userId,parentRemove.grant.revision)?.projection.active).toBe(false);
      expect(store.pendingParticipantProjection(childId,userId,parentRemove.grant.revision)?.projection.active).toBe(true);
      store.acknowledgeParticipantProjection(childId,userId,childAdd.grant.revision);
      expect(store.pendingParticipantProjection(childId,userId,parentRemove.grant.revision)).not.toBeNull();
      const childRemove = store.mutate(command({ active: false, expectedRevision: childAdd.grant.revision }));
      if (childRemove.status !== "committed") throw new Error("Expected revocation");
      expect(store.pendingParticipantProjection(childId,userId,childRemove.grant.revision)?.projection.active).toBe(false);
      store.acknowledgeParticipantProjection(childId,userId,childRemove.grant.revision);
      expect(store.pendingParticipantProjection(childId,userId)).toBeNull();
      expect(store.participantProjection(childId,userId)).toMatchObject({ revision:childRemove.grant.revision,active:false });
      expect(state.storage.sql.exec("SELECT 1 FROM _internal_durable_alarms WHERE kind=? AND alarm_key LIKE ?",
        PARTICIPANT_PROJECTION_ALARM, `${parentId}:%`).toArray()).toHaveLength(2);
    });
  });

  it("rolls back a grant if durable projection scheduling fails", async () => {
    await withStorage("scope-grant-projection-atomic", (store,state) => {
      state.storage.sql.exec("INSERT INTO parent_children(parent_id,substream_id,kind,created_at) VALUES (?,?,'child',1)",parentId,childId);
      store.registerParticipantProjection(childId,crypto.randomUUID());
      state.storage.sql.exec(`CREATE TRIGGER fail_projection_schedule BEFORE INSERT ON _internal_durable_alarms
        BEGIN SELECT RAISE(ABORT, 'projection schedule failed'); END`);
      expect(() => store.mutate(command())).toThrow("projection schedule failed");
      expect(store.forUser(userId)).toEqual([]);
      expect(deliveries(state)).toEqual([]);
      expect(state.storage.sql.exec("SELECT 1 FROM parent_participant_deliveries WHERE parent_id=?", parentId).toArray()).toEqual([]);
    });
  });

  it("imports a frozen roster once without resurrecting subsequently revoked grants", async () => {
    await withStorage("scope-grant-import-retry", (store, state) => {
      const target = command().target;
      const snapshot = { transferId: crypto.randomUUID(), participants: [
        { userId, addedByUserId: null, reason: "creator", addedAt: 1 },
      ] };
      const receipt = store.importParticipants(target, snapshot);
      expect(receipt).toEqual({ grantCount: 1, revision: 1 });
      const imported = store.read(userId, target);
      expect(imported).toMatchObject({ active: true, target });
      expect(store.read(userId, { kind: "workstream", ...address })).toBeNull();
      const revoked = store.mutate(command({ active: false, expectedRevision: receipt.revision }));
      expect(revoked.status).toBe("committed");
      expect(store.importParticipants(target, snapshot)).toEqual(receipt);
      expect(store.read(userId, target)).toMatchObject({ active: false, revision: 2 });
      expect(deliveries(state)).toHaveLength(2);
      expect(() => store.importParticipants(target, { ...snapshot, transferId: crypto.randomUUID() }))
        .toThrow("participant_import_conflict");
      expect(() => store.importParticipants(target, { ...snapshot, participants: [] }))
        .toThrow("participant_import_conflict");
    });
  });

  it("rolls back the entire import if its receipt cannot commit", async () => {
    await withStorage("scope-grant-import-rollback", (store, state) => {
      const target = { kind: "workstream" as const, ...address };
      const snapshot = { transferId: crypto.randomUUID(), participants: [
        { userId, addedByUserId: null, reason: "creator", addedAt: 1 },
        { userId: asUserId(crypto.randomUUID()), addedByUserId: userId, reason: "explicit", addedAt: 2 },
      ] };
      state.storage.sql.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON parent_grant_imports
        BEGIN SELECT RAISE(ABORT, 'import receipt failed'); END`);
      expect(() => store.importParticipants(target, snapshot)).toThrow("import receipt failed");
      expect(store.forUser(userId)).toEqual([]);
      expect(deliveries(state)).toEqual([]);
      expect(grantOperationCount(state)).toBe(0);
      expect(grantRevision(state)).toBe(0);
      state.storage.sql.exec("DROP TRIGGER fail_import");
      expect(store.importParticipants(target, snapshot)).toEqual({ grantCount: 2, revision: 2 });
      expect(deliveries(state)).toHaveLength(2);
    });
  });

  it("refuses to import over an existing grant or revocation tombstone", async () => {
    await withStorage("scope-grant-import-existing", (store) => {
      const target = command().target;
      store.mutate(command({ active: false }));
      const snapshot = { transferId: crypto.randomUUID(), participants: [
        { userId, addedByUserId: null, reason: "creator", addedAt: 1 },
      ] };
      expect(() => store.importParticipants(target, snapshot)).toThrow("participant_import_scope_not_empty");
      expect(store.read(userId, target)).toMatchObject({ active: false, revision: 1 });
    });
  });

  it("commits grant, retry receipt and delivery intent together, and retries preserve revocation", async () => {
    await withStorage("scope-grant-retry", (store, state) => {
      const add = command();
      const accepted = store.mutate(add);
      expect(accepted.status).toBe("committed");
      if (accepted.status !== "committed") throw new Error("Expected grant");
      expect(store.read(userId, add.target)).toEqual(accepted.grant);
      expect(deliveries(state)).toEqual([{ grant: accepted.grant, actorUserId: userId }]);
      expect(store.mutate(add)).toEqual(accepted);
      expect(deliveries(state)).toHaveLength(1);

      const remove = command({ active: false, expectedRevision: accepted.grant.revision });
      const removed = store.mutate(remove);
      if (removed.status !== "committed") throw new Error("Expected revocation");
      expect(removed.grant).toMatchObject({ id: accepted.grant.id, active: false });
      expect(removed.grant.revision).toBeGreaterThan(accepted.grant.revision);
      expect(store.mutate(add)).toEqual(accepted);
      expect(store.read(userId, add.target)).toEqual(removed.grant);

      // The directory holds the revocation, and the replayed addition did not
      // publish over it.
      expect(deliveries(state)).toEqual([
        { grant: accepted.grant, actorUserId: userId },
        { grant: removed.grant, actorUserId: userId },
      ]);
      expect(directoryRow(state)).toEqual([{ active: 0, source_version: 2 }]);
    });
  });

  it("refuses stale activation and binds every retry to its original command", async () => {
    await withStorage("scope-grant-conflict", (store, state) => {
      const revoke = command({ active: false });
      const result = store.mutate(revoke);
      if (result.status !== "committed") throw new Error("Expected tombstone");
      const stale = command();
      expect(store.mutate(stale)).toEqual({ status: "conflict", current: result.grant });
      expect(store.mutate({ ...revoke, active: true })).toMatchObject({ status: "conflict" });
      expect(deliveries(state)).toHaveLength(1);
      const reactivate = store.mutate(command({ expectedRevision: result.grant.revision }));
      expect(reactivate.status).toBe("committed");
      expect(store.mutate(stale)).toEqual({ status: "conflict", current: result.grant });
    });
  });

  it("rolls back the grant and revision when recording its delivery fails", async () => {
    await withStorage("scope-grant-rollback", (store, state) => {
      const add = command();
      state.storage.sql.exec(`CREATE TRIGGER fail_grant_delivery BEFORE INSERT ON scope_grant_directory
        BEGIN SELECT RAISE(ABORT, 'delivery failed'); END`);
      expect(() => store.mutate(add)).toThrow("delivery failed");
      expect(store.read(userId, add.target)).toBeNull();
      expect(grantRevision(state)).toBe(0);
      expect(grantOperationCount(state)).toBe(0);
      state.storage.sql.exec("DROP TRIGGER fail_grant_delivery");
      expect(store.mutate(add).status).toBe("committed");
      expect(deliveries(state)).toHaveLength(1);
      expect(directoryRow(state)).toEqual([{ active: 1, source_version: 1 }]);
    });
  });

  it("preserves independently granted Main, child and parent scopes after reopening storage", async () => {
    await withStorage("scope-grant-reopen", (store, state) => {
      const targets = [command().target,
        { kind: "conversation" as const, ...address, substreamId: asSubstreamId("0") },
        { kind: "workstream" as const, ...address }];
      for (const target of targets) expect(store.mutate(command({ target })).status).toBe("committed");
      const reopened = new ScopeGrantStorage(state.storage, address);
      expect(reopened.forUser(userId)).toHaveLength(3);
      expect(new Set(reopened.forUser(userId).map((grant) => grant.id)).size).toBe(3);
      expect(deliveries(state)).toHaveLength(3);
      expect(() => reopened.mutate(command({ target: { kind: "workstream", ...address, parentId: crypto.randomUUID() } })))
        .toThrow("scope_grant_parent_mismatch");
    });
  });
});
