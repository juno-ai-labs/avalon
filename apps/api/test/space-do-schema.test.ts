import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/space-do-schema";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do-schema";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

/**
 * `SpaceDO` is `WorkstreamDO` under a role, so it runs the same methods against
 * the same tables — but it reaches them through one fresh migration instead of
 * seventeen replayed ones. Nothing else in the tree compares the two, so a
 * column added to `workstream_do`'s next version and not to `space_do`'s would
 * be invisible until an inherited method met a missing column on a real Space.
 */
function storageFor(database: DatabaseSync): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    transactionSync: <T>(body: () => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    sql: createTestSqlStorage(database),
  });
}

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/**
 * SQLite stores a table's `CREATE` text verbatim, so two databases that agree
 * on every column can still disagree on quoting and whitespace: `ALTER TABLE
 * ... RENAME` rewrites the name in place and quotes it, which is how
 * `workstream_do` version 15 left `durable_outbox` spelled `"durable_outbox"`.
 * Normalizing those two away compares the schema rather than its typography;
 * every column, constraint, and default still has to match exactly.
 */
function normalize(sql: string | null): string | null {
  return sql === null ? null : sql.replace(/"/gu, "").replace(/\s+/gu, " ").trim();
}

function schemaOf(migrations: readonly DurableObjectSqliteMigration[], component: string): {
  objects: SchemaObject[];
  columns: Record<string, unknown[]>;
} {
  const database = new DatabaseSync(":memory:");
  try {
    applyDurableObjectSqliteMigrations({
      storage: storageFor(database),
      migrations,
      component,
      workerVersionId: "test",
    });
    const objects = (database.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name != '_sql_schema_migrations' ORDER BY type, name`,
    ).all() as unknown as SchemaObject[]).map((row) => ({
      ...row,
      sql: normalize(row.sql),
    })) as SchemaObject[];
    const columns: Record<string, unknown[]> = {};
    for (const object of objects) {
      if (object.type !== "table") continue;
      columns[object.name] = database.prepare(
        `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`,
      ).all(object.name) as unknown[];
    }
    return { objects, columns };
  } finally {
    database.close();
  }
}

describe("space_do schema", () => {
  it("given both object ledgers, when each is applied in full, then they render the same schema", () => {
    const workstream = schemaOf(WORKSTREAM_DO_SCHEMA_MIGRATIONS, "workstream_do");
    const space = schemaOf(SPACE_DO_SCHEMA_MIGRATIONS, "space_do");

    expect(space.objects.map((object) => `${object.type}:${object.name}`))
      .toEqual(workstream.objects.map((object) => `${object.type}:${object.name}`));
    expect(space.objects).toEqual(workstream.objects);
    // Column order too: a rebuilt table's `cid` sequence is what an
    // `INSERT ... SELECT *` inside a future migration would depend on.
    expect(space.columns).toEqual(workstream.columns);
    // The comparison is worthless if either side rendered nothing.
    expect(Object.keys(workstream.columns).length).toBeGreaterThan(20);
  });

  it("given the space ledger, when its shape is read, then every version is released and appended", () => {
    expect(SPACE_DO_SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2]);
    // A new version is appended; each earlier one is receipted by every Space
    // that has ever been constructed and may not be edited.
    for (const migration of SPACE_DO_SCHEMA_MIGRATIONS) {
      expect(migration.foreignKeys).toBeUndefined();
    }
  });

  it("given migration 18's statements, when both ledgers run them, then each renders the same access tables", () => {
    const workstream = schemaOf(WORKSTREAM_DO_SCHEMA_MIGRATIONS, "workstream_do");
    const space = schemaOf(SPACE_DO_SCHEMA_MIGRATIONS, "space_do");
    // Named rather than left to the object-for-object comparison above: the
    // drift this file exists to catch is a table added to one ledger and not
    // the other, and the comparison passes trivially if *neither* ledger grew
    // the tables the change was about.
    for (const table of [
      "workstream_direct_audience",
      "workstream_space_access_sources",
      "workstream_space_supplied_readers",
      "workstream_access_operations",
    ]) {
      expect(Object.keys(space.columns)).toContain(table);
      expect(space.columns[table]).toEqual(workstream.columns[table]);
    }
    expect((space.columns.scope_grants as { name: string }[]).map((column) => column.name))
      .toEqual(["user_id", "scope_kind", "substream_id", "grant_json", "source_kind", "source_id"]);
  });
});
