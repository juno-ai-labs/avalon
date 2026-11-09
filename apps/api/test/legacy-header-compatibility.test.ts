import "../../../tests/isolated-region";
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import { RALLY_HEADERS } from '@rally/contracts/http-headers';
import type { HonoAppEnv } from '../src/env';
import { apiOperationTelemetry } from '../src/middleware/api-operation-telemetry';
import { errorHandler } from '../src/middleware/errors';
import { requestContext } from '../src/middleware/request-context';
import { publicTelemetryRoutes } from '../src/routes/telemetry';
import { createApp } from '../src/app';
import { createCloudflareTestBinding, createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

/**
 * The product header prefix moved from `x-avalon-` to `x-rally-`, and a desktop
 * build carries its header names compiled in. Every boundary a *client* reaches
 * therefore has to resolve the superseded spelling for as long as those builds
 * are installed.
 *
 * These are the reading-side assertions. The writing side — that nothing mints
 * the superseded name any more — is covered by the canonical-spelling
 * assertions in the suites that own each route.
 */
describe('superseded product header spellings', () => {
  const auth = {
    sessionId: 'session',
    userId: asUserId('00000000-0000-4000-8000-000000000901'),
    workspaceId: asWorkspaceId('00000000-0000-4000-8000-000000000902'),
    region: 'global' as const,
    role: 'member' as const,
  };

  it('resolves a region assertion sent as x-avalon-region', async () => {
    const app = new Hono<HonoAppEnv>();
    app.use('*', requestContext);
    app.get('/health', (c) => c.json({ ok: true }));
    app.onError(errorHandler);

    const matching = await app.request('https://api.example.com/health', {
      headers: { 'x-avalon-region': 'global' },
    }, createTestEnv({ AVALON_REGION: 'global', LOG_LEVEL: 'error' }));
    expect(matching.status).toBe(200);

    // The point of reading it at all: a superseded spelling must still be able
    // to *fail* the region check, or a pre-rename client silently reaches the
    // wrong region's data.
    const mismatched = await app.request('https://api.example.com/health', {
      headers: { 'x-avalon-region': 'enterprise' },
    }, createTestEnv({ AVALON_REGION: 'global', LOG_LEVEL: 'error' }));
    expect(mismatched.status).toBe(409);
  });

  it('correlates an operation ID sent as x-avalon-operation-id', async () => {
    const emit = vi.fn(async () => undefined);
    let now = 0;
    const app = new Hono<HonoAppEnv>();
    app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    app.use('*', apiOperationTelemetry({ emit, now: () => (now += 20) }));
    app.post('/canvases', (c) => c.json({ ok: true }, 201));
    const operationId = '018f22f2-4c22-7abc-8def-0123456789ab';

    const response = await app.request('/canvases', {
      method: 'POST', headers: { 'x-avalon-operation-id': operationId },
    }, createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.anything(), auth, expect.objectContaining({
      correlationOperationId: operationId,
    })));
  });

  it('reads an anonymous crash capability sent as x-avalon-telemetry-capability', async () => {
    const database = migratedSqliteDatabase();
    const put = vi.fn(async () => undefined);
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'independent-global-capability-key',
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put, delete: vi.fn(async () => undefined),
      }),
    });
    const app = (): Hono<HonoAppEnv> => {
      const instance = new Hono<HonoAppEnv>();
      instance.route('/telemetry', publicTelemetryRoutes);
      instance.onError(errorHandler);
      return instance;
    };
    const bootstrap = await (await app().request('/telemetry/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: '018f22f2-4c22-7abc-8def-0123456789ab' }),
    }, environment)).json() as { capability: string };

    const form = new FormData();
    form.set('metadata', JSON.stringify({
      uploadId: '018f22f2-4c22-7abc-8def-0123456789ac',
      installationId: '018f22f2-4c22-7abc-8def-0123456789ad',
      route: 'global', release: '1.0.0', buildId: 'build', platform: 'darwin',
      architecture: 'arm64', processRole: 'renderer',
      launchId: '018f22f2-4c22-7abc-8def-0123456789ae', channel: 'stable',
    }));
    form.set('dump', new File([new TextEncoder().encode('MDMP')], 'report.dmp'));

    const accepted = await app().request('/telemetry/crashes/anonymous', {
      method: 'POST', headers: { 'x-avalon-telemetry-capability': bootstrap.capability }, body: form,
    }, environment);

    expect(accepted.status).toBe(202);
    expect(put).toHaveBeenCalledOnce();
    database.close();
  });

  it('admits both spellings of every client header in the CORS preflight', async () => {
    const response = await createApp().request('https://api.example.com/workstreams', {
      method: 'OPTIONS',
      headers: {
        origin: 'app://rallywithai',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-avalon-draft-id,x-avalon-operation-id,x-avalon-region',
      },
    }, createTestEnv({
      ALLOWED_ORIGINS: 'app://rallywithai',
      AVALON_REGION: 'global',
      LOG_LEVEL: 'error',
    }));

    expect(response.status).toBe(204);
    const allowed = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    for (const name of [RALLY_HEADERS.DRAFT_ID, RALLY_HEADERS.OPERATION_ID, RALLY_HEADERS.REGION]) {
      expect(allowed).toContain(name);
      expect(allowed).toContain(name.replace('x-rally-', 'x-avalon-'));
    }
  });
});
