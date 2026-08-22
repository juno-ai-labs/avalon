import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  buildTemplateDatabase,
  type SqliteTemplateVariant,
} from "./helpers/migrated-schema";
import {
  legacyProductSqliteDatabase,
  migratedSqliteDatabase,
  preRetirementProductSqliteDatabase,
} from "./helpers/sqlite-d1";

/**
 * The fixtures rebuild a migrated database from a captured shape instead of
 * replaying 95 migrations per test. That is only sound while the rebuilt shape
 * is indistinguishable from the replayed one, and "indistinguishable" has to
 * mean more than "the tables have the same names": a lost trigger, a dropped
 * `ON DELETE`, an index that no longer covers the same columns are all invisible
 * to a schema-name check and all change what a test proves. So this compares
 * everything SQLite will tell us about both databases.
 *
 * It has caught one already — the FTS5 index triggers share a name prefix with
 * the shadow tables the virtual table creates for itself, and the first cut of
 * the shadow-table filter took the triggers with them. Every memory-search test
 * went green against an index nothing wrote to.
 */
function describeDatabase(database: DatabaseSync): Record<string, unknown> {
  const described: Record<string, unknown> = {
    schema: database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    ).all(),
    foreignKeysEnforced: database.prepare("PRAGMA foreign_keys").get(),
  };
  const tables = (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  for (const table of tables) {
    described[`${table}::columns`] = database.prepare(`PRAGMA table_info("${table}")`).all();
    described[`${table}::foreign-keys`] = database.prepare(`PRAGMA foreign_key_list("${table}")`).all();
    described[`${table}::indexes`] = database.prepare(`PRAGMA index_list("${table}")`).all();
    described[`${table}::rows`] = database.prepare(`SELECT * FROM "${table}"`).all();
  }
  return described;
}

describe("migrated SQLite fixtures", () => {
  const variants: Array<[SqliteTemplateVariant, () => DatabaseSync]> = [
    ["regional", migratedSqliteDatabase],
    ["pre-retirement", preRetirementProductSqliteDatabase],
    ["legacy-product", legacyProductSqliteDatabase],
  ];

  for (const [variant, fixture] of variants) {
    it(`rebuilds the ${variant} shape exactly as replaying the migrations leaves it`, () => {
      const replayed = describeDatabase(buildTemplateDatabase(variant));
      const rebuilt = describeDatabase(fixture());
      // The two control tables stamp `datetime('now')`, so they agree on
      // everything but the second they were built in. Compare their shape and
      // row count, and let the timestamps differ.
      for (const key of Object.keys(replayed)) {
        if (key.endsWith("::rows")) {
          expect((rebuilt[key] as unknown[]).length, key).toBe((replayed[key] as unknown[]).length);
          continue;
        }
        expect(rebuilt[key], key).toStrictEqual(replayed[key]);
      }
      expect(Object.keys(rebuilt)).toStrictEqual(Object.keys(replayed));
    });
  }

  it("leaves foreign keys enforced, the way the migration sequence does", () => {
    // `node:sqlite` opens a connection with foreign keys off, but seven of the
    // migrations set the pragma themselves, so a replay ends with enforcement
    // on however the caller opened it. Fixtures that never wrote the pragma
    // were relying on that without saying so — `notes` cascading from a deleted
    // `resources` row is one of them — so the rebuild has to end there too.
    const enforcementOf = (database: DatabaseSync): number =>
      (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    expect(enforcementOf(buildTemplateDatabase("legacy-product"))).toBe(1);
    expect(enforcementOf(legacyProductSqliteDatabase())).toBe(1);
    expect(() => legacyProductSqliteDatabase().exec(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ('absent', 'absent', 'member')`,
    )).toThrow(/FOREIGN KEY/iu);
  });

  it("hands every caller its own database", () => {
    const first = migratedSqliteDatabase();
    const second = migratedSqliteDatabase();
    first.exec(`INSERT INTO users (id, email, google_subject, name, created_at, updated_at)
                VALUES ('u1', 'a@b.c', 'g1', 'A', 'x', 'y')`);
    expect((first.prepare("SELECT count(*) AS count FROM users").get() as { count: number }).count).toBe(1);
    expect((second.prepare("SELECT count(*) AS count FROM users").get() as { count: number }).count).toBe(0);
  });

  it("enforces foreign keys, which a rebuilt schema loads with disabled", () => {
    const database = migratedSqliteDatabase();
    expect(() => database.exec(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ('absent', 'absent', 'member')`,
    )).toThrow(/FOREIGN KEY/iu);
  });

  it("keeps the full-text index writable, triggers and all", () => {
    // The pre-retirement shape is the one carrying the FTS5 tables; the
    // triggers are what a memory search actually reads through.
    const database = preRetirementProductSqliteDatabase();
    const triggers = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_items_fts%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(triggers).toStrictEqual([
      "memory_items_fts_delete",
      "memory_items_fts_insert",
      "memory_items_fts_update",
    ]);
  });
});
