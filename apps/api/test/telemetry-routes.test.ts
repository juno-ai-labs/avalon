import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TELEMETRY_BATCH_MAX_BYTES } from '@avalon/contracts/telemetry';
import type { HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { authenticatedTelemetryRoutes, publicTelemetryRoutes } from '../src/routes/telemetry';
import { requireIdentityAuth } from '../src/middleware/auth';
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const epochId = '018f22f2-4c22-7abc-8def-0123456789ab';

function publicApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.route('/telemetry', publicTelemetryRoutes);
  app.onError(errorHandler);
  return app;
}

function authenticatedApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use('/telemetry/*', requireIdentityAuth);
  app.route('/telemetry', authenticatedTelemetryRoutes);
  app.onError(errorHandler);
  return app;
}

describe('telemetry HTTP bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('rejects an oversized anonymous batch before validation or persistence', async () => {
    const body = JSON.stringify({ padding: 'x'.repeat(TELEMETRY_BATCH_MAX_BYTES) });
    const prepare = vi.fn();

    const response = await publicApp().request('/telemetry/anonymous', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }, createTestEnv({
      AVALON_REGION: 'global',
      LOG_LEVEL: 'error',
      DB: createTestD1Database({ prepare }),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'telemetry_payload_too_large' },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns a route-fixed bootstrap only from Global and maps malformed input safely', async () => {
    const database = migratedSqliteDatabase();
    const global = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    });
    const response = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ anonymousEpochId: epochId }),
    }, global);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      route: 'global', routingBasis: 'geolocation_fallback', capability: expect.any(String),
    });

    const malformed = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, global);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });

    const eu = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: epochId }),
    }, createTestEnv({ AVALON_REGION: 'eu', LOG_LEVEL: 'error' }));
    expect(eu.status).toBe(404);
    database.close();
  });

  it('maps a tampered anonymous capability to a stable public rejection', async () => {
    const response = await publicApp().request('/telemetry/anonymous', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'x'.repeat(64),
        events: [{
          schema: 'com.avalon.telemetry.event', schemaVersion: 1,
          eventId: '018f22f2-4c22-7abc-8def-0123456789ac',
          name: 'screen_viewed', source: 'desktop-renderer', category: 'product',
          identityScope: 'anonymous-epoch', originalTimestamp: '2026-08-12T20:00:00.000Z',
          sentAt: '2026-08-12T20:00:00.000Z',
          context: {
            environment: 'production', release: '1.0.0', buildId: 'build',
            onboardingJourneyId: '018f22f2-4c22-7abc-8def-0123456789ad',
          },
          properties: { screen: 'onboarding_welcome' },
        }],
      }),
    }, createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error',
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'telemetry_capability_invalid' },
    });
  });

  it('accepts valid multipart crash input and rejects invalid multipart before R2', async () => {
    const database = migratedSqliteDatabase();
    const put = vi.fn(async () => undefined);
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put,
        delete: vi.fn(async () => undefined),
      }),
    });
    const bootstrapResponse = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: epochId }),
    }, environment);
    const bootstrap = await bootstrapResponse.json() as { capability: string };
    const form = new FormData();
    form.set('metadata', JSON.stringify({
      uploadId: '018f22f2-4c22-7abc-8def-0123456789ac',
      installationId: '018f22f2-4c22-7abc-8def-0123456789ad',
      route: 'global', release: '1.0.0', buildId: 'build', platform: 'darwin',
      architecture: 'arm64', processRole: 'renderer',
      launchId: '018f22f2-4c22-7abc-8def-0123456789ae', channel: 'stable',
    }));
    form.set('dump', new File([new TextEncoder().encode('MDMP')], 'report.dmp'));
    const accepted = await publicApp().request('/telemetry/crashes/anonymous', {
      method: 'POST', headers: { 'x-avalon-telemetry-capability': bootstrap.capability }, body: form,
    }, environment);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ result: 'accepted' });
    expect(put).toHaveBeenCalledOnce();

    const invalid = new FormData();
    invalid.set('metadata', '{}');
    invalid.set('dump', new File([new TextEncoder().encode('MDMP')], 'report.dmp'));
    const rejected = await publicApp().request('/telemetry/crashes/anonymous', {
      method: 'POST', headers: { 'x-avalon-telemetry-capability': bootstrap.capability }, body: invalid,
    }, environment);
    expect(rejected.status).toBe(400);
    expect(put).toHaveBeenCalledOnce();
    database.close();
  });

  it('enforces identity authentication and accepts a valid authenticated batch', async () => {
    const database = migratedSqliteDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-1', 'google-1', 'user@example.com', 'User',
              '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', 'workspace', 'global', 'user-1',
              '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('workspace-1', 'user-1', 'owner', 'active', '2026-08-01T00:00:00.000Z');
    `);
    const environment = createTestEnv({
      AVALON_REGION: 'global', APP_ENV: 'development', AVALON_DEV_AUTH: 'true',
      LOG_LEVEL: 'error', DB: sqliteD1(database),
    });
    const body = JSON.stringify({ events: [{
      schema: 'com.avalon.telemetry.event', schemaVersion: 1,
      eventId: '018f22f2-4c22-7abc-8def-0123456789af',
      name: 'screen_viewed', source: 'desktop-renderer', category: 'product',
      identityScope: 'workspace-user', originalTimestamp: '2026-08-12T20:00:00.000Z',
      sentAt: '2026-08-12T20:00:00.000Z',
      context: { environment: 'production', release: '1.0.0', buildId: 'build', region: 'global' },
      properties: { screen: 'workspace_home' },
    }] });
    const unauthorized = await authenticatedApp().request('/telemetry/events', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }, environment);
    expect(unauthorized.status).toBe(401);

    const accepted = await authenticatedApp().request('/telemetry/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-avalon-dev-user-id': 'user-1',
        'x-avalon-dev-workspace-id': 'workspace-1',
      },
      body,
    }, environment);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      results: [{ result: 'accepted', eventId: '018f22f2-4c22-7abc-8def-0123456789af' }],
    });
    database.close();
  });
});
