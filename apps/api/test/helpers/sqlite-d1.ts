import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

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
        return {
          success: true,
          results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        } as unknown as D1Result<T>;
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as SQLInputValue[]);
        return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<T>;
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return {
    prepare,
    // D1 runs a batch as one transaction, and code under test relies on that:
    // a pair written to be all-or-nothing is only all-or-nothing here if the
    // shim rolls back too. Replaying the statements in a loop would let a test
    // pass over a half-applied batch that production would never produce.
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<unknown>[] = [];
      database.exec("BEGIN");
      try {
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return results as D1Result<T>[];
    },
  } as unknown as D1Database;
}
