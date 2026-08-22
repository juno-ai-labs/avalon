import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestD1Results } from "./cloudflare-test";

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
interface SchemaSnapshot {
  readonly objects: readonly string[];
  readonly hasSequenceTable: boolean;
  readonly seededRows: ReadonlyArray<{
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: ReadonlyArray<Record<string, SQLInputValue>>;
  }>;
}

/**
 * Replaying all 95 migrations costs ~800ms, and the suite asks for a fresh
 * database once per test — which was the whole runtime of the Node suite, not a
 * part of it. The migrations spend that time rebuilding the same tables over and
 * over: every `ALTER`, every copy-into-a-new-shape-and-rename, every index
 * dropped and recreated a dozen files later. None of that history is observable
 * once the last file has run; only the shape it ends in is.
 *
 * So the sequence runs once per worker process and the *result* is what gets
 * reproduced per test — the surviving `sqlite_master` entries replayed directly
 * against an empty database, which lands in ~7ms. The schema is still derived
 * from the checked-in migrations on every run rather than transcribed into a
 * fixture, so it cannot drift from them: a migration that changes a column
 * changes this snapshot in the same run, with nothing to keep in sync.
 */
function captureSchemaSnapshot(template: DatabaseSync): SchemaSnapshot {
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

function databaseFromSnapshot(snapshot: SchemaSnapshot): DatabaseSync {
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
  if (variant === "legacy-product") return database;
  // These tables crossed the workspace/work-stream boundary in D1. The object
  // import keeps the opaque ids but cannot retain SQLite foreign keys into a
  // different object database. Migration 0090 used to rebuild this same set
  // before deleting only the work-stream half; the compatibility fixture keeps
  // that post-import shape while the real regional fixture applies all of 0090.
  detachImportedWorkstreamForeignKeys(database);
  return database;
}

const schemaSnapshots = new Map<SqliteTemplateVariant, SchemaSnapshot>();

function snapshotOf(variant: SqliteTemplateVariant): SchemaSnapshot {
  const cached = schemaSnapshots.get(variant);
  if (cached) return cached;
  const template = buildTemplateDatabase(variant);
  try {
    const snapshot = captureSchemaSnapshot(template);
    schemaSnapshots.set(variant, snapshot);
    return snapshot;
  } finally {
    template.close();
  }
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

/** Applies every checked-in migration to a fresh regional D1 database. */
export function migratedSqliteDatabase(): DatabaseSync {
  return databaseFromSnapshot(snapshotOf("regional"));
}

/**
 * The product schema as it stood before 0090 dropped the legacy D1 tables, with
 * the foreign keys those tables declared still pointing where they did.
 *
 * A service fixture that seeds legacy product rows and drives the object
 * runtime over the same connection wants this rather than
 * {@link preRetirementProductSqliteDatabase}: it keeps the work-stream foreign
 * keys the import has to detach.
 *
 */
export function legacyProductSqliteDatabase(): DatabaseSync {
  return databaseFromSnapshot(snapshotOf("legacy-product"));
}

/**
 * The frozen SQL dialect imported into the Durable Objects before 0090 removes
 * its D1 source tables.
 *
 * Repository-focused tests use this only when they exercise compatibility SQL
 * that the object runtime rewrites onto object-local tables. It must never be
 * used to assert the current regional D1 topology; migration tests and
 * {@link migratedSqliteDatabase} own that boundary.
 */
export function preRetirementProductSqliteDatabase(): DatabaseSync {
  return databaseFromSnapshot(snapshotOf("pre-retirement"));
}

/** The narrow slice of the D1 surface the services under test use. */
export function sqliteD1(database: DatabaseSync): D1Database {
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;
  const legacyWorkstreamProductColumns = (database.prepare(
    "PRAGMA table_info(workstreams)",
  ).all() as Array<{ name: string }>).some((column) => column.name === "title");
  const minimalAnchorInsert = /^\s*INSERT OR IGNORE INTO workstreams\s*\(id, workspace_id, do_identity_anchor\)\s*VALUES \(\?, \?, 1\)\s*$/iu;
  const prepare = (sql: string) => {
    // A focused service fixture sometimes keeps the through-0089 product
    // tables in this one SQLite connection while the code under test correctly
    // writes the current three-column regional anchor. Supply only the legacy
    // table's required compatibility values; production never takes this path,
    // and final-schema tests use migratedSqliteDatabase instead.
    const executableSql = legacyWorkstreamProductColumns
      && minimalAnchorInsert.test(sql)
      ? `INSERT OR IGNORE INTO workstreams
           (id, workspace_id, title, objective, origin_type, harness_status,
            last_activity_at, created_at, updated_at, do_identity_anchor)
         VALUES (?, ?, '[test identity anchor]', '', 'ad_hoc', 'idle',
                 '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
                 '1970-01-01T00:00:00.000Z', 1)`
      : sql;
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T>() {
        return (database.prepare(executableSql).get(...values as SQLInputValue[]) as T | undefined) ?? null;
      },
      async all<T>() {
        // The runtime-database routers issue every statement through `.all()`,
        // and their callers read `meta.changes` off mutations — report it the
        // way D1 does instead of a flat zero.
        if (!/^\s*(?:SELECT|WITH)/iu.test(sql) && !/\bRETURNING\b/iu.test(sql)) {
          const result = database.prepare(executableSql).run(...values as SQLInputValue[]);
          return createTestD1Result<T>({
            success: true,
            results: [],
            meta: { changes: Number(result.changes) },
          });
        }
        return createTestD1Result<T>({
          success: true,
          results: database.prepare(executableSql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        });
      },
      async run<T>() {
        const result = database.prepare(executableSql).run(...values as SQLInputValue[]);
        return createTestD1Result<T>({ success: true, results: [], meta: { changes: Number(result.changes) } });
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({
    prepare,
    // D1 runs a batch as one transaction, and code under test relies on that:
    // a pair written to be all-or-nothing is only all-or-nothing here if the
    // shim rolls back too. Replaying the statements in a loop would let a test
    // pass over a half-applied batch that production would never produce.
    //
    // Batches are serialized behind one promise chain, and nested ones use a
    // savepoint rather than BEGIN. Both exist because production runs batches
    // concurrently — the migration campaign scrubs several workspaces at once,
    // each ending in a batch — while this shim holds a single connection, on
    // which a second BEGIN throws "cannot start a transaction within a
    // transaction". Without this the concurrent path simply could not be
    // tested, which is why it went untested.
    async batch<T>(statements: D1PreparedStatement[]) {
      const run = async () => {
        const results: D1Result<unknown>[] = [];
        const nested = depth > 0;
        const savepoint = `d1_batch_${depth}`;
        depth += 1;
        database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
        try {
          for (const statement of statements) results.push(await statement.run());
          database.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
        } catch (error) {
          database.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
          throw error;
        } finally {
          depth -= 1;
        }
        return createTestD1Results<T>(results);
      };
      const queued = tail.then(run, run);
      tail = queued.then(() => undefined, () => undefined);
      return queued;
    },
  });
}
