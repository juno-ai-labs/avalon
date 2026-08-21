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
  return migrateSqliteDatabase();
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
  const database = migrateSqliteDatabase("0089_confine_legacy_bookkeeping_triggers.sql");
  // These tables crossed the workspace/work-stream boundary in D1. The object
  // import keeps the opaque ids but cannot retain SQLite foreign keys into a
  // different object database. Migration 0090 used to rebuild this same set
  // before deleting only the work-stream half; the compatibility fixture keeps
  // that post-import shape while the real regional fixture applies all of 0090.
  detachImportedWorkstreamForeignKeys(database);
  return database;
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
