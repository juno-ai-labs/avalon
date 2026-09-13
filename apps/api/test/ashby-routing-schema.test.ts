import { afterEach, describe, expect, it } from 'vitest';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestEnv } from './helpers/cloudflare-test';
import { registerAshbyRoute } from '../src/services/ashby-routing-service';

const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe('Ashby routing against checked-in regional migrations', () => {
  it('refuses cross-region route replacement without changing the existing route status', async () => {
    const database = migratedSqliteDatabase(); databases.push(database);
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global' });
    const connectionId = crypto.randomUUID();
    await registerAshbyRoute(env, { connectionId, region: 'eu', status: 'active' });
    const before = database.prepare('SELECT * FROM ashby_connection_routes WHERE connection_id = ?').get(connectionId);
    await expect(registerAshbyRoute(env, { connectionId, region: 'global', status: 'disabled' })).rejects.toMatchObject({ code: 'ashby_route_conflict', status: 409 });
    expect(database.prepare('SELECT * FROM ashby_connection_routes WHERE connection_id = ?').get(connectionId)).toEqual(before);
    await registerAshbyRoute(env, { connectionId, region: 'eu', status: 'disabled' });
    expect(database.prepare('SELECT region, status FROM ashby_connection_routes WHERE connection_id = ?').get(connectionId)).toEqual({ region: 'eu', status: 'disabled' });
  });

  it('enforces the migrated route region and status domains', () => {
    const database = migratedSqliteDatabase(); databases.push(database);
    const insert = database.prepare('INSERT INTO ashby_connection_routes VALUES (?, ?, ?, ?)');
    expect(() => insert.run(crypto.randomUUID(), 'unknown', 'active', new Date().toISOString())).toThrow(/CHECK constraint/u);
    expect(() => insert.run(crypto.randomUUID(), 'global', 'unknown', new Date().toISOString())).toThrow(/CHECK constraint/u);
  });
});
