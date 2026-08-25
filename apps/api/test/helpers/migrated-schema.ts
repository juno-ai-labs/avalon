/**
 * Building a migrated database, and the shape one ends up in.
 *
 * Separate from `sqlite-d1.ts` because the global setup imports it to build the
 * snapshots once for the whole run, and that runs in Vitest's node context
 * rather than inside a test worker.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { SLACK_REACTION_COLUMN_STATEMENTS } from "../../src/durable-objects/workspace-domain-schema";

const migrationsDirectory = fileURLToPath(new URL("../../../../packages/db/migrations/", import.meta.url));

function migrateSqliteDatabase(through?: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
    if (fileName === through) break;
  }
  return database;
}

/**
 * The finished shape of a migrated database: the DDL every surviving object was
 * left with, plus whatever rows the migrations themselves seeded.
 */
export interface SchemaSnapshot {
  readonly objects: readonly string[];
  readonly hasSequenceTable: boolean;
  readonly seededRows: ReadonlyArray<{
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: ReadonlyArray<Record<string, SQLInputValue>>;
  }>;
}

export type DatabaseDescription = Record<string, unknown>;

function plainRows(rows: unknown[]): Array<Record<string, unknown>> {
  return (rows as Array<Record<string, unknown>>).map((row) => Object.fromEntries(Object.entries(row)));
}

function plainRow(row: unknown): Record<string, unknown> | undefined {
  if (row === undefined) return undefined;
  return Object.fromEntries(Object.entries(row as Record<string, unknown>));
}

/**
 * Everything SQLite exposes about a finished schema, including seeded rows.
 * Captured beside the compact rebuild snapshot in global setup so the fidelity
 * test compares against the real replay without replaying 95 migrations again
 * inside a contended test worker.
 */
export function describeDatabase(database: DatabaseSync): DatabaseDescription {
  const described: DatabaseDescription = {
    schema: plainRows(database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    ).all()),
    foreignKeysEnforced: plainRow(database.prepare("PRAGMA foreign_keys").get()),
  };
  const tables = (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  for (const table of tables) {
    described[`${table}::columns`] = plainRows(database.prepare(`PRAGMA table_info("${table}")`).all());
    described[`${table}::foreign-keys`] = plainRows(database.prepare(`PRAGMA foreign_key_list("${table}")`).all());
    described[`${table}::indexes`] = plainRows(database.prepare(`PRAGMA index_list("${table}")`).all());
    described[`${table}::rows`] = plainRows(database.prepare(`SELECT * FROM "${table}"`).all());
  }
  return described;
}

/**
 * Replaying every checked-in migration costs ~800ms, and the suite asks for a
 * fresh database once per test — which was the whole runtime of the Node suite,
 * not a part of it. The migrations spend that time rebuilding the same tables
 * over and over: every `ALTER`, every copy-into-a-new-shape-and-rename, every
 * index dropped and recreated a dozen files later. None of that history is
 * observable once the last file has run; only the shape it ends in is.
 *
 * So the sequence runs once per run, in `test/global-setup.ts`, and the *result*
 * is what gets reproduced per test — the surviving `sqlite_master` entries
 * replayed directly against an empty database, which lands in ~7ms. Once per
 * *run* rather than per worker: Vitest gives each file its own module registry,
 * so a cache living in this module would be rebuilt by every file that opens a
 * database. See `migrated-schema-snapshots.ts`.
 *
 * The schema is still derived from the checked-in migrations on every run rather
 * than transcribed into a fixture, so it cannot drift from them: a migration
 * that changes a column changes this snapshot in the same run, with nothing to
 * keep in sync.
 */
