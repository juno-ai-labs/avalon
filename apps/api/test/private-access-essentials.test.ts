import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_PAGE_SIZE } from '@rally/contracts/private-access';
import { issueDownloadGrant, redeemDownloadGrant } from '@rally/db/private-access';
import type { Env, HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { createPrivateAccessRoutes, privateAccessRoutes } from '../src/routes/private-access';
import { accessOperatorRoutes } from '../src/routes/access-operations';
import { admitAccessEmail, MAX_ACCESS_EMAILS_PER_HOUR } from '../src/services/access-request-limits';
import { requestAccess } from '../src/services/access-request-service';
import ace from '../../ace/src/index';
import { createTestEnv as aceEnv } from '../../ace/test/helpers/cloudflare-test';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { mockAccessMail } from './helpers/access-providers';

let db: DatabaseSync;
let env: Env;
const start = Date.parse('2026-09-09T12:00:00Z');
const operatorToken = 'test-operator-credential-with-at-least-32-characters';
const app = new Hono<HonoAppEnv>().route('/access', privateAccessRoutes).route('/internal/access', accessOperatorRoutes).onError(errorHandler);
beforeEach(() => {
  db = migratedSqliteDatabase(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  env = createTestEnv({ DB: sqliteD1(db), APP_ENV: 'production', AVALON_REGION: 'global',
    PUBLIC_API_BASE_URL: 'https://api.rallywith.ai', ALLOWED_ORIGINS: 'https://rallywith.ai',
    TURNSTILE_SECRET_KEY: 'test-key', RESEND_API_KEY: 'test-not-a-key',
    DEMO_OPERATORS_JSON: JSON.stringify({ [operatorToken]: { operatorId: '00000000-0000-4000-8000-000000000001', role: 'demos' } }),
  });
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
function submit(email: string, token = 'challenge') {
  return app.request('https://api.rallywith.ai/access/requests', { method: 'POST',
    headers: { origin: 'https://rallywith.ai', 'content-type': 'application/json' },
    body: JSON.stringify({ email, turnstileToken: token }) }, env);
}
function row() {
  return db.prepare('SELECT id, acknowledgement_status AS status, acknowledgement_generation AS generation, acknowledgement_first_attempt_at AS firstAttemptAt FROM access_requests').get() as { id: string; status: string; generation: number; firstAttemptAt: string | null };
}
function recover(action: string, generation = row().generation, token = operatorToken) {
  return app.request(`https://api.rallywith.ai/internal/access/requests/${row().id}/recover`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, generation, confirmed: true }),
  }, env);
}
function aceRequest(path: string, init: RequestInit = {}) {
  return ace.fetch(new Request(`https://ace.test/api/access${path}`, init), aceEnv({ GLOBAL_DB: env.DB, APP_ENV: 'development', ACE_DEV_AUTH: 'true' }));
}

describe('launch acquisition essentials', () => {
  it.each([
    { success: false },
    { success: true, hostname: 'attacker.test', action: 'access_request' },
    { success: true, hostname: 'rallywith.ai', action: 'another_action' },
  ])('does not persist or email an invalid server-verified challenge: %j', async (verification) => {
    const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(verification));
    expect((await submit('person@example.com')).status).toBe(400);
    expect(db.prepare('SELECT * FROM access_requests').all()).toEqual([]);
    expect(http.mock.calls.map(([url]) => url)).toEqual(['https://challenges.cloudflare.com/turnstile/v0/siteverify']);
  });

  it('fails closed on absent configuration, missing proof and verifier outage', async () => {
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outage'));
    delete env.TURNSTILE_SECRET_KEY;
    expect((await submit('person@example.com')).status).toBe(503);
    env.TURNSTILE_SECRET_KEY = 'test-key';
    expect((await submit('person@example.com', '')).status).toBe(400);
    expect(http).not.toHaveBeenCalled();
    expect((await submit('person@example.com')).status).toBe(503);
    expect(db.prepare('SELECT * FROM access_requests').all()).toEqual([]);
  });

  it('refuses a replayed token before accepting a different address', async () => {
    const mail = vi.fn(async () => Response.json({ id: 'mail' }));
    let verified = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('siteverify')) {
        const success = !verified; verified = true;
        return Response.json({ success, hostname: 'rallywith.ai', action: 'access_request' });
      }
      return mail();
    });
    expect((await submit('first@example.com')).status).toBe(202);
    expect((await submit('second@example.com')).status).toBe(400);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT email FROM access_requests').all()).toEqual([{ email: 'first@example.com' }]);
  });

  it('counts received body bytes even when Content-Length claims a smaller request', async () => {
    const routes = new Hono<HonoAppEnv>().route('/access', createPrivateAccessRoutes(Number.POSITIVE_INFINITY, 32)).onError(errorHandler);
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not reach provider'));
    const response = await routes.request('https://api.rallywith.ai/access/requests', { method: 'POST',
      headers: { origin: 'https://rallywith.ai', 'content-type': 'application/json', 'content-length': '1' },
      body: JSON.stringify({ email: 'person@example.com', turnstileToken: 'proof' }) }, env);
    expect(response.status).toBe(413); expect(http).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM access_requests').all()).toEqual([]);
  });

  it('keeps an unset mail-budget guard inert without writing a bucket', async () => {
    for (let i = 0; i < 5; i++) expect(await admitAccessEmail(env, Number.POSITIVE_INFINITY)).toBe(true);
    expect(db.prepare('SELECT * FROM access_email_budget').all()).toEqual([]);
  });

  it('coordinates an exact mail budget across concurrent admissions and does not rewind its window', async () => {
    const admissions = await Promise.all(Array.from({ length: MAX_ACCESS_EMAILS_PER_HOUR + 2 }, () => admitAccessEmail(env, MAX_ACCESS_EMAILS_PER_HOUR)));
    expect(admissions.filter(Boolean)).toHaveLength(MAX_ACCESS_EMAILS_PER_HOUR);
    expect(await admitAccessEmail(env, MAX_ACCESS_EMAILS_PER_HOUR, start + 3_600_000)).toBe(true);
    expect(await admitAccessEmail(env, MAX_ACCESS_EMAILS_PER_HOUR, start)).toBe(false);
    const nextHourAdmissions = await Promise.all(Array.from({ length: MAX_ACCESS_EMAILS_PER_HOUR + 1 }, () => admitAccessEmail(env, MAX_ACCESS_EMAILS_PER_HOUR, start + 3_600_000)));
    expect(nextHourAdmissions.filter(Boolean)).toHaveLength(MAX_ACCESS_EMAILS_PER_HOUR - 1);
    expect(await admitAccessEmail(env, MAX_ACCESS_EMAILS_PER_HOUR, start + 3_600_000)).toBe(false);
  });

  it('retains quota-deferred requests without starting their uncertainty clock, then retries after capacity returns', async () => {
    const mail = mockAccessMail().mockImplementation(async () => Response.json({ id: 'mail' }));
    db.prepare('INSERT INTO access_email_budget (id, bucket, count) VALUES (1, ?, ?)').run(Math.floor(start / 3_600_000), MAX_ACCESS_EMAILS_PER_HOUR);
    await requestAccess(env, 'waiting@example.com');
    expect(row()).toMatchObject({ status: 'pending', firstAttemptAt: null });
    expect(mail).not.toHaveBeenCalled();
    vi.setSystemTime(start + 48 * 60 * 60 * 1000);
    await requestAccess(env, 'waiting@example.com');
    expect(row().status).toBe('sent'); expect(mail).toHaveBeenCalledTimes(1);
  });

  it('retries the documented concurrent-provider conflict with the same key', async () => {
    const mail = mockAccessMail().mockResolvedValueOnce(Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 }))
      .mockImplementation(async () => Response.json({ id: 'mail' }));
    expect((await submit('retry@example.com')).status).toBe(502);
    expect(row().status).toBe('failed');
    expect((await submit('retry@example.com')).status).toBe(202);
    expect(mail.mock.calls[0]![1]!.headers).toEqual(mail.mock.calls[1]![1]!.headers);
  });

  it('requires operator authentication, reconciliation and a current generation before restarting uncertain mail', async () => {
    const mail = mockAccessMail().mockRejectedValueOnce(new Error('uncertain')).mockImplementation(async () => Response.json({ id: 'mail' }));
    expect((await submit('recover@example.com')).status).toBe(502);
    expect((await recover('retry', 0, 'untrusted')).status).toBe(401);
    const unconfirmed = await app.request(`https://api.rallywith.ai/internal/access/requests/${row().id}/recover`, {
      method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry_reconciled', generation: 0, confirmed: false }),
    }, env);
    expect(unconfirmed.status).toBe(400); expect(mail).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE access_requests SET acknowledgement_status = 'sending'").run();
    expect((await recover('retry')).status).toBe(409);
    vi.setSystemTime(start + 24 * 60 * 60 * 1000);
    expect((await recover('retry')).status).toBe(409);
    expect((await recover('retry_reconciled')).status).toBe(200);
    expect(row()).toMatchObject({ status: 'sent', generation: 1 });
    expect((await recover('retry_reconciled', 0)).status).toBe(409);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(new Headers(mail.mock.calls[1]![1]!.headers).get('idempotency-key')).toBe(`rally-access-request/${row().id}/1`);
  });

  it('fences an older failed completion while a reconciled generation is sending', async () => {
    let arrivedFirst!: () => void; let arrivedSecond!: () => void;
    const firstArrived = new Promise<void>((resolve) => { arrivedFirst = resolve; });
    const secondArrived = new Promise<void>((resolve) => { arrivedSecond = resolve; });
    let releaseFirst!: (response: Response) => void; let releaseSecond!: (response: Response) => void;
    const firstReply = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    const secondReply = new Promise<Response>((resolve) => { releaseSecond = resolve; });
    mockAccessMail().mockImplementationOnce(() => { arrivedFirst(); return firstReply; })
      .mockImplementationOnce(() => { arrivedSecond(); return secondReply; });
    const first = submit('fenced@example.com');
    await firstArrived;
    vi.setSystemTime(start + 24 * 60 * 60 * 1000);
    const second = recover('retry_reconciled');
    await secondArrived;
    try {
      releaseFirst(new Response('late failure', { status: 503 }));
      expect((await first).status).toBe(502);
      expect(row()).toMatchObject({ status: 'sending', generation: 1 });
    } finally { releaseSecond(Response.json({ id: 'second' })); await second; }
    expect(row()).toMatchObject({ status: 'sent', generation: 1 });
  });

  it('suppresses acknowledgements for an address without making a new signup send again', async () => {
    const mail = mockAccessMail().mockImplementation(async () => Response.json({ id: 'mail' }));
    await requestAccess(env, 'stop@example.com', 0);
    expect((await recover('suppress')).status).toBe(200);
    expect((await submit('stop@example.com')).status).toBe(202);
    expect(row().status).toBe('suppressed'); expect(mail).not.toHaveBeenCalled();
  });

  it('paginates equal-time requests without overlap and searches on the server', async () => {
    env.APP_ENV = 'development';
    for (let index = 0; index < ACCESS_PAGE_SIZE + 2; index++) await requestAccess(env, `person${index}@example.com`, 0);
    const first = await (await aceRequest('/requests')).json() as { requests: { id: string }[]; nextCursor: string };
    expect(first.requests).toHaveLength(ACCESS_PAGE_SIZE);
    const second = await (await aceRequest(`/requests?before=${first.nextCursor}`)).json() as { requests: { id: string }[]; nextCursor: string | null };
    expect(second.requests).toHaveLength(2); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.requests, ...second.requests].map((r) => r.id)).size).toBe(ACCESS_PAGE_SIZE + 2);
    expect(await (await aceRequest('/requests?q=person51%40')).json()).toMatchObject({ requests: [{ email: 'person51@example.com' }], nextCursor: null });
  });

  it('lists recipient-associated grants without secrets and revokes them through same-origin Ace writes', async () => {
    await requestAccess(env, 'linked@example.com', 0);
    const grant = await issueDownloadGrant(env.DB, { source: 'manual', createdBy: 'operator', sourceId: row().id, expiresAt: '2026-09-10T12:00:00Z' });
    const list = await (await aceRequest('/downloads')).json();
    expect(list).toMatchObject({ grants: [{ id: grant.id, email: 'linked@example.com', revokedAt: null }] });
    expect(JSON.stringify(list)).not.toContain(grant.token);
    expect((await aceRequest(`/downloads/${grant.id}/revoke`, { method: 'POST' })).status).toBe(403);
    expect((await aceRequest(`/downloads/${grant.id}/revoke`, { method: 'POST', headers: { origin: 'https://ace.test' } })).status).toBe(200);
    expect(await redeemDownloadGrant(env.DB, grant.token)).toBe(false);
  });
});
