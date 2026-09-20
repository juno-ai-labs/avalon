import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do-schema";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

/**
 * Migration 18 against the real ledger.
 *
 * The backfill is the part a fresh-schema test cannot see: `workstream_do` 18
 * runs on objects that already exist, and what it reads there — a
 * `workstream_metadata` row that may or may not be present yet — decides what
 * the Channel's *direct* audience is recorded as for the rest of its life.
 * The cascade and the constraints are checked here rather than in workerd
 * because `createTestSqlStorage` enforces foreign keys the way workerd does
 * and this is a question about SQL, not about the runtime.
 */
function storage(database: DatabaseSync): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: createTestSqlStorage(database),
  });
}

function apply(database: DatabaseSync, through: number): void {
  applyDurableObjectSqliteMigrations({
    storage: storage(database),
    migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= through),
    component: "workstream_access_test",
    workerVersionId: `worker-v${through}`,
    now: through,
  });
}

function seedMetadata(database: DatabaseSync, scope: "personal" | "workspace"): void {
  database.prepare(
    `INSERT INTO workstream_metadata
       (id, workspace_id, workstream_id, region, authority_generation, title, description,
        preview, scope, exact_state, last_activity_at, created_at, updated_at)
     VALUES (1, 'workspace', 'workstream', 'global', 1, 'Hiring', '', '', ?, 'idle', 1, 1, 1)`,
  ).run(scope);
}

function seedSource(database: DatabaseSync, spaceId: string, participants: string[] = []): void {
  database.prepare(
    `INSERT INTO workstream_space_access_sources
       (space_id, scope, participants_json, space_revision, membership_generation,
        operation_id, applied_at, updated_at)
     VALUES (?, 'personal', ?, 1, 1, 'operation', 1, 1)`,
  ).run(spaceId, JSON.stringify(participants));
}

describe("WorkstreamDO migration 18", () => {
  it("given a Channel that is Organization-wide, when the migration runs, then its direct audience keeps that scope", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 17);
    seedMetadata(database, "workspace");

    apply(database, 18);

    // The metadata scope becomes the *effective* audience the moment a Space
    // widens the Channel, so this row is the only remaining record of what the
    // Channel was on its own. Backfilling it as `personal` would make a later
    // retraction narrow a Channel that was always Organization-wide.
    expect(database.prepare("SELECT id, scope, updated_at FROM workstream_direct_audience").all())
      .toEqual([{ id: 1, scope: "workspace", updated_at: 0 }]);
  });

  it("given an object with no metadata row yet, when the migration runs, then the direct audience is personal and unobserved", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 17);

    apply(database, 18);

    // A Channel created after this migration ships runs it in its constructor,
    // before `reserveChild("0")` writes any metadata. `updated_at = 0` is what
    // says the value is a guess, and the first Space source replaces it with
    // the reader audience it is handed.
    expect(database.prepare("SELECT scope, updated_at FROM workstream_direct_audience").get())
      .toMatchObject({ scope: "personal", updated_at: 0 });
  });

  it("given grants written before the migration, when it runs, then they read as direct sources", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 17);
    seedMetadata(database, "personal");
    database.prepare(
      "INSERT INTO scope_grants (user_id, scope_kind, substream_id, grant_json) VALUES ('user', 'workstream', '', '{}')",
    ).run();

    apply(database, 18);

    // Nothing but a direct share could write one of these before migration 18,
    // so the defaults are the truth about them rather than a placeholder.
    expect(database.prepare("SELECT user_id, source_kind, source_id FROM scope_grants").all())
      .toEqual([{ user_id: "user", source_kind: "direct", source_id: "" }]);
    expect(() => database.prepare(
      "INSERT INTO scope_grants (user_id, scope_kind, substream_id, grant_json, source_kind) VALUES ('other', 'workstream', '', '{}', 'inherited')",
    ).run()).toThrow(/CHECK constraint failed/u);
  });

  it("given a source with supplied readers, when the source is deleted, then its readers go with it", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 18);
    seedSource(database, "space-a", ["reader"]);
    seedSource(database, "space-b", ["reader"]);
    const insertReader = database.prepare(
      "INSERT INTO workstream_space_supplied_readers (space_id, user_id) VALUES (?, ?)",
    );
    insertReader.run("space-a", "reader");
    insertReader.run("space-b", "reader");

    database.prepare("DELETE FROM workstream_space_access_sources WHERE space_id = 'space-a'").run();

    // "A source that no longer exists stops granting" has to be true of the
    // provenance too: a supplied-reader row outliving its source would keep
    // attributing a reader to a Space that no longer reaches this Channel, and
    // the next retraction would withdraw them on its behalf.
    expect(database.prepare("SELECT space_id FROM workstream_space_supplied_readers ORDER BY space_id").all())
      .toEqual([{ space_id: "space-b" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => insertReader.run("space-a", "reader")).toThrow(/FOREIGN KEY constraint failed/u);
  });

  it("given a source row, when its fences or audience are out of range, then the write is refused", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 18);
    const insert = database.prepare(
      `INSERT INTO workstream_space_access_sources
         (space_id, scope, participants_json, space_revision, membership_generation,
          operation_id, applied_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'operation', 1, 1)`,
    );

    // A zero revision or generation is the absence of a fence written as
    // though it were one: every fenced operation compares `>`, so a row that
    // stored one could never be superseded.
    expect(() => insert.run("space", "personal", "[]", 0, 1)).toThrow(/CHECK constraint failed/u);
    expect(() => insert.run("space", "personal", "[]", 1, 0)).toThrow(/CHECK constraint failed/u);
    expect(() => insert.run("space", "everyone", "[]", 1, 1)).toThrow(/CHECK constraint failed/u);
    expect(() => insert.run("space", "personal", "not json", 1, 1)).toThrow(/CHECK constraint failed/u);
    insert.run("space", "personal", '["reader"]', 1, 1);
    expect(database.prepare("SELECT space_id FROM workstream_space_access_sources").all())
      .toEqual([{ space_id: "space" }]);
  });
});
