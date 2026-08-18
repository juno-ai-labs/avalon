import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { createCloudflareTestBinding } from "./cloudflare-test";

function isReadStatement(sql: string): boolean {
  return /^\s*(?:SELECT|PRAGMA\s+(?!foreign_keys\s*=)|WITH)\b/iu.test(sql);
}

/** Node SQLite adapter for object-local SqlStorage unit tests. */
export function createTestSqlStorage(database: DatabaseSync): SqlStorage {
  return createCloudflareTestBinding<SqlStorage>({
    exec: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
      let rows: T[] = [];
      let rowsWritten = 0;
      if (isReadStatement(query) || /\bRETURNING\b/iu.test(query)) {
        rows = database.prepare(query).all(...bindings as SQLInputValue[]) as T[];
        if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(query)) rowsWritten = rows.length;
      } else if (bindings.length > 0 || /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(query)) {
        const result = database.prepare(query).run(...bindings as SQLInputValue[]);
        rowsWritten = Number(result.changes);
      } else {
        database.exec(query);
      }
      let offset = 0;
      const cursor = {
        next: () => offset < rows.length
          ? { done: false as const, value: rows[offset++] as T }
          : { done: true as const },
        toArray: () => rows.slice(offset),
        one: () => {
          const row = rows[offset];
          if (!row || rows.length - offset !== 1) throw new Error("Expected exactly one SQL row");
          offset += 1;
          return row;
        },
        raw: function* () {
          for (const row of rows.slice(offset)) yield Object.values(row) as SqlStorageValue[];
        },
        columnNames: rows[0] ? Object.keys(rows[0]) : [],
        rowsRead: rows.length,
        rowsWritten,
        [Symbol.iterator]: function* () {
          while (offset < rows.length) yield rows[offset++] as T;
        },
      };
      return cursor as SqlStorageCursor<T>;
    },
    get databaseSize() {
      const pageCount = database.prepare("PRAGMA page_count").get() as { page_count: number };
      const pageSize = database.prepare("PRAGMA page_size").get() as { page_size: number };
      return pageCount.page_count * pageSize.page_size;
    },
  });
}
