/**
 * WorkspaceDO migration 66 deliberately does not guess which Space owns a
 * legacy Organization-wide pin. A Channel may belong to several Spaces, so
 * copying that row would silently pin every placement (or choose one without
 * authority). The cutover drops the old table and recreates it with Space in
 * the key, leaving every person with an empty pin set.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const PIN_MIGRATION_VERSION = 66;
const CHANNEL_ID = "00000000-0000-7000-8000-0000000000e1";
const USER_ID = "00000000-0000-7000-8000-0000000000e2";

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

describe("WorkspaceDO migration 66", () => {
  it("clears legacy pins while making Space part of pin identity", () => {
    const database = openDatabase();
    apply(database, PIN_MIGRATION_VERSION - 1);
    database.prepare(
      `INSERT INTO workspace_workstream_directory (
         workstream_id, authority_generation, waterline, source_event_id, payload_hash,
         title, description, preview, scope, exact_state, system_kind, last_activity_at,
         completed_at, archived_at, email_address, origin_type, origin_label,
         created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
         title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
         next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
         source_created_at, source_updated_at, projected_at)
       VALUES (?, 1, 1, 'event', 'hash', 'Channel', '', '', 'workspace', 'idle', NULL, 1,
               NULL, NULL, NULL, 'ad_hoc', NULL, NULL, NULL, NULL, NULL,
               'settled', 0, 0, NULL, NULL, NULL, 1, 1, 1)`,
    ).run(CHANNEL_ID);
    database.prepare(
      `INSERT INTO workspace_workstream_pins
         (user_id, workstream_id, position, created_at, updated_at)
       VALUES (?, ?, 0, 1, 1)`,
    ).run(USER_ID, CHANNEL_ID);

    apply(database, PIN_MIGRATION_VERSION, PIN_MIGRATION_VERSION - 1);

    expect(database.prepare("SELECT COUNT(*) AS count FROM workspace_workstream_pins").get())
      .toEqual({ count: 0 });
    expect(database.prepare("PRAGMA table_info(workspace_workstream_pins)").all()
      .map((column) => (column as { name: string }).name))
      .toEqual(["user_id", "space_id", "workstream_id", "position", "created_at", "updated_at"]);
    expect(database.prepare("PRAGMA index_info(sqlite_autoindex_workspace_workstream_pins_1)").all()
      .map((column) => (column as { name: string }).name))
      .toEqual(["user_id", "space_id", "workstream_id"]);
  });
});
