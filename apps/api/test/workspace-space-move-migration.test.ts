/**
 * WorkspaceDO migration 68 adds the source-side fences a durable move must
 * resume with. It rebuilds `space_intents`, so this test proves old unsettled
 * work survives while the new row shape refuses incomplete move intents.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const MOVE_MIGRATION_VERSION = 68;
const SOURCE_SPACE_ID = "00000000-0000-7000-8000-0000000000f1";
const TARGET_SPACE_ID = "00000000-0000-7000-8000-0000000000f2";
const CHANNEL_ID = "00000000-0000-7000-8000-0000000000f3";
const USER_ID = "00000000-0000-7000-8000-0000000000f4";

const openDatabases: DatabaseSync[] = [];

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

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

describe("WorkspaceDO migration 68", () => {
  it("preserves existing intents and requires all source fences for a move", () => {
    const database = openDatabase();
    apply(database, MOVE_MIGRATION_VERSION - 1);
    database.prepare(
      `INSERT INTO space_intents (
         operation_id, kind, space_id, workstream_id, space_revision,
         membership_generation, delivery_generation, state, cursor, last_error_code,
         receipts_json, requested_by_user_id, not_before, attempts, created_at, updated_at
       ) VALUES ('old-add', 'add', ?, ?, 2, 3, NULL, 'pending', NULL, NULL, '[]', ?, 4, 0, 1, 1)`,
    ).run(TARGET_SPACE_ID, CHANNEL_ID, USER_ID);

    apply(database, MOVE_MIGRATION_VERSION, MOVE_MIGRATION_VERSION - 1);

    expect(database.prepare(
      `SELECT operation_id, kind, source_space_id, source_space_revision,
              source_membership_generation FROM space_intents`,
    ).all()).toEqual([{
      operation_id: "old-add",
      kind: "add",
      source_space_id: null,
      source_space_revision: null,
      source_membership_generation: null,
    }]);

    const insertMove = database.prepare(
      `INSERT INTO space_intents (
         operation_id, kind, space_id, workstream_id, space_revision,
         membership_generation, source_space_id, source_space_revision,
         source_membership_generation, delivery_generation, state, cursor,
         last_error_code, receipts_json, requested_by_user_id, not_before,
         attempts, created_at, updated_at
       ) VALUES (?, 'move', ?, ?, 6, 2, ?, ?, ?, NULL, 'pending', NULL, NULL, '[]', ?, 4, 0, 1, 1)`,
    );
    expect(() => insertMove.run(
      "complete-move", TARGET_SPACE_ID, CHANNEL_ID, SOURCE_SPACE_ID, 5, 3, USER_ID,
    )).not.toThrow();
    expect(() => insertMove.run(
      "missing-source-fence", TARGET_SPACE_ID, CHANNEL_ID, null, null, null, USER_ID,
    )).toThrow(/CHECK constraint failed/u);
  });
});
