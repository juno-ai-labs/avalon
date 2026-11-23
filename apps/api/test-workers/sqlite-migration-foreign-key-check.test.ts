/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from '../src/durable-objects/sqlite-migrations';

const PARENT_AND_CHILD: DurableObjectSqliteMigration = {
  version: 1,
  description: 'a parent and a child that references it',
  statements: [
    `CREATE TABLE parent (id TEXT PRIMARY KEY)`,
    `CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))`,
  ],
};

/** Record statements and the actual row counts supplied by workerd. */
function recording(storage: DurableObjectStorage) {
  const statements: string[] = [];
  const probes: { rowsRead: number; rowsWritten: number }[] = [];
  const sql = new Proxy(storage.sql, {
    get(target, property) {
      if (property === 'exec') {
        return (query: string, ...bindings: unknown[]) => {
          statements.push(query.trim());
          const cursor = target.exec(query, ...(bindings as SqlStorageValue[]));
          if (/^EXPLAIN\s/iu.test(query)) {
            probes.push(cursor);
          }
          return cursor;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(storage, {
    get(target, property) {
      if (property === 'sql') return sql;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: wrapped, statements, probes };
}

it('does not scan the whole database for orphans after an ordinary group, which SQLite enforced immediately', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('foreign-key-check-enforced');
  await stub.ping();

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: [PARENT_AND_CHILD], component: 'probe', workerVersionId: 'v1', now: 1 });
    state.storage.sql.exec(`INSERT INTO parent (id) VALUES ('p')`);
    state.storage.sql.exec(`INSERT INTO child (id, parent_id) VALUES ('c', 'p')`);
  });

  await runInDurableObject(stub, (_instance, state) => {
    const { storage, statements, probes } = recording(state.storage);
    applyDurableObjectSqliteMigrations({
      storage,
      migrations: [PARENT_AND_CHILD, { version: 2, description: 'a column', statements: [`ALTER TABLE child ADD COLUMN note TEXT`] }],
      component: 'probe',
      workerVersionId: 'v2',
      now: 2,
    });
    expect(statements.filter((statement) => /^PRAGMA foreign_key_check/iu.test(statement))).toEqual([]);
    expect(probes.map(({ rowsRead, rowsWritten }) => ({ rowsRead, rowsWritten })))
      .toEqual([{ rowsRead: 0, rowsWritten: 0 }]);
    expect(state.storage.sql.exec(`SELECT MAX(version) AS version FROM _sql_schema_migrations`).one()).toEqual({ version: 2 });
  });

  // What makes skipping it safe: an enforced group that would orphan a row
  // never commits, and leaves no receipt behind.
  await runInDurableObject(stub, (_instance, state) => {
    expect(() => applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: [
        PARENT_AND_CHILD,
        { version: 2, description: 'a column', statements: [`ALTER TABLE child ADD COLUMN note TEXT`] },
        { version: 3, description: 'an orphan', statements: [`INSERT INTO child (id, parent_id) VALUES ('orphan', 'missing')`] },
      ],
      component: 'probe',
      workerVersionId: 'v3',
      now: 3,
    })).toThrow(/probe_schema_migration_statement_failed:3:0:.*FOREIGN KEY constraint failed/);
    expect(state.storage.sql.exec(`SELECT MAX(version) AS version FROM _sql_schema_migrations`).one()).toEqual({ version: 2 });
    expect(state.storage.sql.exec(`SELECT id FROM child ORDER BY id`).toArray()).toEqual([{ id: 'c' }]);
  });
});

it('rolls back a dropped parent key and its migration receipt', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('foreign-key-check-dropped-index');
  await stub.ping();
  const initial: DurableObjectSqliteMigration = {
    version: 1,
    description: 'a child referencing a separately indexed parent key',
    statements: [
      `CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT NOT NULL)`,
      `CREATE UNIQUE INDEX parent_code ON parent(code)`,
      `CREATE TABLE "child""records" (parent_code TEXT NOT NULL REFERENCES parent(code))`,
      `INSERT INTO parent VALUES (1, 'kept')`,
      `INSERT INTO "child""records" VALUES ('kept')`,
    ],
  };

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: [initial],
      component: 'probe',
      workerVersionId: 'v1',
    });
  });

  await runInDurableObject(stub, (_instance, state) => {
    expect(() => applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: [initial, { version: 2, description: 'drop the referenced index', statements: ['DROP INDEX parent_code'] }],
      component: 'probe',
      workerVersionId: 'v2',
    })).toThrow('probe_schema_foreign_key_definition_invalid:child"records');
  });

  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    expect(sql.exec('SELECT version FROM _sql_schema_migrations').toArray()).toEqual([{ version: 1 }]);
    expect(sql.exec(`SELECT name FROM sqlite_schema WHERE name = 'parent_code'`).one()).toEqual({ name: 'parent_code' });
    expect(sql.exec('SELECT parent_code FROM "child""records"').one()).toEqual({ parent_code: 'kept' });
    sql.exec('INSERT INTO "child""records" VALUES (?)', 'kept');
  });
});