export function captureSchemaSnapshot(template: DatabaseSync): SchemaSnapshot {
  // An FTS5 table is declared once and brings its own `_data`/`_idx`/`_config`
  // storage, which SQLite creates — and pre-populates — as a side effect of the
  // `CREATE VIRTUAL TABLE`. Those shadow tables are listed in `sqlite_master`
  // like any other, so replaying them would try to create what the virtual
  // table has already made. Declare the virtual table and let it build its own.
  const virtualTables = (template.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  // Only a table is ever shadow storage. The prefix also matches the triggers
  // that keep an external-content index in step with its base table
  // (`memory_items_fts_insert` and friends), and those are ours to replay.
  const isShadowTable = (type: string, name: string): boolean =>
    type === "table" && virtualTables.some((owner) => name !== owner && name.startsWith(`${owner}_`));

  // Tables before the indexes and triggers that attach to them; original
  // creation order within each group, since a trigger may reference a table
  // created later in the sequence. `sqlite_%` entries are SQLite's own — it
  // rejects a direct `CREATE` of them and makes them itself where they belong.
  const objects = (template.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, rowid`,
  ).all() as Array<{ type: string; name: string; sql: string }>)
    .filter(({ type, name }) => !isShadowTable(type, name))
    .map(({ sql }) => sql);

  const hasSequenceTable = template.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
  ).get() !== undefined;

  const seededRows: Array<{ table: string; columns: string[]; rows: Array<Record<string, SQLInputValue>> }> = [];
  const tables = (template.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  ).all() as Array<{ name: string }>)
    .map(({ name }) => name)
    .filter((name) => !isShadowTable("table", name) && !virtualTables.includes(name));
  for (const table of tables) {
    const rows = template.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, SQLInputValue>>;
    const firstRow = rows[0];
    if (!firstRow) continue;
    seededRows.push({ table, columns: Object.keys(firstRow), rows });
  }
  return { objects, hasSequenceTable, seededRows };
}

export function databaseFromSnapshot(snapshot: SchemaSnapshot): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  // Off while the shape is laid down: the objects go back in dependency order
  // for triggers, but a table's foreign keys may still point at one that has not
  // been recreated yet, exactly as during the migration run this reproduces.
  database.exec("PRAGMA foreign_keys = OFF");
  if (snapshot.hasSequenceTable) {
    // A migration created an AUTOINCREMENT table and a later one dropped it,
    // leaving this behind. It cannot be created directly, so earn it the same
    // way and leave the empty table the migrations leave.
    database.exec("CREATE TABLE autoincrement_sequence_seed (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    database.exec("DROP TABLE autoincrement_sequence_seed");
  }
  for (const sql of snapshot.objects) database.exec(sql);
  for (const { table, columns, rows } of snapshot.seededRows) {
    const statement = database.prepare(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) statement.run(...columns.map((column) => row[column] as SQLInputValue));
  }
  // On, unconditionally, because that is the state a replay ends in: seven of
  // the migrations set this pragma themselves, so the sequence leaves foreign
  // keys enforced no matter what the caller opened the connection with. The
  // fixtures that never wrote the pragma were still getting enforcement.
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

/** The migrated shapes this module can hand out. */
export type SqliteTemplateVariant = "regional" | "pre-retirement" | "legacy-product";

/**
 * Runs the migrations for real, the slow way.
 *
 * Exported so the snapshot fidelity test can hold the replayed database next to
 * a rebuilt one and diff them. Nothing else should call it: a test wanting a
 * database wants {@link migratedSqliteDatabase}, which is the same shape in a
 * hundredth of the time.
 */
export function buildTemplateDatabase(variant: SqliteTemplateVariant): DatabaseSync {
  if (variant === "regional") return migrateSqliteDatabase();
  const database = migrateSqliteDatabase("0089_confine_legacy_bookkeeping_triggers.sql");
  // This shape stands in for a workspace object database in service fixtures,
  // so object-schema changes to the domain tables land here too. Without them a
  // fixture is a snapshot of D1 as it stood at 0089 rather than of the object
  // the code under test actually writes to.
  for (const statement of SLACK_REACTION_COLUMN_STATEMENTS) database.exec(statement);
  if (variant === "legacy-product") return database;
  // These tables crossed the workspace/work-stream boundary in D1. The object
  // import keeps the opaque ids but cannot retain SQLite foreign keys into a
  // different object database. Migration 0090 used to rebuild this same set
  // before deleting only the work-stream half; the compatibility fixture keeps
  // that post-import shape while the real regional fixture applies all of 0090.
  detachImportedWorkstreamForeignKeys(database);
  return database;
}

function detachImportedWorkstreamForeignKeys(database: DatabaseSync): void {
  const tables = [
    "artifacts",
    "memory_mutations",
    "memory_table_mutations",
    "work_opportunities",
    "digest_deliveries",
  ];
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const table of tables) {
      const tableRow = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) as { sql: string } | undefined;
      if (!tableRow) continue;
      const dependents = database.prepare(
        `SELECT sql FROM sqlite_master
          WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
          ORDER BY type, name`,
      ).all(table) as Array<{ sql: string }>;
      const columns = (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
        .join(", ");
      const rebuilt = `${table}_object_compat`;
      const create = tableRow.sql
        .replace(`CREATE TABLE ${table}`, `CREATE TABLE ${rebuilt}`)
        .replace(
          /\s+REFERENCES\s+(?:harness_runs|messages)\s*\([^)]*\)\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL)/giu,
          "",
        );
      database.exec("BEGIN");
      try {
        database.exec(create);
        database.exec(`INSERT INTO "${rebuilt}" (${columns}) SELECT ${columns} FROM "${table}"`);
        database.exec(`DROP TABLE "${table}"`);
        database.exec(`ALTER TABLE "${rebuilt}" RENAME TO "${table}"`);
        for (const dependent of dependents) database.exec(dependent.sql);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
