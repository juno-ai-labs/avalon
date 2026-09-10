import { mockAccessMail } from './helpers/access-providers';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, HonoAppEnv } from '../src/env';
import { privateAccessRoutes } from '../src/routes/private-access';
import { errorHandler } from '../src/middleware/errors';
import { admitAccessRequest } from '../src/services/access-request-limits';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

let database: DatabaseSync;
let env: Env;
const app = new Hono<HonoAppEnv>().route('/access', privateAccessRoutes).onError(errorHandler);
const start = Date.parse('2026-09-09T12:00:00.000Z');
function submit(email = 'security@example.com') {
  return app.request('https://api.rallywith.ai/access/requests', { method: 'POST',
    headers: { origin: 'https://rallywith.ai', 'content-type': 'application/json' },
    body: JSON.stringify({ email, turnstileToken: 'test-challenge' }),
  }, env);
}
beforeEach(() => {
  database = migratedSqliteDatabase();
  env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global', APP_ENV: 'production',
    PUBLIC_API_BASE_URL: 'https://api.rallywith.ai', ALLOWED_ORIGINS: 'https://rallywith.ai', TURNSTILE_SECRET_KEY: 'test-turnstile-key', RESEND_API_KEY: 'test-not-a-key' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
});
afterEach(() => { database.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('early-access abuse regressions against real migrations', () => {
  it('admits only one provider call while a duplicate acknowledgement is in flight', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const provider = mockAccessMail()
      .mockImplementationOnce(async () => { await held; return Response.json({ id: 'first' }); })
      .mockImplementation(async () => Response.json({ id: 'duplicate' }));
    // Both real SELECTs see pending before either UPDATE may claim it. This
    // proves the conditional write, not just the early return for sending rows.
    let reads = 0;
    let releaseReads!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT id, acknowledgement_subject')) {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => {
          const row = await first<T>();
          if (++reads === 2) releaseReads();
          await readBarrier;
          return row;
        };
      }
      return statement;
    });
    const submissions = [submit(), submit()];
    try {
      expect((await Promise.race(submissions)).status).toBe(202);
      expect(reads).toBe(2);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally { release(); await Promise.all(submissions); }
    expect(database.prepare('SELECT acknowledgement_status FROM access_requests').get())
      .toEqual({ acknowledgement_status: 'sent' });
  });

  it('does not resend an uncertain acknowledgement outside the provider deduplication window', async () => {
    const provider = mockAccessMail().mockRejectedValueOnce(new Error('connection lost after send'))
      .mockImplementation(async () => Response.json({ id: 'duplicate' }));
    expect((await submit()).status).toBe(502);
    vi.setSystemTime(start + 24 * 60 * 60 * 1000);
    const repeat = await submit();
    expect(repeat.status).toBe(503);
    expect(await repeat.json()).toMatchObject({ error: { code: 'access_email_review_required' } });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(database.prepare('SELECT acknowledgement_status FROM access_requests').get())
      .toEqual({ acknowledgement_status: 'review_required' });
  });

  it('does not let an older in-flight rate admission rewind the current IP bucket', async () => {
    expect(await admitAccessRequest(env, '192.0.2.1', 1, start + 3_600_000)).toBe(true);
    expect(await admitAccessRequest(env, '192.0.2.1', 1, start)).toBe(false);
    expect(await admitAccessRequest(env, '192.0.2.1', 1, start + 3_600_000)).toBe(false);
  });

  it.each(['api.with-avalon.com', 'github.with-avalon.com'])('does not expose acquisition through the alternate host %s', async (host) => {
    const provider = mockAccessMail().mockImplementation(async () => Response.json({ id: 'unused' }));
    const response = await app.request(`https://${host}/access/requests`, { method: 'POST',
      headers: { origin: 'https://rallywith.ai', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unwanted@example.com' }),
    }, env);
    expect(response.status).toBe(404);
    expect(database.prepare('SELECT count(*) AS count FROM access_requests').get()).toEqual({ count: 0 });
    expect(provider).not.toHaveBeenCalled();
  });

  it('refuses non-JSON signup bodies before storing an address or contacting the provider', async () => {
    const provider = mockAccessMail().mockImplementation(async () => Response.json({ id: 'unused' }));
    const response = await app.request('https://api.rallywith.ai/access/requests', { method: 'POST',
      headers: { origin: 'https://rallywith.ai', 'content-type': 'text/plain' },
      body: JSON.stringify({ email: 'unwanted@example.com' }),
    }, env);
    expect(response.status).toBe(400);
    expect(database.prepare('SELECT count(*) AS count FROM access_requests').get()).toEqual({ count: 0 });
    expect(provider).not.toHaveBeenCalled();
  });
});
