import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestD1Results } from "./cloudflare-test";
import { databaseFromSnapshot } from "./migrated-schema";
import { migratedSchemaSnapshot } from "./migrated-schema-snapshots";

/** Applies every checked-in migration to a fresh regional D1 database. */
export function migratedSqliteDatabase(): DatabaseSync {
  return databaseFromSnapshot(migratedSchemaSnapshot("regional"));
}

/** Focused query fixture combining the independently migrated identity and observability schemas. */
export function migratedObservabilityFixture(): DatabaseSync {
  const database = migratedSqliteDatabase();
  for (const directory of ["telemetry-migrations", "audit-migrations"]) {
    database.exec(readFileSync(new URL(`../../../../packages/db/${directory}/0001_initial.sql`, import.meta.url), "utf8"));
  }
  return database;
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
  return databaseFromSnapshot(migratedSchemaSnapshot("legacy-product"));
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
  return databaseFromSnapshot(migratedSchemaSnapshot("pre-retirement"));
}

/** The narrow slice of the D1 surface the services under test use. */
/** D1's per-statement bound-parameter ceiling — the engine's, not a choice here. */
const D1_BOUND_PARAMETER_LIMIT = 100;

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
        // D1 refuses a statement past its bound-parameter ceiling, and
        // `node:sqlite` does not (its own limit is in the tens of thousands),
        // so a read that expands an id list into `IN (?, …)` without chunking
        // passes here and fails in production. Refuse the way D1 does; the
        // limit is the engine's (`durable-objects/bound-parameters.ts`).
        if (next.length > D1_BOUND_PARAMETER_LIMIT) {
          throw new Error(`D1_ERROR: too many SQL variables: ${next.length} bound, ${D1_BOUND_PARAMETER_LIMIT} allowed`);
        }
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
