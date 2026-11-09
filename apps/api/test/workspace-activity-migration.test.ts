/**
 * WorkspaceDO migration 139 makes each person's Activity after migration 138
 * has dropped the Thread-era table of the same purpose. It must create the
 * table every notice kind can land in, and add the Activity list's waterline
 * without touching the other lists' waterlines, which the sidebar reads to
 * decide what a reconnecting client already has.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 139;
const WORKSPACE_ID = "00000000-0000-7000-8000-00000000c139";
const openDatabases: DatabaseSync[] = [];

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

const insertItem = (database: DatabaseSync, itemId: string, kind: string, subjectId: string | null) => database.prepare(
  `INSERT INTO workspace_activity_items
    (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id, message_sequence, run_id,
     actor_kind, actor_id, preview, attention_ordinal, created_at, subject_id)
  VALUES (?, ?, 'user-one', ?, 'canvas', 'canvas-one', '0', 'turn-one', 4, NULL, 'person', 'user-two', 'Look', 3, 1700, ?)`,
).run(itemId, WORKSPACE_ID, kind, subjectId);

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 139", () => {
  it("adds the Activity waterline beside the others, and records every notice kind with its subject", () => {
    const database = new DatabaseSync(":memory:");
    openDatabases.push(database);
    apply(database, VERSION - 1);
    database.exec(`UPDATE workspace_sidebar_list_state SET waterline = 9 WHERE list = 'canvases'`);
    const waterlines = database.prepare("SELECT list, waterline FROM workspace_sidebar_list_state ORDER BY list").all();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'workspace_activity_%'").all()).toEqual([]);

    apply(database, VERSION, VERSION - 1);

    expect(database.prepare("SELECT list, waterline FROM workspace_sidebar_list_state ORDER BY list").all())
      .toEqual([{ list: "activity", waterline: 0 }, ...waterlines]);
    for (const kind of ["mention", "participant_added", "needs_input", "run_finished", "new_message", "artifact_updated",
      "access_request", "access_granted", "access_denied"]) {
      insertItem(database, `item-${kind}`, kind, kind.startsWith("access_") ? "request-one" : null);
    }
    expect(() => insertItem(database, "retired", "thread_started", null)).toThrow(/CHECK constraint failed/u);
    expect(database.prepare("SELECT kind, subject_id FROM workspace_activity_items WHERE kind = 'access_denied'").all())
      .toEqual([{ kind: "access_denied", subject_id: "request-one" }]);
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE tbl_name IN ('workspace_activity_items', 'workspace_activity_seen')
      AND type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all()).toEqual([
      { name: "workspace_activity_items_parent_idx" },
      { name: "workspace_activity_items_recipient_idx" },
    ]);
    database.exec("INSERT INTO workspace_activity_seen (user_id, seen_through) VALUES ('user-one', 1700)");
  });
});
