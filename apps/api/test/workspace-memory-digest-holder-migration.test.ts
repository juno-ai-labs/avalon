/**
 * WorkspaceDO migration 143 copies `memory_digest_holders` into a table whose
 * CHECK also admits a Canvas's Chat. A copy that drops a row, or restores the
 * table's triggers under other names, would lose a holder or its fan-out.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { recordMemoryDigestHolder } from "../src/durable-objects/memory-digest-sync";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { ApiError } from "../src/lib/api-error";

const ADMIT_CANVAS_VERSION = 143;
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

const triggers = (database: DatabaseSync) => database.prepare(
  "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_digest_%' ORDER BY name").all();

const insertHolder = (database: DatabaseSync, conversation: string, kind: string) => database.prepare(
  `INSERT INTO memory_digest_holders(conversation, parent_kind, parent_id, substream_id, refreshed_at)
   VALUES (?, ?, ?, '0', 7)`).run(conversation, kind, `${kind}-parent`);

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 143", () => {
  it("keeps a Thread's holder and its facts, keeps every trigger, and admits a Canvas", () => {
    const database = openDatabase();
    apply(database, ADMIT_CANVAS_VERSION - 1);
    insertHolder(database, "thread-conversation", "workstream");
    database.exec(`INSERT INTO memory_digest_holder_facts(conversation, principal, fact_id)
      VALUES ('thread-conversation', 'user:one', 'fact-one')`);
    const before = triggers(database);
    expect(before.length).toBeGreaterThan(0);

    apply(database, ADMIT_CANVAS_VERSION, ADMIT_CANVAS_VERSION - 1);

    expect(database.prepare("SELECT * FROM memory_digest_holders").all()).toEqual([{
      conversation: "thread-conversation", parent_kind: "workstream", parent_id: "workstream-parent",
      substream_id: "0", refreshed_at: 7 }]);
    expect(database.prepare("SELECT * FROM memory_digest_holder_facts").all()).toEqual([{
      conversation: "thread-conversation", principal: "user:one", fact_id: "fact-one" }]);
    expect(triggers(database)).toEqual(before);
    insertHolder(database, "canvas-conversation", "canvas");
    expect(database.prepare("SELECT parent_kind FROM memory_digest_holders WHERE conversation = 'canvas-conversation'")
      .all()).toEqual([{ parent_kind: "canvas" }]);
    expect(() => insertHolder(database, "project-conversation", "project")).toThrow(/CHECK constraint failed/u);
  });

  it("names the kind a holder table without it refuses", () => {
    const database = openDatabase();
    apply(database, ADMIT_CANVAS_VERSION - 1);
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
