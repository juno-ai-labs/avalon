import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  applyDurableObjectSqliteMigrations,
  durableObjectMigrationHash,
  type DurableObjectSqliteMigration,
} from "../src/durable-objects/sqlite-migrations";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const MIGRATIONS: readonly DurableObjectSqliteMigration[] = [
  {
    version: 1,
    description: "create messages",
    statements: [`CREATE TABLE messages(id TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT`],
  },
  {
    version: 2,
    description: "index message content",
    statements: [`CREATE INDEX messages_content_idx ON messages(content)`],
  },
];

function storageFor(database: DatabaseSync, kvCall = vi.fn()): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    get: async () => { kvCall("get"); throw new Error("kv_get_forbidden"); },
    put: async () => { kvCall("put"); throw new Error("kv_put_forbidden"); },
    delete: async () => { kvCall("delete"); throw new Error("kv_delete_forbidden"); },
    list: async () => { kvCall("list"); throw new Error("kv_list_forbidden"); },
    transaction: async () => { kvCall("transaction"); throw new Error("kv_transaction_forbidden"); },
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

describe("Durable Object SQLite migrations", () => {
  it("applies an append-only history idempotently without any KV calls", () => {
    const database = new DatabaseSync(":memory:");
    const kvCall = vi.fn();
    try {
      const storage = storageFor(database, kvCall);
      expect(applyDurableObjectSqliteMigrations({
        storage,
        migrations: MIGRATIONS,
        component: "test_do",
        workerVersionId: "worker-one",
        now: 1_000,
      })).toEqual([1, 2]);
      expect(applyDurableObjectSqliteMigrations({
        storage,
        migrations: MIGRATIONS,
        component: "test_do",
        workerVersionId: "worker-two",
        now: 2_000,
      })).toEqual([]);

      expect(kvCall).not.toHaveBeenCalled();
      expect(database.prepare(
        `SELECT version, description, worker_version_id, applied_at
           FROM _sql_schema_migrations ORDER BY version`,
      ).all()).toEqual([
        { version: 1, description: "create messages", worker_version_id: "worker-one", applied_at: 1_000 },
        { version: 2, description: "index message content", worker_version_id: "worker-one", applied_at: 1_000 },
      ]);
      expect(database.prepare("PRAGMA index_list(messages)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "messages_content_idx" })]));
    } finally {
      database.close();
    }
  });

  it("fails closed when an already-applied migration is edited", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: MIGRATIONS,
        component: "test_do",
        workerVersionId: "worker-one",
      });
      const changed = [{
        ...MIGRATIONS[0]!,
        statements: [`CREATE TABLE messages(id TEXT PRIMARY KEY, content BLOB NOT NULL) STRICT`],
      }, MIGRATIONS[1]!];
      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: changed,
        component: "test_do",
        workerVersionId: "worker-two",
      })).toThrow("test_do_schema_hash_mismatch:1");
    } finally {
      database.close();
    }
  });

  it("rebuilds referenced parent tables without deleting or orphaning children", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      const history: readonly DurableObjectSqliteMigration[] = [
        {
          version: 1,
          description: "create referenced parent and child",
          statements: [
            `CREATE TABLE parent(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
            `CREATE TABLE child(
               id TEXT PRIMARY KEY,
               parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE
             ) STRICT`,
          ],
        },
        {
          version: 2,
          description: "rebuild referenced parent",
          foreignKeys: "disabled_during_rebuild",
          statements: [
            `CREATE TABLE parent_v2(id TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL) STRICT`,
            `INSERT INTO parent_v2 SELECT id, value, 1 FROM parent`,
            `CREATE TABLE child_v2(
               id TEXT PRIMARY KEY,
               parent_id TEXT NOT NULL REFERENCES parent_v2(id) ON DELETE CASCADE
             ) STRICT`,
            `INSERT INTO child_v2 SELECT * FROM child`,
            // A forward rebuild must be valid with enforcement on. Move the
            // cascading child first instead of relying on the legacy mode.
            `DROP TABLE child`,
            `DROP TABLE parent`,
            `ALTER TABLE parent_v2 RENAME TO parent`,
            `ALTER TABLE child_v2 RENAME TO child`,
          ],
        },
      ];
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: history.slice(0, 1),
        component: "test_do",
        workerVersionId: "worker-one",
      });
      database.exec(`INSERT INTO parent VALUES ('parent-1', 'preserved')`);
      database.exec(`INSERT INTO child VALUES ('child-1', 'parent-1')`);

      expect(applyDurableObjectSqliteMigrations({
        storage,
        migrations: history,
        component: "test_do",
        workerVersionId: "worker-two",
      })).toEqual([2]);

      expect(database.prepare(`SELECT * FROM parent`).all()).toEqual([
        { id: "parent-1", value: "preserved", revision: 1 },
      ]);
      expect(database.prepare(`SELECT * FROM child`).all()).toEqual([
        { id: "child-1", parent_id: "parent-1" },
      ]);
      expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
      expect(database.prepare(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
    } finally {
      database.close();
    }
  });

  it("does not toggle foreign-key enforcement when every rebuild is already receipted", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      const history: readonly DurableObjectSqliteMigration[] = [{
        version: 1,
        description: "create table under rebuild mode",
        foreignKeys: "disabled_during_rebuild",
        statements: [`CREATE TABLE rebuilt(id TEXT PRIMARY KEY) STRICT`],
      }];
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: history,
        component: "test_do",
        workerVersionId: "worker-one",
      });
      database.exec("PRAGMA foreign_keys = OFF");
      const afterMigrations = vi.fn();

      expect(applyDurableObjectSqliteMigrations({
        storage,
        migrations: history,
        component: "test_do",
        workerVersionId: "worker-two",
        afterMigrations,
      })).toEqual([]);
      expect(afterMigrations).toHaveBeenCalledOnce();
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back an invalid foreign-key rebuild and restores enforcement", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      const history: readonly DurableObjectSqliteMigration[] = [
        {
          version: 1,
          description: "create parent and child",
          statements: [
            `CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT`,
            `CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id)) STRICT`,
          ],
        },
        {
          version: 2,
          description: "invalid rebuild",
          foreignKeys: "disabled_during_rebuild",
          statements: [
            `CREATE TABLE parent_v2(id TEXT PRIMARY KEY) STRICT`,
            `DROP TABLE parent`,
            `ALTER TABLE parent_v2 RENAME TO parent`,
          ],
        },
      ];
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: history.slice(0, 1),
        component: "test_do",
        workerVersionId: "worker-one",
      });
      database.exec(`INSERT INTO parent VALUES ('parent-1')`);
      database.exec(`INSERT INTO child VALUES ('child-1', 'parent-1')`);

      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: history,
        component: "test_do",
        workerVersionId: "worker-two",
      })).toThrow("test_do_schema_foreign_key_violation");

      expect(database.prepare(`SELECT * FROM parent`).all()).toEqual([{ id: "parent-1" }]);
      expect(database.prepare(`SELECT version FROM _sql_schema_migrations ORDER BY version`).all())
        .toEqual([{ version: 1 }]);
      expect(database.prepare(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
    } finally {
      database.close();
    }
  });

  it("resumes after a later migration group fails without replaying a committed group", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      const broken: readonly DurableObjectSqliteMigration[] = [
        {
          version: 1,
          description: "committed first group",
          statements: [`CREATE TABLE first_group(id TEXT PRIMARY KEY) STRICT`],
        },
        {
          version: 2,
          description: "broken rebuild group",
          foreignKeys: "disabled_during_rebuild",
          statements: [`INSERT INTO table_that_does_not_exist VALUES ('fail')`],
        },
      ];
      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: broken,
        component: "test_do",
        workerVersionId: "worker-broken",
      })).toThrow();
      expect(database.prepare(`SELECT version FROM _sql_schema_migrations`).all())
        .toEqual([{ version: 1 }]);

      const repaired: readonly DurableObjectSqliteMigration[] = [
        broken[0]!,
        {
          ...broken[1]!,
          statements: [`CREATE TABLE second_group(id TEXT PRIMARY KEY) STRICT`],
        },
      ];
      expect(applyDurableObjectSqliteMigrations({
        storage,
        migrations: repaired,
        component: "test_do",
        workerVersionId: "worker-repaired",
      })).toEqual([2]);
      expect(database.prepare(`SELECT version FROM _sql_schema_migrations ORDER BY version`).all())
        .toEqual([{ version: 1 }, { version: 2 }]);
      expect(database.prepare(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
    } finally {
      database.close();
    }
  });

  it("rejects code older than the database schema", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: MIGRATIONS,
        component: "test_do",
        workerVersionId: "worker-new",
      });
      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: MIGRATIONS.slice(0, 1),
        component: "test_do",
        workerVersionId: "worker-old",
      })).toThrow("test_do_schema_ahead:2");
    } finally {
      database.close();
    }
  });

  it("rolls back schema changes and the receipt together", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: [{
          version: 1,
          description: "partially invalid",
          statements: [
            `CREATE TABLE should_rollback(id INTEGER PRIMARY KEY) STRICT`,
            `THIS IS NOT SQL`,
          ],
        }],
        component: "test_do",
        workerVersionId: "worker-one",
      })).toThrow();
      expect(database.prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'should_rollback'`,
      ).get()).toBeUndefined();
      expect(database.prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '_sql_schema_migrations'`,
      ).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("validates ordering and forbids migration-owned transaction control", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: [MIGRATIONS[1]!, MIGRATIONS[0]!],
        component: "test_do",
        workerVersionId: "worker-one",
      })).toThrow("test_do_schema_versions_not_strictly_monotonic:1");
      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: [{ version: 1, description: "manual transaction", statements: ["BEGIN"] }],
        component: "test_do",
        workerVersionId: "worker-one",
      })).toThrow("test_do_schema_transaction_statement_forbidden:1");
      expect(() => applyDurableObjectSqliteMigrations({
        storage,
        migrations: [{
          version: 1,
          description: "invalid legacy execution mode",
          statements: ["SELECT 1"],
          legacyHashWithoutExecutionMode: true,
        }],
        component: "test_do",
        workerVersionId: "worker-one",
      })).toThrow("test_do_schema_legacy_execution_mode_invalid:1");
      expect(durableObjectMigrationHash(MIGRATIONS[0]!)).toEqual(
        durableObjectMigrationHash({ ...MIGRATIONS[0]!, description: "changed" }),
      );
      expect(durableObjectMigrationHash(MIGRATIONS[0]!)).not.toEqual(
        durableObjectMigrationHash({
          ...MIGRATIONS[0]!,
          statements: [`CREATE TABLE messages(id TEXT PRIMARY KEY) STRICT`],
        }),
      );
      expect(durableObjectMigrationHash(MIGRATIONS[0]!)).not.toEqual(
        durableObjectMigrationHash({
          ...MIGRATIONS[0]!,
          foreignKeys: "disabled_during_rebuild",
        }),
      );
    } finally {
      database.close();
    }
  });

  it("accepts the published pre-execution-mode hash only for its declared rebuild", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = storageFor(database);
      const published: DurableObjectSqliteMigration = {
        version: 1,
        description: "published before execution mode hashing",
        statements: [`CREATE TABLE rebuilt(id TEXT PRIMARY KEY) STRICT`],
      };
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: [published],
        component: "test_do",
        workerVersionId: "published-worker",
      });
      const declared: DurableObjectSqliteMigration = {
        ...published,
        foreignKeys: "disabled_during_rebuild",
        legacyHashWithoutExecutionMode: true,
      };
      expect(durableObjectMigrationHash(declared)).toBe(durableObjectMigrationHash(published));
      expect(applyDurableObjectSqliteMigrations({
        storage,
        migrations: [declared],
        component: "test_do",
        workerVersionId: "current-worker",
      })).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades the published WorkstreamRoom ledger shape without rewriting receipts", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE _sql_schema_migrations (
          version INTEGER PRIMARY KEY,
          implementation_hash TEXT NOT NULL,
          worker_version_id TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE messages(id TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
      `);
      database.prepare(
        `INSERT INTO _sql_schema_migrations
          (version, implementation_hash, worker_version_id, applied_at)
         VALUES (1, ?, 'published-worker', 500)`,
      ).run(durableObjectMigrationHash(MIGRATIONS[0]!));

      expect(applyDurableObjectSqliteMigrations({
        storage: storageFor(database),
        migrations: MIGRATIONS,
        component: "test_do",
        workerVersionId: "cutover-worker",
        now: 1_000,
      })).toEqual([2]);
      expect(database.prepare(
        `SELECT version, description, worker_version_id, applied_at
           FROM _sql_schema_migrations ORDER BY version`,
      ).all()).toEqual([
        {
          version: 1,
          description: "legacy migration receipt",
          worker_version_id: "published-worker",
          applied_at: 500,
        },
        {
          version: 2,
          description: "index message content",
          worker_version_id: "cutover-worker",
          applied_at: 1_000,
        },
      ]);
    } finally {
      database.close();
    }
  });

});
