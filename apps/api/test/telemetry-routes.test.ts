import "../../../tests/isolated-region";
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TELEMETRY_BATCH_MAX_BYTES } from '@rally/contracts/telemetry';
import type { HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { authenticatedTelemetryRoutes, publicTelemetryRoutes } from '../src/routes/telemetry';
import { requireIdentityAuth } from '../src/middleware/auth';
import { coarseTelemetryRoute, TelemetryBootstrapService } from '../src/telemetry/bootstrap';
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from './helpers/cloudflare-test';
import { migratedObservabilityFixture, sqliteD1 } from './helpers/sqlite-d1';

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

  it('exposes the same content-free Cloudflare route decision without creating a journey', async () => {
    expect(coarseTelemetryRoute()).toEqual({ route: 'global', routingBasis: 'geolocation_fallback' });
    const prepare = vi.fn();
    const response = await publicApp().request('/telemetry/route', {}, createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: createTestD1Database({ prepare }),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      route: 'global', routingBasis: 'geolocation_fallback',
      routeToken: expect.any(String),
    });
    expect(prepare).not.toHaveBeenCalled();

    const regional = await publicApp().request('/telemetry/route', {}, createTestEnv({
      AVALON_REGION: 'enterprise', LOG_LEVEL: 'error', DB: createTestD1Database({ prepare }),
    }));
    expect(regional.status).toBe(404);

    const cloudflareEuRequest = new Request('https://api.rallywith.ai/telemetry/route');
    Object.defineProperty(cloudflareEuRequest, 'cf', {
      value: { country: 'US', isEUCountry: '1' },
    });
    const cloudflareEu = await publicApp().request(cloudflareEuRequest, undefined, createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: createTestD1Database({ prepare }),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    }));
    expect(cloudflareEu.status).toBe(200);
    await expect(cloudflareEu.json()).resolves.toMatchObject({
      route: 'global', routingBasis: 'geolocation_fallback',
    });
  });

  it('uses Cloudflare affirmative enterprise classification for a tokenless bootstrap', async () => {
    const database = migratedObservabilityFixture();
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    });
    const bootstrapRequest = new Request('https://api.rallywith.ai/telemetry/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anonymousEpochId: '018f22f2-4c22-7abc-8def-0123456789ce',
      }),
    });
    Object.defineProperty(bootstrapRequest, 'cf', {
      value: { country: 'US', isEUCountry: '1' },
    });

    const response = await publicApp().request(bootstrapRequest, undefined, environment);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      route: 'global', routingBasis: 'geolocation_fallback',
    });
    database.close();
  });

  it('binds bootstrap to the signed route decision when Cloudflare country changes', async () => {
    const database = migratedObservabilityFixture();
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    });
    const routeRequest = new Request('https://api.with-avalon.com/telemetry/route');
    Object.defineProperty(routeRequest, 'cf', { value: { country: 'US' } });
    const routeResponse = await publicApp().request(routeRequest, undefined, environment);
    const route = await routeResponse.json() as { route: string; routeToken: string };
    expect(route.route).toBe('global');

    const bootstrapRequest = new Request('https://api.with-avalon.com/telemetry/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ anonymousEpochId: epochId, routeToken: route.routeToken }),
    });
    Object.defineProperty(bootstrapRequest, 'cf', { value: { country: 'DE' } });
    const bootstrapResponse = await publicApp().request(bootstrapRequest, undefined, environment);
    const bootstrapBody = await bootstrapResponse.json();

    expect(bootstrapResponse.status, JSON.stringify(bootstrapBody)).toBe(201);
    expect(bootstrapBody).toMatchObject({
      route: 'global', routingBasis: 'geolocation_fallback',
    });
    expect(database.prepare(
      'SELECT route FROM telemetry_onboarding_journeys WHERE anonymous_epoch_id = ?',
    ).get(epochId)).toEqual({ route: 'global' });

    const rejectedEpochId = '018f22f2-4c22-7abc-8def-0123456789bb';
    const tamperedRouteToken = `${route.routeToken.slice(0, -1)}${route.routeToken.endsWith('a') ? 'b' : 'a'}`;
    const tampered = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: rejectedEpochId, routeToken: tamperedRouteToken }),
    }, environment);
    expect(tampered.status).toBe(400);
    await expect(tampered.json()).resolves.toMatchObject({
      error: { code: 'telemetry_route_decision_invalid' },
    });
    expect(database.prepare(
      'SELECT route FROM telemetry_onboarding_journeys WHERE anonymous_epoch_id = ?',
    ).get(rejectedEpochId)).toBeUndefined();
    database.close();
  });

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
    const database = migratedObservabilityFixture();
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

    const enterprise = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: epochId }),
    }, createTestEnv({ AVALON_REGION: 'enterprise', LOG_LEVEL: 'error' }));
    expect(enterprise.status).toBe(404);
    database.close();
  });

  it('logs the field a bootstrap that failed its own contract rejected, and still answers internal_error', async () => {
    // The route mapped every unknown error to `ApiError(500, 'internal_error')`,
    // so a `ZodError` from the service reached the log as that code and the
    // class name `ApiError`, and nothing said which field. Rethrown as itself,
    // the error handler answers the same 500 and logs the route and the paths.
    const rejection = z.strictObject({ routingBasis: z.enum(['geolocation_fallback']) }).safeParse({ routingBasis: 'guess' });
    if (rejection.success) throw new Error('expected a rejection');
    vi.spyOn(TelemetryBootstrapService.prototype, 'bootstrap').mockRejectedValueOnce(rejection.error);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const database = migratedObservabilityFixture();

    const response = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ anonymousEpochId: epochId }),
    }, createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    }));
    database.close();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'internal_error' } });
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({
      event: 'request_failed',
      code: 'internal_error',
      route: '/telemetry/bootstrap',
      validation_issues: [{ path: 'routingBasis', code: 'invalid_value' }],
    }));
    logged.mockRestore();
  });

  it('maps a tampered anonymous capability to a stable public rejection', async () => {
    const response = await publicApp().request('/telemetry/anonymous', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'x'.repeat(64),
        events: [{
          schema: 'ai.rallywith.telemetry.event', schemaVersion: 1,
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

  it('accepts public-site events through the coarse regional anonymous route', async () => {
    const database = migratedObservabilityFixture();
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
    });
    const bootstrapResponse = await publicApp().request('/telemetry/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: epochId }),
    }, environment);
    const bootstrap = await bootstrapResponse.json() as { capability: string; journeyId: string };
    const eventId = '018f22f2-4c22-7abc-8def-0123456789bc';

    const response = await publicApp().request('/telemetry/anonymous', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: bootstrap.capability,
        events: [{
          schema: 'ai.rallywith.telemetry.event', schemaVersion: 1, eventId,
          name: 'site_page_viewed', source: 'site', category: 'product',
          identityScope: 'anonymous-epoch', originalTimestamp: '2026-08-12T20:00:00.000Z',
          sentAt: '2026-08-12T20:00:00.000Z',
          context: {
            environment: 'production', region: 'global', release: 'site-1', buildId: 'site-1',
            sessionId: '018f22f2-4c22-7abc-8def-0123456789bd',
            onboardingJourneyId: bootstrap.journeyId,
          },
          properties: { page: 'landing', pathname: '/', campaignSource: 'launch' },
        }],
      }),
    }, environment);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ results: [{ result: 'accepted', eventId }] });
    const persisted = database.prepare(
      'SELECT envelope_json, delivery_state FROM telemetry_accepted_events WHERE event_id = ?',
    ).get(eventId) as { envelope_json: string; delivery_state: string };
    expect(JSON.parse(persisted.envelope_json)).toMatchObject({ name: 'site_page_viewed', source: 'site' });
    expect(persisted.delivery_state).toBe('pending');
    database.close();
  });

  it('accepts valid multipart crash input and rejects invalid multipart before R2', async () => {
    const database = migratedObservabilityFixture();
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
      method: 'POST', headers: { 'x-rally-telemetry-capability': bootstrap.capability }, body: form,
    }, environment);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ result: 'accepted' });
    expect(put).toHaveBeenCalledOnce();

    const invalid = new FormData();
    invalid.set('metadata', '{}');
    invalid.set('dump', new File([new TextEncoder().encode('MDMP')], 'report.dmp'));
    const rejected = await publicApp().request('/telemetry/crashes/anonymous', {
      method: 'POST', headers: { 'x-rally-telemetry-capability': bootstrap.capability }, body: invalid,
    }, environment);
    expect(rejected.status).toBe(400);
    expect(put).toHaveBeenCalledOnce();
    database.close();
  });

  it('enforces identity authentication and accepts a valid authenticated batch', async () => {
    const database = migratedObservabilityFixture();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-0000000000d1', 'google-1', 'user@example.com', 'User',
              '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('00000000-0000-7000-8000-0000000000d2', 'Workspace', 'workspace', 'global', '00000000-0000-7000-8000-0000000000d1',
              '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('00000000-0000-7000-8000-0000000000d2', '00000000-0000-7000-8000-0000000000d1', 'owner', 'active', '2026-08-01T00:00:00.000Z');
    `);
    const environment = createTestEnv({
      AVALON_REGION: 'global', APP_ENV: 'development', RALLY_DEV_AUTH: 'true',
      LOG_LEVEL: 'error', DB: sqliteD1(database),
    });
    const body = JSON.stringify({ events: [{
      schema: 'ai.rallywith.telemetry.event', schemaVersion: 1,
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
        'x-rally-dev-user-id': '00000000-0000-7000-8000-0000000000d1',
        'x-rally-dev-workspace-id': '00000000-0000-7000-8000-0000000000d2',
      },
      body,
    }, environment);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      results: [{ result: 'accepted', eventId: '018f22f2-4c22-7abc-8def-0123456789af' }],
    });

    const forgedApiEvent = await authenticatedApp().request('/telemetry/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rally-dev-user-id': '00000000-0000-7000-8000-0000000000d1',
        'x-rally-dev-workspace-id': '00000000-0000-7000-8000-0000000000d2',
      },
      body: JSON.stringify({ events: [{
        schema: 'ai.rallywith.telemetry.event', schemaVersion: 1,
        eventId: '018f22f2-4c22-7abc-8def-0123456789b1',
        name: 'workstream_create_completed', source: 'api', category: 'product',
        identityScope: 'workspace-user', originalTimestamp: '2026-08-12T20:00:00.000Z',
        sentAt: '2026-08-12T20:00:00.000Z',
        context: { environment: 'production', release: '1.0.0', buildId: 'build', region: 'global' },
        properties: { result: 'success' },
      }] }),
    }, environment);
    expect(forgedApiEvent.status).toBe(403);
    await expect(forgedApiEvent.json()).resolves.toMatchObject({
      error: { code: 'telemetry_source_forbidden' },
    });

    const forgedWorkspaceEvent = await authenticatedApp().request('/telemetry/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rally-dev-user-id': '00000000-0000-7000-8000-0000000000d1',
        'x-rally-dev-workspace-id': '00000000-0000-7000-8000-0000000000d2',
      },
      body: JSON.stringify({ events: [{
        schema: 'ai.rallywith.telemetry.event', schemaVersion: 1,
        eventId: '018f22f2-4c22-7abc-8def-0123456789b0',
        name: 'agent_tool_started', source: 'api', category: 'product',
        identityScope: 'workspace', originalTimestamp: '2026-08-12T20:00:00.000Z',
        sentAt: '2026-08-12T20:00:00.000Z',
        context: { environment: 'production', release: '1.0.0', buildId: 'build', region: 'global' },
        properties: {
          workstreamId: '018f22f2-4c22-7abc-8def-012345678901',
          harnessRunId: '018f22f2-4c22-7abc-8def-012345678902',
          toolName: 'search_messages', pluginId: 'rally.workstream', capability: 'workstream.search',
          mode: 'read', runKind: 'system', executionScope: 'workspace',
        },
      }] }),
    }, environment);
    expect(forgedWorkspaceEvent.status).toBe(403);
    database.close();
  });
});
