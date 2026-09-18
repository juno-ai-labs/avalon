/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asUserId } from "@rally/contracts";
import { ParticipantAuthorityTransferStorage, type ParticipantProjection } from "../src/durable-objects/participant-authority-transfer";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";

const userId = "00000000-0000-4000-8000-000000000001";
const removedId = "00000000-0000-4000-8000-000000000002";
const transferId = "00000000-0000-4000-8000-000000000003";
function projection(overrides: Partial<ParticipantProjection> = {}): ParticipantProjection {
  return { transferId, userId: asUserId(userId), revision: 1, active: false,
    reason: "explicit", addedByUserId: null, changedAt: 40, ...overrides };
}
function migrate(state: DurableObjectState, version: number) {
  applyDurableObjectSqliteMigrations({ storage: state.storage,
    migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((entry) => entry.version <= version),
    component: "substream_agent", workerVersionId: "participant-transfer-test" });
}
async function withStorage(name: string, run: (state: DurableObjectState) => void) {
  const stub = env.MIGRATION_PROBE_DO!.getByName(name);
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    migrate(state, 61);
    state.storage.sql.exec(`INSERT INTO participants
      (user_id,participation_reason,status,participant_epoch,added_at,removed_at,updated_at)
      VALUES (?,'creator','active',1,10,NULL,10),(?,'explicit','removed',2,20,30,30)`, userId, removedId);
    migrate(state, 62);
    run(state);
  });
}

