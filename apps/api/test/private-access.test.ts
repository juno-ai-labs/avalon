import "../../../tests/isolated-region";
import { mockAccessMail } from './helpers/access-providers';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { listAccessRequests, issueDownloadGrant, redeemDownloadGrant, downloadGrantUrl } from '@rally/db/private-access';
import type { Env, HonoAppEnv } from '../src/env';
import { privateAccessRoutes } from '../src/routes/private-access';
import { errorHandler } from '../src/middleware/errors';
import { accessAcknowledgementContent } from '../src/services/access-request-content';
import { MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR, MAX_PRIVATE_ACCESS_REQUEST_BYTES } from '../src/services/access-request-limits';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

let sqlite: DatabaseSync;
let env: Env;
let provider: Mock<typeof fetch>;
const app = new Hono<HonoAppEnv>().route('/access', privateAccessRoutes).onError(errorHandler);
const originalContent = { ...accessAcknowledgementContent };
function submit(email: string, origin = 'https://rallywith.ai') {
  return app.request('https://api.rallywith.ai/access/requests', {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, turnstileToken: 'test-challenge' }),
  }, env);
}
beforeEach(() => {
  sqlite = migratedSqliteDatabase();
  env = createTestEnv({ DB: sqliteD1(sqlite), AVALON_REGION: 'global', APP_ENV: 'production',
    PUBLIC_API_BASE_URL: 'https://api.rallywith.ai', ALLOWED_ORIGINS: 'https://rallywith.ai', TURNSTILE_SECRET_KEY: 'test-turnstile-key', RESEND_API_KEY: 'test-not-a-key', RESEND_FROM_EMAIL: 'Rally <test@example.com>' });
  provider = mockAccessMail().mockImplementation(async () => Response.json({ id: 'test-email' }));
});
afterEach(() => { sqlite.close(); Object.assign(accessAcknowledgementContent, originalContent); vi.restoreAllMocks(); });

