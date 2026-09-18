/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";
import type { ScopeGrantMutation } from "@rally/contracts/scope-grants";
import { ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";

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

async function withStorage(name: string, run: (store: ScopeGrantStorage, state: DurableObjectState) => void) {
  const stub = env.WORKSTREAM_DOS.getByName(name);
  await stub.authority(address);
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
      component: "workstream_do", workerVersionId: "scope-grant-test" });
    state.storage.sql.exec(`INSERT OR IGNORE INTO workstream_metadata
      (id,workspace_id,workstream_id,region,authority_generation,title,description,preview,scope,exact_state,last_activity_at,created_at,updated_at)
      VALUES (1,?,?,'global',1,'Parent','','','personal','idle',0,0,0)`,workspaceId,parentId);
    run(_instance['scopeGrants'](address), state);
  });
}

function deliveries(state: DurableObjectState) {
  return state.storage.sql.exec<{ payload_json: string }>(
    "SELECT payload_json FROM durable_outbox WHERE effect_kind='scope_grant_directory' ORDER BY source_version,created_at,message_id",
  ).toArray().map((row) => ({ grant: JSON.parse(row.payload_json).effect.grant, actorUserId: userId }));
}
function acknowledge(state: DurableObjectState, revision: number): void {
  state.storage.sql.exec("DELETE FROM durable_outbox WHERE effect_kind='scope_grant_directory' AND json_extract(payload_json,'$.effect.grant.revision')=?", revision);
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
      expect(() => store.mutateCurrent({ ...add,active:false })).toThrow("scope_grant_operation_reused");
      expect(deliveries(state)).toHaveLength(2);
    });
  });

  it("publishes combined access and does not acknowledge a newer projection with an old receipt", async () => {
    await withStorage("scope-grant-effective-projection", (store,state) => {
      state.storage.sql.exec("INSERT INTO conversation_children(substream_id,kind,created_at,audience) VALUES ('0','main',1,'restricted'),(?,'child',1,'inherits_workstream')",childId);
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
      expect(state.storage.sql.exec("SELECT 1 FROM _internal_durable_alarms WHERE kind='participant_projection'").toArray()).toHaveLength(2);
    });
  });

  it("rolls back a grant if durable projection scheduling fails", async () => {
    await withStorage("scope-grant-projection-atomic", (store,state) => {
      state.storage.sql.exec("INSERT INTO conversation_children(substream_id,kind,created_at) VALUES (?,'child',1)",childId);
      store.registerParticipantProjection(childId,crypto.randomUUID());
      state.storage.sql.exec(`CREATE TRIGGER fail_projection_schedule BEFORE INSERT ON _internal_durable_alarms
        BEGIN SELECT RAISE(ABORT, 'projection schedule failed'); END`);
      expect(() => store.mutate(command())).toThrow("projection schedule failed");
      expect(store.forUser(userId)).toEqual([]);
      expect(deliveries(state)).toEqual([]);
      expect(state.storage.sql.exec("SELECT 1 FROM participant_projection_deliveries").toArray()).toEqual([]);
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
      state.storage.sql.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON scope_grant_imports
        BEGIN SELECT RAISE(ABORT, 'import receipt failed'); END`);
      expect(() => store.importParticipants(target, snapshot)).toThrow("import receipt failed");
      expect(store.forUser(userId)).toEqual([]);
      expect(deliveries(state)).toEqual([]);
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM scope_grant_operations").one().total).toBe(0);
      expect(state.storage.sql.exec<{ revision: number }>("SELECT revision FROM scope_grant_revision").one().revision).toBe(0);
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

      acknowledge(state, accepted.grant.revision);
      expect(deliveries(state)).toEqual([{ grant: removed.grant, actorUserId: userId }]);
      acknowledge(state, accepted.grant.revision);
      expect(deliveries(state)).toHaveLength(1);
    });
  });

  it("refuses stale activation and binds every retry to its original command", async () => {
    await withStorage("scope-grant-conflict", (store, state) => {
      const revoke = command({ active: false });
      const result = store.mutate(revoke);
      if (result.status !== "committed") throw new Error("Expected tombstone");
      const stale = command();
      expect(store.mutate(stale)).toEqual({ status: "conflict", current: result.grant });
      expect(() => store.mutate({ ...revoke, active: true })).toThrow("scope_grant_operation_reused");
      expect(deliveries(state)).toHaveLength(1);
      const reactivate = store.mutate(command({ expectedRevision: result.grant.revision }));
      expect(reactivate.status).toBe("committed");
      expect(store.mutate(stale)).toEqual({ status: "conflict", current: result.grant });
    });
  });

  it("rolls back the grant and revision when recording its delivery fails", async () => {
    await withStorage("scope-grant-rollback", (store, state) => {
      const add = command();
      state.storage.sql.exec(`CREATE TRIGGER fail_grant_delivery BEFORE INSERT ON durable_outbox
        BEGIN SELECT RAISE(ABORT, 'delivery failed'); END`);
      expect(() => store.mutate(add)).toThrow("delivery failed");
      expect(store.read(userId, add.target)).toBeNull();
      expect(state.storage.sql.exec<{ revision: number }>("SELECT revision FROM scope_grant_revision").one().revision).toBe(0);
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM scope_grant_operations").one().total).toBe(0);
      state.storage.sql.exec("DROP TRIGGER fail_grant_delivery");
      expect(store.mutate(add).status).toBe("committed");
      expect(deliveries(state)).toHaveLength(1);
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

  it("moves pending legacy discovery into the parent outbox atomically", async () => {
    const stub = env.WORKSTREAM_DOS.getByName("scope-grant-legacy-outbox");
    await stub.authority(address);
    await runInDurableObject(stub, (instance, state) => {
      state.storage.sql.exec(`INSERT INTO workstream_metadata
        (id,workspace_id,workstream_id,region,authority_generation,title,description,preview,scope,exact_state,last_activity_at,created_at,updated_at)
        VALUES (1,?,?,'global',1,'Parent','','','personal','idle',0,0,0)`, workspaceId, parentId);
      const grant = { id: crypto.randomUUID(), userId, target: command().target, active: true, revision: 1, membershipIncarnation: null };
      state.storage.sql.exec("INSERT INTO scope_grant_deliveries(revision,grant_json,actor_user_id,created_at) VALUES (1,?,?,1)", JSON.stringify(grant), userId);
      state.storage.sql.exec(`CREATE TRIGGER fail_legacy_outbox BEFORE INSERT ON durable_outbox
        BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`);
      expect(() => state.storage.transactionSync(() => instance['retireGrantDirectoryDeliveries']())).toThrow('outbox unavailable');
      expect(state.storage.sql.exec("SELECT revision FROM scope_grant_deliveries").toArray()).toHaveLength(1);
      state.storage.sql.exec("DROP TRIGGER fail_legacy_outbox");
      state.storage.transactionSync(() => instance['retireGrantDirectoryDeliveries']());
      expect(deliveries(state).map((item) => item.grant)).toEqual([grant]);
      expect(state.storage.sql.exec("SELECT revision FROM scope_grant_deliveries").toArray()).toEqual([]);
    });
  });

  it("upgrades populated v13 without changing existing private child audiences or roster", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("scope-grant-upgrade");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 13),
        component: "workstream_do", workerVersionId: "v13" });
      state.storage.sql.exec("INSERT INTO conversation_children (substream_id, kind, created_at) VALUES (?, 'child', 1)", childId);
      state.storage.sql.exec(`INSERT INTO private_child_memberships
        (substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
        VALUES (?, ?, 1, 7, ?, 1, 1)`, childId, userId, userId);
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
        component: "workstream_do", workerVersionId: "v14" });
      expect(state.storage.sql.exec<{ audience: string }>("SELECT audience FROM conversation_children WHERE substream_id = ?", childId).one().audience)
        .toBe("restricted");
      expect(state.storage.sql.exec<{ version: number; active: number }>("SELECT version, active FROM private_child_memberships WHERE user_id = ?", userId).one())
        .toEqual({ version: 7, active: 1 });
      expect(new ScopeGrantStorage(state.storage, address).forUser(userId)).toEqual([]);
    });
  });
});
