/**
 * D1 migration 0125 drops the removed demo feature's three tables. A drop
 * that missed one would leave a shell a stale query succeeds against; one
 * that cascaded would take the users or workspaces the demo rows referenced.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { databaseThroughMigration } from "./helpers/migrated-schema";

const NOW = "2026-11-08T12:00:00.000Z";
const openDatabases: DatabaseSync[] = [];

const tables = (database: DatabaseSync): string[] =>
  (database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'demo_%' ORDER BY name`).all() as { name: string }[])
    .map((row) => row.name);

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("D1 migration 0125", () => {
  it("drops every demo table and keeps the users and workspace the demo rows referenced", () => {
    const database = databaseThroughMigration("0124_sidekick_delegation_locations.sql");
    openDatabases.push(database);
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('presenter', 'google-presenter', 'maya@example.test', 'Maya', '${NOW}', '${NOW}'),
             ('persona', NULL, 'op.theo@persona.invalid', 'Theo', '${NOW}', '${NOW}');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('demo-workspace', 'Alto Capital', 'alto-capital', 'global', 'presenter', '${NOW}', '${NOW}');
      INSERT INTO demo_operations (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
        status, attempt, ready_at, created_at, updated_at)
      VALUES ('op', 'Alto Capital', 'presenter', 'v1', '{}', 'demo-workspace', 'ready', 1, '${NOW}', '${NOW}', '${NOW}');
      INSERT INTO demo_operation_phases (operation_id, phase, status, attempt, started_at)
      VALUES ('op', 'creating_workspace', 'completed', 1, '${NOW}');
      INSERT INTO demo_seed_receipts (operation_id, action_id, workspace_id, kind, room, workstream_id, substream_id, completed_at)
      VALUES ('op', 'q4', 'demo-workspace', 'create_workstream', 'q4', 'stream-q4', '0', '${NOW}');
    `);
    expect(tables(database)).toEqual(["demo_operation_phases", "demo_operations", "demo_seed_receipts"]);

    database.exec(readFileSync(new URL("../../../packages/db/migrations/0125_drop_demo_tables.sql", import.meta.url), "utf8"));

    expect(tables(database)).toEqual([]);
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'demo_%'`).all()).toEqual([]);
    expect(database.prepare(`SELECT id FROM users ORDER BY id`).all()).toEqual([{ id: "persona" }, { id: "presenter" }]);
    expect(database.prepare(`SELECT id FROM workspaces`).all()).toEqual([{ id: "demo-workspace" }]);
    expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });
});
