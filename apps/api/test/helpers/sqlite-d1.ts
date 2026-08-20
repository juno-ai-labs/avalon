import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestD1Results } from "./cloudflare-test";

const migrationsDirectory = fileURLToPath(new URL("../../../../packages/db/migrations/", import.meta.url));

/** Applies every checked-in migration to a fresh in-memory database. */
export function migratedSqliteDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  return database;
}

/** The narrow slice of the D1 surface the services under test use. */
export function sqliteD1(database: DatabaseSync): D1Database {
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T>() {
        return (database.prepare(sql).get(...values as SQLInputValue[]) as T | undefined) ?? null;
      },
      async all<T>() {
        // The runtime-database routers issue every statement through `.all()`,
        // and their callers read `meta.changes` off mutations — report it the
        // way D1 does instead of a flat zero.
        if (!/^\s*(?:SELECT|WITH)/iu.test(sql) && !/\bRETURNING\b/iu.test(sql)) {
          const result = database.prepare(sql).run(...values as SQLInputValue[]);
          return createTestD1Result<T>({
            success: true,
            results: [],
            meta: { changes: Number(result.changes) },
          });
        }
        return createTestD1Result<T>({
          success: true,
          results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        });
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as SQLInputValue[]);
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
