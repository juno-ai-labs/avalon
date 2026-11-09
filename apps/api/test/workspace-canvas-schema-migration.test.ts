/**
 * WorkspaceDO migration 137 is the Canvas schema in one migration. It creates
 * the Canvas tables in their final shape, and copies five shipped tables so
 * their CHECKs admit a Canvas: the sidebar-list waterlines, a Sidekick's
 * conversation attachments, the pins, the retirement graph and the memory
 * digest holders. A copy that dropped a row would take a waterline, an
 * attachment, a person's pin, a retirement receipt or a memory holder with
 * it; one that lost a trigger or an index would stop memory following who
 * may read it, or make a hot read a scan.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { recordMemoryDigestHolder } from "../src/durable-objects/memory-digest-sync";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { ApiError } from "../src/lib/api-error";

const VERSION = 137;
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

type Row = Record<string, unknown>;
const all = (database: DatabaseSync, query: string) => database.prepare(query).all() as Row[];
const objectsOn = (database: DatabaseSync, table: string) => all(database, `SELECT type, name FROM sqlite_master
  WHERE tbl_name = '${table}' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name`);
const memoryTriggers = (database: DatabaseSync) => all(database,
  "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_digest_%' ORDER BY name");

const insertParticipant = (database: DatabaseSync, userId: string, source: string) => database.prepare(`INSERT INTO canvas_participants
  (canvas_id, user_id, source, added_by_user_id, added_at) VALUES ('canvas-one', ?, ?, 'creator', 10)`).run(userId, source);
const insertRequest = (database: DatabaseSync, requestId: string, state: string, decidedAt: number | null) => database.prepare(`INSERT INTO
  canvas_access_requests (request_id, canvas_id, user_id, requester_name, message, state, created_at, decided_at)
  VALUES (?, 'canvas-one', 'asker', 'Robin', NULL, ?, 20, ?)`).run(requestId, state, decidedAt);

/** One row in every table 137 copies, in the shape the last shipped version (135) and 136 left it. */
function seedShippedRows(database: DatabaseSync): void {
  database.exec(`
    UPDATE workspace_sidebar_list_state SET waterline = 41 WHERE list = 'automations';
    INSERT INTO sidekick_conversation_attachments VALUES ('sidekick-one', 'workstream', 'thread-one', '0', 'user-one', 5);
    INSERT INTO workspace_pins VALUES
      ('user-one', 'thread', 'thread-one', NULL, 0, 1, 2),
      ('user-one', 'artifact', 'resource-one', 'thread-one', 1, 3, 4);
    INSERT INTO workspace_retirement_graph VALUES
      ('workstream', 'thread-one', 10, 20), ('automation', 'sidekick-one', 10, NULL), ('space', 'channel-one', 10, NULL);
    INSERT INTO memory_digest_holders VALUES ('thread-conversation', 'workstream', 'thread-one', '0', 7);
    INSERT INTO memory_digest_holder_facts VALUES ('thread-conversation', 'user:one', 'fact-one');
  `);
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 142", () => {
  it("keeps existing Canvases and participants active when adding the archive tombstone", () => {
    const database = openDatabase();
    apply(database, 141);
    database.exec(`INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at,
      visibility, authority_generation) VALUES ('canvas-one', 'workspace', 'Plan', 'creator', 1, 1, 'participants', 1)`);
    insertParticipant(database, 'participant', 'added');
    apply(database, 142, 141);
    expect(all(database, "SELECT canvas_id, title, archived_at FROM canvas_directory"))
      .toEqual([{ canvas_id: 'canvas-one', title: 'Plan', archived_at: null }]);
    expect(all(database, "SELECT user_id FROM canvas_participants")).toEqual([{ user_id: 'participant' }]);
    expect(() => database.exec("UPDATE canvas_directory SET archived_at = -1")).toThrow(/CHECK constraint failed/u);
  });
});

