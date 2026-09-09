/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueDownloadGrant, availableDownloadGrantExists } from '@rally/db/private-access';
import { privateAccessRoutes } from '../src/routes/private-access';
import migration from '../../../packages/db/migrations/0101_private_access.sql?raw';
import expiryMigration from '../../../packages/db/migrations/0102_download_grant_expiry.sql?raw';

beforeEach(async () => {
  await reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
  for (const sql of [migration, expiryMigration].join('\n').replace(/^--.*$/gmu, '').split(';').filter((statement) => statement.trim())) await env.DB.prepare(sql).run();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function redeem(token: string, method = 'POST') {
  return privateAccessRoutes.request('/downloads/redeem', {
    method, headers: { origin: 'app://rallywithai', 'content-type': 'application/x-www-form-urlencoded' },
    ...(method === 'POST' ? { body: new URLSearchParams({ token }) } : {}),
  }, env);
}
async function issue() { return issueDownloadGrant(env.DB, { source: 'manual', createdBy: 'test-operator' }); }

describe('private installer download on workerd', () => {
  it('allows repeated timed downloads, but rejects new downloads at the exact expiry', async () => {
    await env.DESKTOP_RELEASES!.put('stable/darwin/arm64/Rally.dmg', 'installer-fixture');
    const grant = await issueDownloadGrant(env.DB, {
      source: 'access_invitation', createdBy: 'email-service', expiresAt: '2026-09-09T13:00:00.000Z',
    });
    for (const response of await Promise.all([redeem(grant.token), redeem(grant.token)])) {
      expect(response.status).toBe(200); expect(await response.text()).toBe('installer-fixture');
    }
    vi.setSystemTime(new Date('2026-09-09T12:59:59.999Z'));
    const last = await redeem(grant.token);
    expect(last.status).toBe(200); expect(await last.text()).toBe('installer-fixture');
    expect(await env.DB.prepare('SELECT used_at FROM download_grants WHERE id = ?').bind(grant.id).first('used_at')).toBe('2026-09-09T12:00:00.000Z');
    vi.setSystemTime(new Date(grant.expiresAt!));
    const expired = await redeem(grant.token);
    expect(expired.status).toBe(410); expect(await expired.text()).toContain('expired');
    expect(await availableDownloadGrantExists(env.DB, grant.token)).toBe(false);
  });

  it('rechecks expiry after loading the real R2 object before admitting its stream', async () => {
    await env.DESKTOP_RELEASES!.put('stable/darwin/arm64/Rally.dmg', 'installer-fixture');
    const grant = await issueDownloadGrant(env.DB, {
      source: 'manual', createdBy: 'operator', expiresAt: '2026-09-09T13:00:00.000Z',
    });
    const get = env.DESKTOP_RELEASES!.get.bind(env.DESKTOP_RELEASES!);
    vi.spyOn(env.DESKTOP_RELEASES!, 'get').mockImplementationOnce(async () => {
      const object = await get('stable/darwin/arm64/Rally.dmg');
      vi.setSystemTime(new Date(grant.expiresAt!));
      return object;
    });
    const response = await redeem(grant.token);
    expect(response.status).toBe(410); expect(await response.text()).not.toBe('installer-fixture');
    expect(await env.DB.prepare('SELECT used_at FROM download_grants WHERE id = ?').bind(grant.id).first('used_at')).toBeNull();
  });

  it('streams the real R2 body to exactly one concurrent redemption', async () => {
    await env.DESKTOP_RELEASES!.put('stable/darwin/arm64/Rally.dmg', 'installer-fixture');
    const grant = await issue();
    const responses = await Promise.all([redeem(grant.token), redeem(grant.token)]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 410]);
    expect(bodies.filter((body) => body === 'installer-fixture')).toHaveLength(1);
    const success = responses.find((response) => response.status === 200)!;
    expect(success.headers.get('location')).toBeNull();
    expect(success.headers.get('cache-control')).toBe('no-store');
    expect(success.headers.get('content-disposition')).toContain('attachment');
    expect(await availableDownloadGrantExists(env.DB, grant.token)).toBe(false);
  });

  it('preserves the grant when the installer is missing and when GET or HEAD probes it', async () => {
    const grant = await issue();
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await redeem(grant.token, method);
      expect(response.status).toBe(method === 'POST' ? 503 : 404);
      await response.text();
      expect(await availableDownloadGrantExists(env.DB, grant.token)).toBe(true);
    }
    await env.DESKTOP_RELEASES!.put('stable/darwin/arm64/Rally.dmg', 'installer-fixture');
    const response = await redeem(grant.token);
    expect(response.status).toBe(200); await response.text();
  });

  it('rejects revoked and unknown capabilities without serving bytes', async () => {
    await env.DESKTOP_RELEASES!.put('stable/darwin/arm64/Rally.dmg', 'installer-fixture');
    const grant = await issue();
    await env.DB.prepare('UPDATE download_grants SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), grant.id).run();
    for (const token of [grant.token, '0'.repeat(64), 'invalid']) {
      const response = await redeem(token);
      expect(response.status).toBe(410); expect(await response.text()).not.toBe('installer-fixture');
    }
    const timed = await issueDownloadGrant(env.DB, { source: 'manual', createdBy: 'operator', expiresAt: '2026-09-09T13:00:00.000Z' });
    const first = await redeem(timed.token);
    expect(first.status).toBe(200); await first.text();
    await env.DB.prepare('UPDATE download_grants SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), timed.id).run();
    const revoked = await redeem(timed.token);
    expect(revoked.status).toBe(410); expect(await revoked.text()).not.toBe('installer-fixture');
  });
});