describe("participant authority handoff in real workerd", () => {
  it("applies ordered access transitions while rejecting stale and conflicting deliveries", async () => {
    await withStorage("participant-projection-order", (state) => {
      const store = new ParticipantAuthorityTransferStorage(state.storage);
      const removed = projection();
      expect(store.applyProjection(removed)).toEqual({ status: "not_ready" });
      store.prepare(transferId);
      expect(store.applyProjection(removed)).toEqual({ status: "not_ready" });
      store.commit(transferId);
      expect(store.applyProjection({ ...removed, transferId: crypto.randomUUID() })).toEqual({ status: "conflict" });
      expect(store.applyProjection(removed)).toEqual({ status: "applied" });
      const read = () => state.storage.sql.exec("SELECT status,participant_epoch,first_opened_at FROM participants WHERE user_id=?", userId).one();
      expect(read()).toMatchObject({ status: "removed", participant_epoch: 2 });
      expect(store.applyProjection(removed)).toEqual({ status: "unchanged" });
      expect(store.applyProjection({ ...removed, active: true })).toEqual({ status: "conflict" });
      expect(read().status).toBe("removed");
      const active = projection({ revision: 3, active: true, changedAt: 50 });
      expect(store.applyProjection(active)).toEqual({ status: "applied" });
      expect(read()).toEqual({ status: "active", participant_epoch: 3, first_opened_at: null });
      expect(store.applyProjection(projection({ revision: 2 }))).toEqual({ status: "stale" });
      state.storage.sql.exec("UPDATE participants SET first_opened_at=60 WHERE user_id=?", userId);
      expect(store.applyProjection({ ...active, revision: 4 })).toEqual({ status: "applied" });
      expect(read()).toEqual({ status: "active", participant_epoch: 3, first_opened_at: 60 });
      expect(() => state.storage.sql.exec("DELETE FROM participants WHERE user_id=?", userId)).toThrow("participant_authority_transferred");
    });
  });

  it("retains revocation tombstones even for users never admitted locally", async () => {
    await withStorage("participant-projection-tombstone", (state) => {
      const store = new ParticipantAuthorityTransferStorage(state.storage);
      store.prepare(transferId);
      store.commit(transferId);
      const absentUser = asUserId(crypto.randomUUID());
      expect(store.applyProjection(projection({ userId: absentUser, revision: 5 }))).toEqual({ status: "applied" });
      expect(store.applyProjection(projection({ userId: absentUser, revision: 4, active: true }))).toEqual({ status: "stale" });
      expect(state.storage.sql.exec("SELECT 1 FROM participants WHERE user_id=?", absentUser).toArray()).toEqual([]);
      expect(store.applyProjection(projection({ userId: absentUser, revision: 6, active: true }))).toEqual({ status: "applied" });
      expect(state.storage.sql.exec("SELECT status,participant_epoch FROM participants WHERE user_id=?", absentUser).one())
        .toEqual({ status: "active", participant_epoch: 0 });
    });
  });

  it("rolls back roster changes and the write permission when recording a revision fails", async () => {
    await withStorage("participant-projection-rollback", (state) => {
      const store = new ParticipantAuthorityTransferStorage(state.storage);
      store.prepare(transferId);
      store.commit(transferId);
      state.storage.sql.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON participant_projection_revisions
        BEGIN SELECT RAISE(ABORT, 'projection receipt failed'); END`);
      expect(() => store.applyProjection(projection())).toThrow("projection receipt failed");
      expect(state.storage.sql.exec("SELECT status,participant_epoch FROM participants WHERE user_id=?", userId).one())
        .toEqual({ status: "active", participant_epoch: 1 });
      expect(state.storage.sql.exec("SELECT projection_write FROM participant_authority_transfer").one().projection_write).toBe(0);
      expect(() => state.storage.sql.exec("DELETE FROM participants WHERE user_id=?", userId)).toThrow("participant_authority_transferred");
      state.storage.sql.exec("DROP TRIGGER fail_projection");
      expect(store.applyProjection(projection())).toEqual({ status: "applied" });
    });
  });

  it("preserves a populated roster and freezes an immutable active-only snapshot", async () => {
    await withStorage("participant-transfer-snapshot", (state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE participants SET added_at=11 WHERE user_id=?", userId);
      expect(sql.exec("SELECT user_id FROM participants").toArray()).toHaveLength(2);
      const store = new ParticipantAuthorityTransferStorage(state.storage);
      const snapshot = store.prepare(transferId);
      expect(snapshot).toEqual({ transferId, participants: [
        { userId, addedByUserId: null, reason: "creator", addedAt: 11 },
      ] });
      expect(new ParticipantAuthorityTransferStorage(state.storage).prepare(transferId)).toEqual(snapshot);
      expect(() => store.prepare(crypto.randomUUID())).toThrow("participant_transfer_conflict");
      expect(() => sql.exec("DELETE FROM participants WHERE user_id=?", userId)).toThrow("participant_authority_transferred");
      expect(() => sql.exec("UPDATE participants SET status='removed',removed_at=40 WHERE user_id=?", userId))
        .toThrow("participant_authority_transferred");
      expect(() => sql.exec(`INSERT INTO participants
        (user_id,participation_reason,status,participant_epoch,added_at,updated_at)
        VALUES (?,'explicit','active',1,40,40)`, crypto.randomUUID())).toThrow("participant_authority_transferred");
      sql.exec("UPDATE participants SET first_opened_at=50 WHERE user_id=?", userId);
      expect(sql.exec<{ first_opened_at: number }>("SELECT first_opened_at FROM participants WHERE user_id=?", userId).one().first_opened_at).toBe(50);
      expect(store.prepare(transferId)).toEqual(snapshot);
    });
  });

  it("keeps legacy admission closed after commit and makes commit retries idempotent", async () => {
    await withStorage("participant-transfer-commit", (state) => {
      const store = new ParticipantAuthorityTransferStorage(state.storage);
      expect(() => store.commit(transferId)).toThrow("participant_transfer_conflict");
      store.prepare(transferId);
      expect(() => store.commit(crypto.randomUUID())).toThrow("participant_transfer_conflict");
      store.commit(transferId);
      const committed = state.storage.sql.exec("SELECT phase,committed_at FROM participant_authority_transfer").one();
      expect(committed.phase).toBe("projection");
      expect(committed.committed_at).toEqual(expect.any(Number));
      store.commit(transferId);
      expect(state.storage.sql.exec("SELECT phase,committed_at FROM participant_authority_transfer").one()).toEqual(committed);
      expect(() => state.storage.sql.exec("UPDATE participants SET status='active',removed_at=NULL WHERE user_id=?", removedId))
        .toThrow("participant_authority_transferred");
    });
  });
});
