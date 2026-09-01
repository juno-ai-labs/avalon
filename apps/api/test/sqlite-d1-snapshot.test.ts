import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DatabaseSync } from "node:sqlite";
import {
  databaseThroughMigration,
  describeDatabase,
  type SqliteTemplateVariant,
} from "./helpers/migrated-schema";
import { migratedSchemaDescription } from "./helpers/migrated-schema-snapshots";
import {
  legacyProductSqliteDatabase,
  migratedSqliteDatabase,
  preRetirementProductSqliteDatabase,
} from "./helpers/sqlite-d1";

/**
 * Seeded rows with the one column the chain recomputes on every run removed.
 *
 * `workstream_authority_control` and `digest_reconciliation_control` each seed
 * `updated_at` with `datetime('now')`, so a replay and a rebuild agree on
 * everything but the second they were built in. That is the *only* such column:
 * replaying the chain twice a second and a half apart leaves every other seeded
 * value identical, which is how this list was arrived at and how it should be
 * rechecked.
 *
 * Naming the column matters. Exempting whole rows instead — which this test did
 * first — takes `phase`, `generation` and both contract versions with it, and
 * those decide the serving phase `workstream-authority.ts` reads. A fixture
 * handing tests the wrong phase reads as a product bug, not a fixture bug. If a
 * later migration seeds another generation-time column, this comparison fails
 * loudly and that column gets added here; that is the intended outcome, not a
 * reason to widen the exemption back out.
 */
const GENERATION_STAMP_COLUMNS = ["updated_at"];

function withoutGenerationStamps(rows: unknown): unknown[] {
  return (rows as Array<Record<string, unknown>>).map((row) => Object.fromEntries(
    Object.entries(row).filter(([column]) => !GENERATION_STAMP_COLUMNS.includes(column)),
  ));
}

describe("migrated SQLite fixtures", () => {
  const variants: Array<[SqliteTemplateVariant, () => DatabaseSync]> = [
    ["regional", migratedSqliteDatabase],
    ["pre-retirement", preRetirementProductSqliteDatabase],
    ["legacy-product", legacyProductSqliteDatabase],
  ];

  for (const [variant, fixture] of variants) {
    it(`rebuilds the ${variant} shape exactly as replaying the migrations leaves it`, () => {
      const replayed = migratedSchemaDescription(variant);
      const rebuiltDatabase = fixture();
      const rebuilt = describeDatabase(rebuiltDatabase);
      rebuiltDatabase.close();
      for (const key of Object.keys(replayed)) {
        if (key.endsWith("::rows")) {
          expect(withoutGenerationStamps(rebuilt[key]), key)
            .toStrictEqual(withoutGenerationStamps(replayed[key]));
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
    expect((migratedSchemaDescription("legacy-product").foreignKeysEnforced as { foreign_keys: number })
      .foreign_keys).toBe(1);
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

  it("preserves the existing platform route while applying the multiple-workspaces migration", () => {
    const database = databaseThroughMigration("0097_email_routes_use_full_address.sql");
    database.prepare(
      `INSERT INTO platform_workspace_bindings
         (platform_user_id, region, workspace_id, status, operation_id,
          pending_expires_at, created_at, updated_at, placement_affinity)
       VALUES (?, 'eu', ?, 'active', ?, NULL, ?, ?, 'weur')`,
    ).run(
      "00000000-0000-7000-8000-0000000000a1",
      "00000000-0000-7000-8000-0000000000a2",
      "00000000-0000-7000-8000-0000000000a3",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );

    database.exec(readFileSync(
      new URL("../../../packages/db/migrations/0098_multiple_workspaces.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      `SELECT platform_user_id, region, workspace_id, status, operation_id,
              pending_expires_at, created_at, updated_at, placement_affinity
         FROM platform_workspace_bindings`,
    ).get()).toEqual({
      platform_user_id: "00000000-0000-7000-8000-0000000000a1",
      region: "eu",
      workspace_id: "00000000-0000-7000-8000-0000000000a2",
      status: "active",
      operation_id: "00000000-0000-7000-8000-0000000000a3",
      pending_expires_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      placement_affinity: "weur",
    });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM platform_workspace_operations`,
    ).get()).toEqual({ count: 0 });
    database.close();
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
