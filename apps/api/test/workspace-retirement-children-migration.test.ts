/**
 * WorkspaceDO migration 135 adds `workspace_retirement_children`. The objects
 * it matters for are already retired at v134 with a partly receipted graph, so
 * this upgrades exactly that state against the shipped migrations: the
 * tombstone and the parent receipts survive, and the new table holds one
 * receipt per conversation however often the walk records it.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const CHILD_RECEIPTS_VERSION = 135;
const RECEIPTED_PARENT = "00000000-0000-7000-8000-000000135001";
const OPEN_PARENT = "00000000-0000-7000-8000-000000135002";
const CHILD = "00000000-0000-7000-8000-000000135011";

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

describe("WorkspaceDO migration 135", () => {
  it("upgrades a retired workspace with a partly receipted graph and keeps one receipt per conversation", () => {
    const database = openDatabase();
    apply(database, CHILD_RECEIPTS_VERSION - 1);
    database.prepare(
      `INSERT INTO object_retirement (id, retired_at, operation_id, actor_user_id, reason)
       VALUES (1, 1000, 'op-1', NULL, 'operator_retirement')`,
    ).run();
    database.prepare(
      `INSERT INTO workspace_retirement_graph (parent_kind, parent_id, recorded_at, retired_at)
       VALUES ('workstream', ?, 1000, 2000), ('space', ?, 1000, NULL)`,
    ).run(RECEIPTED_PARENT, OPEN_PARENT);

    apply(database, CHILD_RECEIPTS_VERSION, CHILD_RECEIPTS_VERSION - 1);

    expect(database.prepare("SELECT retired_at, operation_id FROM object_retirement").all())
      .toEqual([{ retired_at: 1000, operation_id: "op-1" }]);
    expect(database.prepare(
      "SELECT parent_kind, parent_id, retired_at FROM workspace_retirement_graph ORDER BY parent_id",
    ).all()).toEqual([
      { parent_kind: "workstream", parent_id: RECEIPTED_PARENT, retired_at: 2000 },
      { parent_kind: "space", parent_id: OPEN_PARENT, retired_at: null },
    ]);

    // The statement `recordRetiredChild` runs, twice, as a replayed pass would.
    const record = database.prepare(
      `INSERT OR IGNORE INTO workspace_retirement_children (parent_id, substream_id, retired_at)
       VALUES (?, ?, ?)`,
    );
    record.run(OPEN_PARENT, CHILD, 3000);
    record.run(OPEN_PARENT, CHILD, 4000);
    expect(database.prepare(
      "SELECT parent_id, substream_id, retired_at FROM workspace_retirement_children",
    ).all()).toEqual([{ parent_id: OPEN_PARENT, substream_id: CHILD, retired_at: 3000 }]);
  });
});