describe('private access against regional migrations', () => {
  it('enforces the configured per-IP rate before saving or emailing another address', async () => {
    const limited = app;
    const send = (email: string) => limited.request('https://api.rallywith.ai/access/requests', {
      method: 'POST', headers: { origin: 'https://rallywith.ai', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      body: JSON.stringify({ email, turnstileToken: 'test-challenge' }),
    }, env);
    for (let i = 0; i < MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR; i++) expect((await send(`first${i}@example.com`)).status).toBe(202);
    const refused = await send('second@example.com');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: 'access_request_rate_limited' } });
    expect(provider).toHaveBeenCalledTimes(MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR);
    expect(await listAccessRequests(env.DB)).toHaveLength(MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR);
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM access_request_rate_buckets').all())).not.toContain('192.0.2.1');
  });

  it('accepts ordinary requests within the approved per-IP allowance', async () => {
    expect((await submit('first@example.com')).status).toBe(202);
    expect((await submit('second@example.com')).status).toBe(202);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT count FROM access_request_rate_buckets').all()).toEqual([{ count: 2 }]);
  });

  it('rejects an oversized body before parsing or saving when the byte guard is configured', async () => {
    const response = await app.request('https://api.rallywith.ai/access/requests', {
      method: 'POST', headers: { origin: 'https://rallywith.ai', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', padding: 'x'.repeat(MAX_PRIVATE_ACCESS_REQUEST_BYTES) }),
    }, env);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'access_body_too_large' } });
    expect(await listAccessRequests(env.DB)).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('normalizes and persists a request, acknowledges it once, and lists it for Ace', async () => {
    expect((await submit('  Person@Example.com ')).status).toBe(202);
    expect((await submit('person@example.com')).status).toBe(202);
    expect(provider).toHaveBeenCalledTimes(1);
    const requests = await listAccessRequests(env.DB);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ email: 'person@example.com', acknowledgementStatus: 'sent' });
    expect(requests[0]?.acknowledgedAt).toBeTruthy();
    const message = JSON.parse(String(provider.mock.calls[0]?.[1]?.body));
    expect(message.to).toEqual(['person@example.com']);
    expect(message.from).toBe('Adam @ Rally <hi@rallywith.ai>');
    expect(message.subject).toBe('We got your Rally request');
    expect(message.text).toContain('3 things they already want to share or collaborate on');
    expect(message.text).not.toContain('**');
    expect(message.text).toContain('— Adam\nRally');
    expect(message.html).toBeUndefined();
  });

  it('retains failed requests and retries the original content and provider key', async () => {
    provider.mockResolvedValueOnce(new Response('provider unavailable', { status: 503 }));
    expect((await submit('retry@example.com')).status).toBe(502);
    expect(await listAccessRequests(env.DB)).toMatchObject([{ acknowledgementStatus: 'failed' }]);
    accessAcknowledgementContent.from = 'Another sender <another@example.com>';
    accessAcknowledgementContent.subject = 'Changed subject';
    accessAcknowledgementContent.markdown = 'Changed body';
    env.RESEND_FROM_EMAIL = 'Changed default <default@example.com>';
    expect((await submit('retry@example.com')).status).toBe(202);
    expect(provider.mock.calls[1]?.[1]?.body).toEqual(provider.mock.calls[0]?.[1]?.body);
    expect(provider.mock.calls[1]?.[1]?.headers).toEqual(provider.mock.calls[0]?.[1]?.headers);
    const row = sqlite.prepare('SELECT id FROM access_requests WHERE email = ?').get('retry@example.com') as { id: string };
    expect(new Headers(provider.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(`rally-access-request/${row.id}/0`);
    expect(await listAccessRequests(env.DB)).toMatchObject([{ acknowledgementStatus: 'sent' }]);
  });

  it.each([
    [401, 'restricted_api_key'],
    [403, 'validation_error'],
    [422, 'missing_required_field'],
    [409, 'invalid_idempotent_request'],
  ])('requires operator review for provider %i %s without blaming the recipient or resending', async (status, name) => {
    provider.mockResolvedValueOnce(Response.json({ name }, { status }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await submit('rejected@example.com');
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'access_email_review_required' } });
      expect(body).toMatchObject({ error: { message: expect.not.stringContaining('Check that you entered the right address') } });
    }
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await listAccessRequests(env.DB)).toMatchObject([{ acknowledgementStatus: 'review_required', acknowledgedAt: null }]);
  });

  it('rejects invalid addresses and disallowed origins without storing or emailing', async () => {
    expect((await submit('not-an-email')).status).toBe(400);
    expect((await submit('person@example.com', 'https://untrusted.example')).status).toBe(403);
    expect(await listAccessRequests(env.DB)).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not write pre-workspace acquisition to enterprise or send real mail in development', async () => {
    env.AVALON_REGION = 'enterprise';
    expect((await submit('person@example.com')).status).toBe(404);
    expect(await listAccessRequests(env.DB)).toEqual([]);
    env.AVALON_REGION = 'global'; env.APP_ENV = 'development';
    expect((await submit('person@example.com')).status).toBe(202);
    expect(await listAccessRequests(env.DB)).toMatchObject([{ acknowledgementStatus: 'skipped', acknowledgedAt: null }]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('issues distinct hashed grants usable by different producers, without time expiry', async () => {
    const manual = await issueDownloadGrant(env.DB, { source: 'manual', createdBy: 'operator' });
    const invitation = await issueDownloadGrant(env.DB, { source: 'access_invitation', sourceId: 'request', createdBy: 'email-service' });
    expect(manual.token).not.toBe(invitation.token);
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM download_grants').all())).not.toContain(manual.token);
    sqlite.prepare('UPDATE download_grants SET created_at = ?').run('2000-01-01T00:00:00.000Z');
    expect(await redeemDownloadGrant(env.DB, manual.token)).toBe(true);
    expect(await redeemDownloadGrant(env.DB, manual.token)).toBe(false);
    expect(await redeemDownloadGrant(env.DB, invitation.token)).toBe(true);
    const url = new URL(downloadGrantUrl(manual.token));
    expect(url.search).toBe(''); expect(url.hash).toContain(manual.token);
  });

  it('enforces future expiry in the shared issuer for email producers', async () => {
    await expect(issueDownloadGrant(env.DB, { source: 'workspace_invitation', createdBy: 'email-service', expiresAt: '2000-01-01T00:00:00.000Z' })).rejects.toThrow('Choose a future expiry.');
    expect(sqlite.prepare('SELECT * FROM download_grants').all()).toEqual([]);
  });
});
