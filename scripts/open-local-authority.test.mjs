import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { workspaceProductAuthorityRouteUpsertSql } from "./open-local-authority-sql.mjs";

test("workspace authority upsert executes through SQLite and updates an existing route", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE workspace_product_authority_routes (
      workspace_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      stage_index INTEGER NOT NULL,
      source_cursor INTEGER NOT NULL,
      row_counts_json TEXT NOT NULL,
      last_error_code TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO workspaces(id) VALUES ('workspace-one');
  `);
  try {
    database.exec(workspaceProductAuthorityRouteUpsertSql(2));
    database.exec("UPDATE workspace_product_authority_routes SET state = 'verified', stage_index = 4");
    database.exec(workspaceProductAuthorityRouteUpsertSql(3));
    assert.deepEqual(
      { ...database.prepare(`SELECT workspace_id, generation, state, stage_index
                               FROM workspace_product_authority_routes`).get() },
      { workspace_id: "workspace-one", generation: 3, state: "pending", stage_index: 0 },
    );
  } finally {
    database.close();
  }
});
