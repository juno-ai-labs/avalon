import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { listAccessRequests, issueDownloadGrant, redeemDownloadGrant, downloadGrantUrl } from '@rally/db/private-access';
import type { Env, HonoAppEnv } from '../src/env';
import { privateAccessRoutes } from '../src/routes/private-access';
import { errorHandler } from '../src/middleware/errors';
import { accessAcknowledgementContent } from '../src/services/access-request-content';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

let sqlite: DatabaseSync;
let env: Env;
let provider: MockInstance<typeof fetch>;
const app = new Hono<HonoAppEnv>().route('/access', privateAccessRoutes).onError(errorHandler);
const originalContent = { ...accessAcknowledgementContent };
function submit(email: string, origin = 'https://rallywith.ai') {
  return app.request('/access/requests', {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email }),
  }, env);
}
beforeEach(() => {
  sqlite = migratedSqliteDatabase();
  env = createTestEnv({ DB: sqliteD1(sqlite), AVALON_REGION: 'global', APP_ENV: 'production',
    ALLOWED_ORIGINS: 'https://rallywith.ai', RESEND_API_KEY: 'test-not-a-key', RESEND_FROM_EMAIL: 'Rally <test@example.com>' });
  provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'test-email' }));
});
afterEach(() => { sqlite.close(); Object.assign(accessAcknowledgementContent, originalContent); vi.restoreAllMocks(); });

describe('private access against regional migrations', () => {
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
    expect(message.from).toBe('Adam @ Rally <hello@example.com>');
    expect(message.subject).toBe('We got your Rally request');
    expect(message.text).toContain('3 things they already want to share or collaborate on');
    expect(message.text).not.toContain('**');
    expect(message.html).toContain('3 things they already want to share or collaborate on</strong>');
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
    expect(await listAccessRequests(env.DB)).toMatchObject([{ acknowledgementStatus: 'sent' }]);
  });

  it('keeps legacy acknowledgements on the configured transactional sender', async () => {
    sqlite.prepare(`INSERT INTO access_requests
      (id, email, created_at, acknowledgement_subject, acknowledgement_markdown)
      VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'legacy@example.com', new Date().toISOString(), 'Original subject', 'Original body');
    expect((await submit('legacy@example.com')).status).toBe(202);
    expect(JSON.parse(String(provider.mock.calls[0]?.[1]?.body))).toMatchObject({
      from: 'Rally <test@example.com>', subject: 'Original subject', text: 'Original body',
    });
  });

  it('rejects invalid addresses and disallowed origins without storing or emailing', async () => {
    expect((await submit('not-an-email')).status).toBe(400);
    expect((await submit('person@example.com', 'https://untrusted.example')).status).toBe(403);
    expect(await listAccessRequests(env.DB)).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not write pre-workspace acquisition to EU or send real mail in development', async () => {
    env.AVALON_REGION = 'eu';
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
