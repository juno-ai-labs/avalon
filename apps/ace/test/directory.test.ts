import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { searchUsers, searchWorkspaces } from '../src/directory';
import { createTestD1Database, createTestEnv } from './helpers/cloudflare-test';

const databases: DatabaseSync[] = [];

function database(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE users (platform_user_id TEXT, email TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL);
  `);
  return createTestD1Database({
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        all: async <T>() => ({
          results: sqlite.prepare(sql).all(...values as never[]) as T[],
          success: true,
          meta: {},
        }),
      }),
    }),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  });
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('Ace directory lookup', () => {
  it('matches ASCII names case-insensitively and treats wildcard characters literally', async () => {
    const global = database();
    const eu = database();
    await global.exec(`
      INSERT INTO users VALUES ('user-1', 'PM+Flags@Example.com', 'Casey_100%');
      INSERT INTO users VALUES ('user-2', 'different@example.com', 'CaseyX1000');
      INSERT INTO workspaces VALUES ('workspace-1', 'Launch_100%', 'launch-special');
      INSERT INTO workspaces VALUES ('workspace-2', 'LaunchX1000', 'launch-other');
    `);
    const env = createTestEnv({ GLOBAL_DB: global, EU_DB: eu });

    await expect(searchUsers(env, 'pm+flags@example.com')).resolves.toMatchObject([
      { id: 'user-1', region: 'global' },
    ]);
    await expect(searchUsers(env, 'Casey_100%')).resolves.toMatchObject([
      { id: 'user-1', region: 'global' },
    ]);
    await expect(searchWorkspaces(env, 'Launch_100%')).resolves.toMatchObject([
      { id: 'workspace-1', region: 'global' },
    ]);
  });
});