describe("WorkspaceDO migration 137", () => {
  it("keeps every row of the tables it copies, with their indexes and triggers, and admits a Canvas in each", () => {
    const database = openDatabase();
    apply(database, VERSION - 1);
    seedShippedRows(database);
    const waterlines = all(database, "SELECT list, waterline FROM workspace_sidebar_list_state ORDER BY list");
    const shippedMemoryTriggers = memoryTriggers(database);
    expect(shippedMemoryTriggers.length).toBeGreaterThan(0);
    expect(() => database.exec(`INSERT INTO workspace_pins VALUES ('user-one', 'canvas', 'canvas-early', NULL, 0, 1, 1)`))
      .toThrow(/CHECK constraint failed/u);

    apply(database, VERSION, VERSION - 1);

    expect(all(database, "SELECT list, waterline FROM workspace_sidebar_list_state ORDER BY list"))
      .toEqual([...waterlines, { list: "canvases", waterline: 0 }].sort((a, b) => String(a.list).localeCompare(String(b.list))));
    expect(all(database, "SELECT * FROM sidekick_conversation_attachments")).toEqual([{ automation_id: "sidekick-one",
      parent_kind: "workstream", parent_id: "thread-one", substream_id: "0", attached_by_user_id: "user-one", attached_at: 5 }]);
    expect(all(database, "SELECT * FROM workspace_pins ORDER BY position")).toEqual([
      { user_id: "user-one", item_kind: "thread", item_id: "thread-one", parent_id: null, position: 0, created_at: 1, updated_at: 2 },
      { user_id: "user-one", item_kind: "artifact", item_id: "resource-one", parent_id: "thread-one", position: 1, created_at: 3,
        updated_at: 4 },
    ]);
    expect(objectsOn(database, "workspace_pins")).toEqual([
      { type: "index", name: "workspace_pins_item_idx" }, { type: "index", name: "workspace_pins_order_idx" }]);
    expect(all(database, "SELECT * FROM workspace_retirement_graph ORDER BY parent_kind")).toEqual([
      { parent_kind: "automation", parent_id: "sidekick-one", recorded_at: 10, retired_at: null },
      { parent_kind: "space", parent_id: "channel-one", recorded_at: 10, retired_at: null },
      { parent_kind: "workstream", parent_id: "thread-one", recorded_at: 10, retired_at: 20 },
    ]);
    expect(all(database, "SELECT * FROM memory_digest_holders")).toEqual([{ conversation: "thread-conversation",
      parent_kind: "workstream", parent_id: "thread-one", substream_id: "0", refreshed_at: 7 }]);
    expect(all(database, "SELECT * FROM memory_digest_holder_facts")).toEqual([
      { conversation: "thread-conversation", principal: "user:one", fact_id: "fact-one" }]);
    // The shipped triggers, under their own names, and the Canvas and Sidekick-audience ones beside them.
    expect(memoryTriggers(database)).toEqual([...shippedMemoryTriggers,
      { name: "memory_digest_canvas_delete" }, { name: "memory_digest_canvas_participant_delete" },
      { name: "memory_digest_canvas_participant_insert" }, { name: "memory_digest_canvas_visibility" },
      { name: "memory_digest_sidekick_audience_delete" }, { name: "memory_digest_sidekick_audience_insert" },
    ].sort((a, b) => String(a.name).localeCompare(String(b.name))));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    database.exec(`
      INSERT INTO sidekick_conversation_attachments VALUES ('sidekick-one', 'canvas', 'canvas-one', '0', 'user-one', 6);
      INSERT INTO workspace_pins VALUES ('user-one', 'canvas', 'canvas-one', NULL, 2, 5, 5), ('user-one', 'sidekick', 'sidekick-one', NULL, 0, 5, 5);
      INSERT INTO workspace_retirement_graph VALUES ('canvas', 'canvas-one', 30, NULL);
      INSERT INTO memory_digest_holders VALUES ('canvas-conversation', 'canvas', 'canvas-one', '0', 8);
    `);
    expect(() => database.exec(`INSERT INTO workspace_retirement_graph VALUES ('thread', 'unknown-kind', 30, NULL)`))
      .toThrow(/CHECK constraint failed/u);
    expect(() => database.exec(`INSERT INTO memory_digest_holders VALUES ('project-conversation', 'project', 'p', '0', 8)`))
      .toThrow(/CHECK constraint failed/u);
  });

  it("makes a Canvas in its final shape: a request seat, one pending request per person, and the later columns", () => {
    const database = openDatabase();
    apply(database, VERSION);
    database.exec(`INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at,
      visibility, authority_generation) VALUES ('canvas-one', 'workspace', 'Plan', 'creator', 1, 1, 'participants', 1)`);
    expect(all(database, "SELECT title_status, appearance_json, last_writer_run_id FROM canvas_directory")).toEqual([
      { title_status: "settled", appearance_json: null, last_writer_run_id: null }]);
    // Only a Sidekick editor's publish names a run.
    expect(() => database.exec(`UPDATE canvas_directory SET last_editor_kind = 'person', last_writer_run_id = 'run-one'`))
      .toThrow(/CHECK constraint failed/u);
    database.exec(`UPDATE canvas_directory SET last_editor_kind = 'sidekick', last_writer_run_id = 'run-one'`);
    expect(() => database.exec(`UPDATE canvas_directory SET appearance_json = 'not json'`)).toThrow(/CHECK constraint failed/u);
    expect(() => database.exec(`UPDATE canvas_directory SET title_status = 'automatic'`)).toThrow(/CHECK constraint failed/u);

    insertParticipant(database, "added-one", "added");
    insertParticipant(database, "guest-one", "invitation");
    insertParticipant(database, "asker", "request");
    expect(() => insertParticipant(database, "other", "copied")).toThrow(/CHECK constraint failed/u);
    expect(objectsOn(database, "canvas_participants")).toEqual([
      { type: "index", name: "canvas_participants_user_idx" },
      { type: "trigger", name: "memory_digest_canvas_participant_delete" },
      { type: "trigger", name: "memory_digest_canvas_participant_insert" },
    ]);
    insertRequest(database, "denied-one", "denied", 30);
    insertRequest(database, "pending-one", "pending", null);
    expect(() => insertRequest(database, "pending-two", "pending", null)).toThrow(/UNIQUE constraint failed/u);
    expect(() => insertRequest(database, "undecided", "approved", null)).toThrow(/CHECK constraint failed/u);
  });

  it("names the kind a holder table without it refuses", () => {
    const database = openDatabase();
    apply(database, VERSION - 1);
    // The object's SqlStorage, as far as recordMemoryDigestHolder uses it.
    const sql = { exec: (query: string, ...bindings: Array<string | number>) => {
      database.prepare(query).run(...bindings);
    } } as unknown as SqlStorage;
    let refused: unknown;
    try {
      recordMemoryDigestHolder(sql, { conversation: { parentKind: "canvas", parentId: "canvas-one", substreamId: "0" },
        principal: "user:one", factIds: [], now: 1 });
    } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: "memory_digest_holder_kind_unadmitted",
      diagnosticCode: "memory_digest_holder_kind_unadmitted:canvas" });
  });
});
