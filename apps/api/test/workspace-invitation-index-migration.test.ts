/**
 * WorkspaceDO migration 93 schedules one alarm per parent that holds a share
 * still pending, so shares made before `scope_share_recipients` existed get
 * lookup rows written once, on the object's own retried schedule.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const INDEX_MIGRATION_VERSION = 93;
const openDatabases: DatabaseSync[] = [];

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

function invitation(database: DatabaseSync, parentId: string, id: string, status: string): void {
  database.prepare(`INSERT OR IGNORE INTO parent_invitation_operations (parent_id, operation_id, request_json, invitation_ids_json)
    VALUES (?, 'operation', '{}', '[]')`).run(parentId);
  database.prepare(`INSERT INTO parent_invitations
      (parent_id, id, operation_id, actor_user_id, actor_incarnation, summary_json, token_hash, delivery_encrypted,
       grant_operations_json, created_at)
    VALUES (?, ?, 'operation', 'actor', 'incarnation', ?, ?, '{}', '[]', 0)`)
    .run(parentId, id, JSON.stringify({ status }), `${parentId}:${id}`);
}

it("schedules one index alarm per parent with a pending share, and none for settled ones", () => {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  apply(database, INDEX_MIGRATION_VERSION - 1);
  invitation(database, "parent-a", "one", "pending");
  invitation(database, "parent-a", "two", "pending");
  invitation(database, "parent-b", "three", "accepted");
  invitation(database, "parent-c", "four", "revoked");
  invitation(database, "parent-d", "five", "pending");
  apply(database, INDEX_MIGRATION_VERSION, INDEX_MIGRATION_VERSION - 1);
  expect(database.prepare(`SELECT kind, alarm_key FROM _internal_durable_alarms
      WHERE kind = 'parent_invitation_index' ORDER BY alarm_key`).all())
    .toEqual([{ kind: "parent_invitation_index", alarm_key: "parent-a" }, { kind: "parent_invitation_index", alarm_key: "parent-d" }]);
});
