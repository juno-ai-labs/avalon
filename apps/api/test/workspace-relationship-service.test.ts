import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { databaseThroughMigration } from "./helpers/migrated-schema";
import { ensureGuestRelationship, promoteWorkspaceGuest, readWorkspaceRelationship } from "../src/services/workspace-relationship-service";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const guestId = "00000000-0000-4000-8000-000000000003";
const opened: DatabaseSync[] = [];
function fixture(db = migratedSqliteDatabase()) {
  opened.push(db);
  for (const id of [ownerId, guestId]) db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?,?,'User','now','now')").run(id, `${id}@example.com`);
  db.prepare("INSERT INTO workspaces (id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,'Workspace','test','global',?,'now','now')").run(workspaceId,ownerId);
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,status,joined_at) VALUES (?,?,'owner','active','now')").run(workspaceId,ownerId);
  return { db, binding: sqliteD1(db) };
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe("workspace guest relationships", () => {
  it("binds existing sessions to their current membership and rebinds only when selecting a different workspace", () => {
    const { db } = fixture(databaseThroughMigration("0109_workspace_guest_relationships.sql"));
    db.prepare("INSERT INTO sessions (id,user_id,workspace_id,region,refresh_token_hash,expires_at,created_at) VALUES ('existing',?,?,'global','hash','later','now')")
      .run(ownerId,workspaceId);
    db.exec(readFileSync(new URL("../../../packages/db/migrations/0110_session_workspace_incarnations.sql",import.meta.url),"utf8"));
    const member = db.prepare("SELECT incarnation FROM workspace_members WHERE workspace_id=? AND user_id=?").get(workspaceId,ownerId)!;
    const binding = () => db.prepare("SELECT workspace_incarnation FROM sessions WHERE id='existing'").get();
    expect(binding()).toEqual({ workspace_incarnation:member.incarnation });
    db.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").run(workspaceId,ownerId);
    db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,status) VALUES (?,?,'owner','active')").run(workspaceId,ownerId);
    db.prepare("UPDATE sessions SET workspace_id=? WHERE id='existing'").run(workspaceId);
    expect(binding()).toEqual({ workspace_incarnation:member.incarnation });
    db.exec("UPDATE sessions SET workspace_id=NULL WHERE id='existing'");
    expect(binding()).toEqual({ workspace_incarnation:null });
    db.prepare("UPDATE sessions SET workspace_id=? WHERE id='existing'").run(workspaceId);
    const replacement = db.prepare("SELECT incarnation FROM workspace_members WHERE workspace_id=? AND user_id=?").get(workspaceId,ownerId)!;
    expect(binding()).toEqual({ workspace_incarnation:replacement.incarnation });
    expect(replacement.incarnation).not.toBe(member.incarnation);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("upgrades existing memberships without changing their role, status or activity", async () => {
    const { db, binding } = fixture(databaseThroughMigration("0108_email_login_identities.sql"));
    db.prepare("UPDATE workspace_members SET last_seen_at='last-seen' WHERE user_id=?").run(ownerId);
    const before = db.prepare("SELECT * FROM workspace_members").all();
    db.exec("BEGIN");
    db.exec(readFileSync(new URL("../../../packages/db/migrations/0109_workspace_guest_relationships.sql", import.meta.url), "utf8"));
    db.exec("COMMIT");
    expect(db.prepare("SELECT workspace_id,user_id,role,status,joined_at,last_seen_at FROM workspace_members").all()).toEqual(before);
    expect(await readWorkspaceRelationship(binding, workspaceId, ownerId))
      .toMatchObject({ accessClass: "member", role: "owner", revision: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("uses the normal ledger, never demotes a member or reactivates a suspended guest", async () => {
    const { db, binding } = fixture();
    const guest = await ensureGuestRelationship(binding, workspaceId, guestId);
    expect(guest).toMatchObject({ userId: guestId, accessClass: "guest", role: null, status: "active" });
    expect(await ensureGuestRelationship(binding, workspaceId, guestId)).toEqual(guest);
    expect(await ensureGuestRelationship(binding, workspaceId, ownerId)).toMatchObject({ accessClass: "member", role: "owner" });
    db.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").run(guestId);
    expect(await ensureGuestRelationship(binding, workspaceId, guestId))
      .toMatchObject({ status: "suspended", revision: guest.revision + 1 });
    expect(() => db.prepare("UPDATE workspace_members SET role='admin' WHERE user_id=?").run(guestId)).toThrow();
  });

  it("promotes only through a current administrator and preserves identity, incarnation and sessions", async () => {
    const { db, binding } = fixture();
    const guest = await ensureGuestRelationship(binding, workspaceId, guestId);
    db.prepare("INSERT INTO sessions (id,user_id,workspace_id,region,refresh_token_hash,expires_at,created_at) VALUES ('session',?,?,'global','hash','later','now')").run(guestId,workspaceId);
    const input = { workspaceId, userId: guestId, actorUserId: guestId, incarnation: guest.incarnation, expectedRevision: guest.revision };
    expect(await promoteWorkspaceGuest(binding, input)).toEqual({ status: "not_applied" });
    expect(await promoteWorkspaceGuest(binding, { ...input, actorUserId: ownerId, expectedRevision: guest.revision + 1 })).toEqual({ status: "not_applied" });
    const result = await promoteWorkspaceGuest(binding, { ...input, actorUserId: ownerId });
    expect(result).toMatchObject({ status: "promoted", relationship: {
      userId: guestId, incarnation: guest.incarnation, accessClass: "member", role: "member", revision: guest.revision + 1,
    } });
    expect(db.prepare("SELECT user_id FROM sessions WHERE id='session'").get()).toEqual({ user_id: guestId });
    expect(db.prepare("SELECT access_class,role,revision FROM workspace_relationship_deliveries WHERE user_id=? ORDER BY sequence DESC LIMIT 1").get(guestId))
      .toEqual({ access_class: "member", role: "member", revision: guest.revision + 1 });
  });

  it("records removal durably and fences commands from the prior membership incarnation", async () => {
    const { db, binding } = fixture();
    const old = await ensureGuestRelationship(binding, workspaceId, guestId);
    db.prepare("DELETE FROM workspace_members WHERE user_id=?").run(guestId);
    const replacement = await ensureGuestRelationship(binding, workspaceId, guestId);
    expect(replacement.incarnation).not.toBe(old.incarnation);
    expect(await promoteWorkspaceGuest(binding, { workspaceId, userId: guestId, actorUserId: ownerId,
      incarnation: old.incarnation, expectedRevision: old.revision })).toEqual({ status: "not_applied" });
    expect(db.prepare("SELECT incarnation,revision FROM workspace_relationship_deliveries WHERE user_id=? AND change_kind='removed'").get(guestId))
      .toEqual({ incarnation: old.incarnation, revision: old.revision + 1 });
  });

  it("couples legacy admission changes to delivery while ignoring activity touches", async () => {
    const { db, binding } = fixture();
    const guest = await ensureGuestRelationship(binding, workspaceId, guestId);
    db.prepare("UPDATE workspace_members SET last_seen_at='later' WHERE user_id=?").run(guestId);
    expect((await readWorkspaceRelationship(binding, workspaceId, guestId))?.revision).toBe(guest.revision);
    expect(db.prepare("SELECT COUNT(*) AS total FROM workspace_relationship_deliveries WHERE user_id=?").get(guestId)).toEqual({ total: 1 });
    db.exec(`CREATE TRIGGER fail_relationship_delivery BEFORE INSERT ON workspace_relationship_deliveries
      BEGIN SELECT RAISE(ABORT, 'delivery failed'); END`);
    expect(() => db.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").run(guestId)).toThrow("delivery failed");
    expect(await readWorkspaceRelationship(binding, workspaceId, guestId)).toEqual(guest);
    db.exec("DROP TRIGGER fail_relationship_delivery");
    db.prepare("UPDATE workspace_members SET status='suspended' WHERE user_id=?").run(guestId);
    expect(db.prepare("SELECT revision,status FROM workspace_relationship_deliveries WHERE user_id=? ORDER BY sequence DESC LIMIT 1").get(guestId))
      .toEqual({ revision: guest.revision + 1, status: "suspended" });
  });
});
