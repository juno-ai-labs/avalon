import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redeemDownloadGrant } from '@rally/db/private-access';
import { DownloadGrantResultSchema } from '@rally/contracts/private-access';
import worker from '../../ace/src/index';
import { createTestEnv } from '../../ace/test/helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

let database: DatabaseSync;
beforeEach(() => { database = migratedSqliteDatabase(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z')); });
afterEach(() => { database.close(); vi.useRealTimers(); });
function request(path: string, init: RequestInit = {}, authenticated = true) {
  return worker.fetch(new Request(`https://ace.test/api/access${path}`, init), createTestEnv({
    GLOBAL_DB: sqliteD1(database), APP_ENV: authenticated ? 'development' : 'production', ACE_DEV_AUTH: 'true',
  }));
}
describe('Ace private access', () => {
  it('admits operators to a shared usable grant but never includes tokens in the request list', async () => {
    const response = await request('/downloads', { method: 'POST', headers: { origin: 'https://ace.test', 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(201);
    const grant = DownloadGrantResultSchema.parse(await response.json());
    expect(grant.expiresAt).toBeNull();
    const token = new URLSearchParams(new URL(grant.url).hash.slice(1)).get('token')!;
    expect(await redeemDownloadGrant(sqliteD1(database), token)).toBe(true);
    expect(await redeemDownloadGrant(sqliteD1(database), token)).toBe(false);
    expect(await (await request('/requests')).json()).toEqual({ requests: [], nextCursor: null });
    expect(JSON.stringify(database.prepare('SELECT * FROM download_grants').all())).not.toContain(token);
  });

  it('issues a timed bearer link and normalizes its chosen offset to UTC', async () => {
    const response = await request('/downloads', { method: 'POST', headers: { origin: 'https://ace.test', 'content-type': 'application/json' }, body: JSON.stringify({ expiresAt: '2026-09-09T10:00:00-04:00' }) });
    expect(response.status).toBe(201);
    const grant = DownloadGrantResultSchema.parse(await response.json());
    expect(grant.expiresAt).toBe('2026-09-09T14:00:00.000Z');
    const token = new URLSearchParams(new URL(grant.url).hash.slice(1)).get('token')!;
    expect(await redeemDownloadGrant(sqliteD1(database), token)).toBe(true);
    expect(await redeemDownloadGrant(sqliteD1(database), token)).toBe(true);
    vi.setSystemTime(new Date('2026-09-09T14:00:00.000Z'));
    expect(await redeemDownloadGrant(sqliteD1(database), token)).toBe(false);
  });

  it('rejects malformed, ambiguous, current and past expiries without issuing grants', async () => {
    for (const expiresAt of ['invalid', '2026-09-10T12:00:00', '2026-09-09T12:00:00.000Z', '2026-09-08T12:00:00.000Z']) {
      const response = await request('/downloads', { method: 'POST', headers: { origin: 'https://ace.test', 'content-type': 'application/json' }, body: JSON.stringify({ expiresAt }) });
      expect(response.status).toBe(400);
    }
    expect(database.prepare('SELECT * FROM download_grants').all()).toEqual([]);
  });

  it('rejects missing Access and cross-origin writes before issuing any grants', async () => {
    expect((await request('/requests', {}, false)).status).toBe(403);
    expect((await request('/downloads', { method: 'POST', headers: { origin: 'https://untrusted.test', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect(database.prepare('SELECT * FROM download_grants').all()).toEqual([]);
  });

  it('rejects a nonexistent request association', async () => {
    expect((await request('/downloads', { method: 'POST', headers: { origin: 'https://ace.test', 'content-type': 'application/json' }, body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000001' }) })).status).toBe(404);
    expect(database.prepare('SELECT * FROM download_grants').all()).toEqual([]);
  });
});
