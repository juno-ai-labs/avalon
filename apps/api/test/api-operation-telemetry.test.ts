import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { HonoAppEnv } from '../src/env';
import { ApiError } from '../src/lib/api-error';
import { apiOperationTelemetry } from '../src/middleware/api-operation-telemetry';
import { createApp } from '../src/app';
import { acceptAuthenticatedTelemetry } from '../src/telemetry/authenticated';
import { createTestD1Database, createTestEnv } from './helpers/cloudflare-test';

// The production app cannot take an injected emitter, so the sink beneath the
// default emitter is replaced; everything above it is the real app.
vi.mock('../src/telemetry/authenticated', () => ({
  acceptAuthenticatedTelemetry: vi.fn(async () => []),
  ensureWorkspaceAnalyticsId: vi.fn(async () => 'analytics'),
}));

const auth = {
  sessionId: 'session',
  userId: asUserId('00000000-0000-4000-8000-000000000901'),
  workspaceId: asWorkspaceId('00000000-0000-4000-8000-000000000902'),
  region: 'global' as const,
  role: 'member' as const,
};

describe('allowlisted API operation telemetry', () => {
  it('emits only a bounded operation/result/duration projection after the response', async () => {
    const emit = vi.fn(async () => undefined);
    const app = new Hono<HonoAppEnv>();
    app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    app.use('*', apiOperationTelemetry({ emit, now: sequentialClock(0, 1_200) }));
    app.post('/canvases', (c) => c.json({ private: 'never copied' }, 201));

    const response = await app.request('https://api.example.com/canvases?secret=value', {
      method: 'POST', headers: { authorization: 'Bearer private' }, body: 'customer content',
    }, createTestEnv({ AVALON_REGION: 'global' }));
    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledWith(expect.anything(), auth, {
      operation: 'canvas_create', result: 'success', duration: '1s_5s',
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('customer content');
  });

  it('does not emit for unregistered routes and cannot change a response when emission fails', async () => {
    const emit = vi.fn(async () => { throw new Error('offline'); });
    const app = new Hono<HonoAppEnv>();
    app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    app.use('*', apiOperationTelemetry({ emit, now: sequentialClock(0, 20) }));
    app.get('/notes/:id', (c) => c.json({ id: c.req.param('id') }));
    app.post('/onboarding/workspace/activate', (c) => c.json({ activated: true }));

    expect((await app.request('/notes/private-id', undefined, createTestEnv({ AVALON_REGION: 'global' }))).status)
      .toBe(200);
    expect(emit).not.toHaveBeenCalled();
    const response = await app.request('/onboarding/workspace/activate', { method: 'POST' },
      createTestEnv({ AVALON_REGION: 'global' }));
    expect(response.status).toBe(200);
    expect(emit).not.toHaveBeenCalled();
  });

  it('carries a validated client operation ID as correlation metadata', async () => {
    const emit = vi.fn(async () => undefined);
    const app = new Hono<HonoAppEnv>();
    app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    app.use('*', apiOperationTelemetry({ emit, now: sequentialClock(0, 20) }));
    app.post('/canvases', (c) => c.json({ ok: true }, 201));
    const operationId = '018f22f2-4c22-7abc-8def-0123456789ab';

    const response = await app.request('/canvases', {
      method: 'POST', headers: { 'x-rally-operation-id': operationId },
    }, createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.anything(), auth, {
      operation: 'canvas_create',
      result: 'success',
      duration: 'lt_100ms',
      correlationOperationId: operationId,
    }));
  });

  it('classifies an expected thrown API error by status instead of as an internal failure', async () => {
    const emit = vi.fn(async () => undefined);
    const app = new Hono<HonoAppEnv>();
    app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    app.use('*', apiOperationTelemetry({ emit, now: sequentialClock(0, 20) }));
    app.post('/canvases', () => {
      throw new ApiError(409, 'workstream_conflict', 'The work stream already exists');
    });
    app.onError((error, c) => c.json({ error: 'handled' }, error instanceof ApiError ? error.status : 500));

    const response = await app.request('/canvases', { method: 'POST' },
      createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(409);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.anything(), auth, {
      operation: 'canvas_create',
      result: 'conflict',
      duration: 'lt_100ms',
    }));
  });

  it('emits once when sibling sub-apps are mounted at the same root', async () => {
    const emit = vi.fn(async () => undefined);
    const app = new Hono<HonoAppEnv>();
    app.use('*', apiOperationTelemetry({ emit }));
    const identityApi = new Hono<HonoAppEnv>();
    identityApi.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    identityApi.get('/onboarding', (c) => c.json({ ok: true }));
    app.route('/', identityApi);

    const protectedApi = new Hono<HonoAppEnv>();
    protectedApi.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    protectedApi.post('/canvases', (c) => c.json({ ok: true }, 201));
    app.route('/', protectedApi);

    const response = await app.request('/canvases', { method: 'POST' },
      createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
  });

  it('mounts the production middleware once so a real request emits one operation event', async () => {
    const accept = vi.mocked(acceptAuthenticatedTelemetry);
    accept.mockClear();
    const statement = { bind: () => statement, first: async () => ({ role: 'owner' }) };
    const env = createTestEnv({
      AVALON_REGION: 'global', APP_ENV: 'development', RALLY_DEV_AUTH: 'true', LOG_LEVEL: 'error',
      ALLOWED_ORIGINS: 'app://avalon', DB: createTestD1Database({ prepare: () => statement }),
    });

    const response = await createApp().request('https://api.example.com/canvases', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rally-dev-user-id': '00000000-0000-7000-8000-0000000000e1',
        'x-rally-dev-workspace-id': '00000000-0000-7000-8000-0000000000e2',
      },
      body: '{"title":5}',
    }, env);

    expect(response.status).toBe(400);
    await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    const batch = accept.mock.calls[0]![2];
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({
      name: 'api_operation_outcome',
      // The duration bucket depends on how fast the runner is; sequentialClock tests above pin the buckets.
      properties: { operation: 'canvas_create', result: 'validation_error', duration: expect.any(String) },
    });
  });
});

function sequentialClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
