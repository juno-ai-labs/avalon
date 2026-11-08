/**
 * WorkspaceDO migration 151 adds `canvas_access_requests` and rebuilds
 * `canvas_participants` so its source admits `request`. A rebuild that drops
 * a participant, its index or the memory-digest triggers would take a person
 * out of a Canvas or stop their memory from following who may read it.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 151;
const openDatabases: DatabaseSync[] = [];

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

const insertParticipant = (database: DatabaseSync, userId: string, source: string) => database.prepare(`INSERT INTO canvas_participants
  (canvas_id, user_id, source, added_by_user_id, added_at) VALUES ('canvas-one', ?, ?, 'creator', 10)`).run(userId, source);
const insertRequest = (database: DatabaseSync, requestId: string, state: string, decidedAt: number | null) => database.prepare(`INSERT INTO
  canvas_access_requests (request_id, canvas_id, user_id, requester_name, message, state, created_at, decided_at)
  VALUES (?, 'canvas-one', 'asker', 'Robin', NULL, ?, 20, ?)`).run(requestId, state, decidedAt);

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 151", () => {
  it("keeps every participant, its index and its triggers, admits a request seat, and allows one pending request per person", () => {
    const database = new DatabaseSync(":memory:");
    openDatabases.push(database);
    apply(database, VERSION - 1);
    insertParticipant(database, "added-one", "added");
    insertParticipant(database, "guest-one", "invitation");
    expect(() => insertParticipant(database, "early", "request")).toThrow(/CHECK constraint failed/u);

    apply(database, VERSION, VERSION - 1);

    expect(database.prepare(`SELECT user_id, source, added_by_user_id, added_at FROM canvas_participants ORDER BY user_id`).all()).toEqual([
      { user_id: "added-one", source: "added", added_by_user_id: "creator", added_at: 10 },
      { user_id: "guest-one", source: "invitation", added_by_user_id: "creator", added_at: 10 },
    ]);
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'canvas_participants'
      AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all()).toEqual([
      { name: "canvas_participants_user_idx" },
      { name: "memory_digest_canvas_participant_delete" },
      { name: "memory_digest_canvas_participant_insert" },
    ]);
    insertParticipant(database, "asker", "request");
    insertRequest(database, "denied-one", "denied", 30);
    insertRequest(database, "pending-one", "pending", null);
    expect(() => insertRequest(database, "pending-two", "pending", null)).toThrow(/UNIQUE constraint failed/u);
    expect(() => insertRequest(database, "undecided", "approved", null)).toThrow(/CHECK constraint failed/u);
  });
});
