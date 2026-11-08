/**
 * WorkspaceDO migration 147 drops the Thread-era tables nothing reads and the
 * Thread rows of the shared tables, keeping what the Thread conversion reads.
 * A drop that left a trigger writing a dropped table, or a foreign key naming
 * one, would fail every later write to the surviving table; a delete that
 * reached a Canvas's or a Sidekick's rows, the Thread retirement inventory or
 * the conversion's links, would lose live state.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 147;
const openDatabases: DatabaseSync[] = [];

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

type Row = Record<string, unknown>;
const all = (database: DatabaseSync, query: string) => database.prepare(query).all() as Row[];
const tables = (database: DatabaseSync) => new Set(all(database,
  "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name)));

/** Every table a trigger body or a foreign key names, that the schema does not hold. */
function danglingReferences(database: DatabaseSync): string[] {
  const present = tables(database);
  const dangling: string[] = [];
  for (const trigger of all(database, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")) {
    const body = String(trigger.sql).replace(/^[\s\S]*?\bBEGIN\b/iu, "");
    for (const match of body.matchAll(/\b(?:FROM|INTO|(?<!DO\s+)UPDATE|JOIN)\s+"?([a-z_][a-z0-9_]*)"?/giu)) {
      const name = match[1] ?? "";
      if (!present.has(name) && name !== "json_each") dangling.push(`${String(trigger.name)} -> ${name}`);
    }
  }
  for (const table of present) {
    for (const key of all(database, `PRAGMA foreign_key_list("${table}")`)) {
      if (!present.has(String(key.table))) dangling.push(`${table} REFERENCES ${String(key.table)}`);
    }
  }
  return dangling;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 147", () => {
  it("drops the Thread-era tables and rows, and keeps what Canvases, Sidekicks and the Thread retirement read", () => {
    const database = new DatabaseSync(":memory:");
    openDatabases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, VERSION - 1);
    database.exec(`
      INSERT INTO memory_digest_holders VALUES
        ('thread-conversation', 'workstream', 'thread-one', '0', 1),
        ('channel-conversation', 'space', 'channel-one', '0', 1),
        ('canvas-conversation', 'canvas', 'canvas-one', '0', 1);
      INSERT INTO memory_digest_holder_facts VALUES
        ('thread-conversation', 'user:one', 'fact-one'), ('canvas-conversation', 'user:one', 'fact-one');
      INSERT INTO memory_digest_sync (conversation, revision, attempts, not_before) VALUES
        ('thread-conversation', 1, 0, 0), ('canvas-conversation', 2, 0, 0);
      INSERT INTO sidekick_conversation_attachments VALUES
        ('sidekick-one', 'workstream', 'thread-one', '0', 'user-one', 1),
        ('sidekick-one', 'canvas', 'canvas-one', '0', 'user-one', 1);
      INSERT INTO workspace_pins VALUES
        ('user-one', 'thread', 'thread-one', NULL, 0, 1, 1),
        ('user-one', 'artifact', 'resource-one', 'thread-one', 0, 1, 1),
        ('user-one', 'canvas', 'canvas-one', NULL, 0, 1, 1),
        ('user-one', 'sidekick', 'sidekick-one', NULL, 0, 1, 1);
      INSERT INTO external_conversation_bindings
        (installation_id, path_json, target_kind, space_id, parent_kind, parent_id, substream_id, state, created_at, updated_at)
      VALUES
        ('install', '["room"]', 'space', 'channel-one', NULL, NULL, NULL, 'active', 'now', 'now'),
        ('install', '["room","thread"]', 'conversation', NULL, 'workstream', 'thread-one', '0', 'active', 'now', 'now'),
        ('install', '["room","run"]', 'conversation', NULL, 'automation', 'sidekick-one', 'run-one', 'active', 'now', 'now');
      INSERT INTO parent_metadata (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
      VALUES ('thread-one', 'workstream', 'workspace', 'wnam', 1, 1, 1);
      INSERT INTO thread_backfill (job, workstream_id, attempts, not_before) VALUES ('conversation_view', 'thread-one', 0, 0);
      INSERT INTO channel_rail_changes VALUES ('thread-one');
    `);
    const before = tables(database);
    expect(danglingReferences(database)).toEqual([]);

    apply(database, VERSION, VERSION - 1);

    expect(danglingReferences(database)).toEqual([]);
    const after = tables(database);
    for (const dropped of ["thread_backfill", "channel_rail_changes", "workspace_activity_events", "work_opportunities",
      "space_messages", "workspace_workstream_pins", "workstream_email_receipts", "digest_deliveries"]) {
      expect(after.has(dropped), dropped).toBe(false);
    }
    for (const kept of ["channels", "channel_viewers", "breakouts", "breakout_viewers", "spaces", "space_viewers",
      "parent_metadata", "parent_children", "canvas_directory", "automation_directory", "digest_schedules", "schedules",
      // The Thread conversion reads a Thread's links to artifacts other conversations made.
      "workspace_workstream_resource_links"]) {
      expect(after.has(kept), kept).toBe(true);
    }
    expect([...before].filter((table) => !after.has(table))).toHaveLength(48);
    expect(all(database, "SELECT conversation, parent_kind FROM memory_digest_holders")).toEqual([
      { conversation: "canvas-conversation", parent_kind: "canvas" }]);
    expect(all(database, "SELECT conversation FROM memory_digest_holder_facts")).toEqual([
      { conversation: "canvas-conversation" }]);
    expect(all(database, "SELECT conversation FROM memory_digest_sync")).toEqual([{ conversation: "canvas-conversation" }]);
    // A Thread's stays for the conversion to carry to its Canvas; retiring the Thread deletes it.
    expect(all(database, "SELECT parent_kind FROM sidekick_conversation_attachments ORDER BY parent_kind")).toEqual([
      { parent_kind: "canvas" }, { parent_kind: "workstream" }]);
    expect(all(database, "SELECT item_kind FROM workspace_pins ORDER BY item_kind")).toEqual([
      { item_kind: "canvas" }, { item_kind: "sidekick" }]);
    expect(all(database, "SELECT parent_kind FROM external_conversation_bindings")).toEqual([{ parent_kind: "automation" }]);
    expect(all(database, "SELECT parent_id FROM parent_metadata")).toEqual([{ parent_id: "thread-one" }]);
    // A Sidekick's schedule still inserts: `schedules` names `digest_schedules` in a foreign key.
    database.exec(`INSERT INTO workspace_identity VALUES (1, 'workspace', 'wnam', 'wnam', 1, 1)`);
    expect(() => database.exec(`INSERT INTO schedules
      (id, workspace_id, connector_connection_id, schedule_type, interval_seconds, timezone, next_run_at, created_at, updated_at)
      VALUES ('schedule', 'workspace', 'connection', 'interval', 60, 'UTC', 'now', 'now', 'now')`)).not.toThrow();
  });
});
