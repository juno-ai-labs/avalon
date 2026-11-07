/**
 * WorkspaceDO migration 146 copies `workspace_retirement_graph` so its CHECK
 * admits a Canvas. A copy that dropped a node or its receipt would let an
 * interrupted retirement report the Organization closed, or reopen a node
 * already closed.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 146;
const openDatabases: DatabaseSync[] = [];

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

const insertNode = (database: DatabaseSync, kind: string, id: string, retiredAt: number | null) => database.prepare(
  `INSERT INTO workspace_retirement_graph (parent_kind, parent_id, recorded_at, retired_at) VALUES (?, ?, 10, ?)`,
).run(kind, id, retiredAt);

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 146", () => {
  it("keeps every recorded node and its receipt, and admits a Canvas", () => {
    const database = new DatabaseSync(":memory:");
    openDatabases.push(database);
    apply(database, VERSION - 1);
    insertNode(database, "workstream", "thread-one", 20);
    insertNode(database, "automation", "sidekick-one", null);
    insertNode(database, "space", "channel-one", null);
    expect(() => insertNode(database, "canvas", "canvas-early", null)).toThrow(/CHECK constraint failed/u);

    apply(database, VERSION, VERSION - 1);

    expect(database.prepare(`SELECT parent_kind, parent_id, recorded_at, retired_at FROM workspace_retirement_graph
      ORDER BY parent_kind, parent_id`).all()).toEqual([
      { parent_kind: "automation", parent_id: "sidekick-one", recorded_at: 10, retired_at: null },
      { parent_kind: "space", parent_id: "channel-one", recorded_at: 10, retired_at: null },
      { parent_kind: "workstream", parent_id: "thread-one", recorded_at: 10, retired_at: 20 },
    ]);
    insertNode(database, "canvas", "canvas-one", null);
    expect(() => insertNode(database, "canvas", "canvas-one", null)).toThrow(/UNIQUE constraint failed/u);
    expect(() => insertNode(database, "thread", "unknown-kind", null)).toThrow(/CHECK constraint failed/u);
  });
});
