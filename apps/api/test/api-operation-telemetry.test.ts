import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { HonoAppEnv } from '../src/env';
import { ApiError } from '../src/lib/api-error';
import { apiOperationTelemetry } from '../src/middleware/api-operation-telemetry';
import { createTestEnv } from './helpers/cloudflare-test';

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
    app.post('/workstreams', (c) => c.json({ private: 'never copied' }, 201));

    const response = await app.request('https://api.example.com/workstreams?secret=value', {
      method: 'POST', headers: { authorization: 'Bearer private' }, body: 'customer content',
    }, createTestEnv({ AVALON_REGION: 'global' }));
    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledWith(expect.anything(), auth, {
      operation: 'workstream_create', result: 'success', duration: '1s_5s',
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
    app.post('/workstreams', (c) => c.json({ ok: true }, 201));
    const operationId = '018f22f2-4c22-7abc-8def-0123456789ab';

    const response = await app.request('/workstreams', {
      method: 'POST', headers: { 'x-rally-operation-id': operationId },
    }, createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.anything(), auth, {
      operation: 'workstream_create',
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
    app.post('/workstreams', () => {
      throw new ApiError(409, 'workstream_conflict', 'The work stream already exists');
    });
    app.onError((error, c) => c.json({ error: 'handled' }, error instanceof ApiError ? error.status : 500));

    const response = await app.request('/workstreams', { method: 'POST' },
      createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(409);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.anything(), auth, {
      operation: 'workstream_create',
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
    protectedApi.post('/workstreams', (c) => c.json({ ok: true }, 201));
    app.route('/', protectedApi);

    const response = await app.request('/workstreams', { method: 'POST' },
      createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
  });

  it('mounts the production middleware once above the sibling sub-apps', () => {
    const source = readFileSync(`${process.cwd()}/src/app.ts`, 'utf8');
    expect(source.match(/apiOperationTelemetry\(\)/gu)).toHaveLength(1);
    expect(source.indexOf('apiOperationTelemetry()')).toBeLessThan(source.indexOf('app.route("/health"'));
  });
});

function sequentialClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