it.each([
  { name: 'missing parent', statements: ['CREATE TABLE broken (value REFERENCES missing(id))'] },
  { name: 'missing parent column', statements: ['CREATE TABLE broken (value REFERENCES parent(missing))'] },
  { name: 'wrong composite key arity', statements: [
    'CREATE TABLE composite (a TEXT, b TEXT, PRIMARY KEY (a, b))',
    'CREATE TABLE broken (value REFERENCES composite)',
  ] },
  { name: 'wrong collation', statements: [
    'CREATE TABLE collated (code TEXT)',
    'CREATE UNIQUE INDEX collated_code ON collated(code COLLATE NOCASE)',
    'CREATE TABLE broken (value REFERENCES collated(code))',
  ] },
])('rejects an empty child with $name and leaves no receipt', async ({ name, statements }) => {
  const stub = env.MIGRATION_PROBE_DO!.getByName(`foreign-key-check-${name}`);
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    const options = { storage: state.storage, component: 'probe', workerVersionId: 'v1' };
    applyDurableObjectSqliteMigrations({ ...options, migrations: [PARENT_AND_CHILD] });
    expect(() => applyDurableObjectSqliteMigrations({
      ...options,
      migrations: [PARENT_AND_CHILD, { version: 2, description: name, statements }],
    })).toThrow('probe_schema_foreign_key_definition_invalid:broken');
    expect(state.storage.sql.exec('SELECT version FROM _sql_schema_migrations').toArray()).toEqual([{ version: 1 }]);
    expect(state.storage.sql.exec(`SELECT name FROM sqlite_schema WHERE name = 'broken'`).toArray()).toEqual([]);
  });
});

it('still checks for orphans after a group that asked for enforcement off', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('foreign-key-check-disabled');
  await stub.ping();

  await runInDurableObject(stub, (_instance, state) => {
    const { storage, statements } = recording(state.storage);
    applyDurableObjectSqliteMigrations({
      storage,
      migrations: [{ ...PARENT_AND_CHILD, foreignKeys: 'disabled_during_rebuild' }],
      component: 'probe',
      workerVersionId: 'v1',
      now: 1,
    });
    expect(statements.filter((statement) => /^PRAGMA foreign_key_check/iu.test(statement))).toHaveLength(1);
  });
});

it('rolls back a group that hides an orphan behind deferred foreign keys, and leaves no receipt', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('foreign-key-check-deferred');
  await stub.ping();

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: [PARENT_AND_CHILD], component: 'probe', workerVersionId: 'v1', now: 1 });
  });

  // Turning deferral off discards the violations SQLite was holding for
  // commit, so only the runner's own check stands between this and a receipt.
  await runInDurableObject(stub, (_instance, state) => {
    expect(() => applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: [
        PARENT_AND_CHILD,
        {
          version: 2,
          description: 'an orphan written while deferred',
          statements: [
            'PRAGMA defer_foreign_keys = ON',
            `INSERT INTO child (id, parent_id) VALUES ('orphan', 'missing')`,
            'PRAGMA defer_foreign_keys = OFF',
          ],
        },
      ],
      component: 'probe',
      workerVersionId: 'v2',
      now: 2,
    })).toThrow('probe_schema_foreign_key_violation:child:parent');
    expect(state.storage.sql.exec(`SELECT MAX(version) AS version FROM _sql_schema_migrations`).one()).toEqual({ version: 1 });
    expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM child`).one()).toEqual({ count: 0 });
  });
});

it('refuses a migration that declares a foreign key deferred to commit, before running anything', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('foreign-key-check-deferrable');
  await stub.ping();

  await runInDurableObject(stub, (_instance, state) => {
    expect(() => applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: [
        PARENT_AND_CHILD,
        {
          version: 2,
          description: 'a deferred foreign key',
          statements: [`CREATE TABLE late (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`],
        },
      ],
      component: 'probe',
      workerVersionId: 'v1',
      now: 1,
    })).toThrow('probe_schema_deferred_foreign_key_forbidden:2');
    expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('parent', 'late')`).one()).toEqual({ count: 0 });
  });
});

it('validates foreign keys on an object that has used the key-value API, whose Cloudflare tables refuse reads', async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName('foreign-key-check-key-value');
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('key', 'value');
  });

  await runInDurableObject(stub, (_instance, state) => {
    expect(applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: [PARENT_AND_CHILD], component: 'probe', workerVersionId: 'v1', now: 1 })).toEqual([1]);
    expect(state.storage.sql.exec(`SELECT MAX(version) AS version FROM _sql_schema_migrations`).one()).toEqual({ version: 1 });
  });
});
