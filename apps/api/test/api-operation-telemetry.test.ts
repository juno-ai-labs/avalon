import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { HonoAppEnv } from '../src/env';
import { apiOperationTelemetry } from '../src/middleware/api-operation-telemetry';
import { createTestEnv } from './helpers/cloudflare-test';

const auth = {
  sessionId: 'session', userId: 'user', workspaceId: 'workspace', region: 'global' as const,
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
      method: 'POST', headers: { 'x-avalon-operation-id': operationId },
    }, createTestEnv({ AVALON_REGION: 'global' }));

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.anything(), auth, {
      operation: 'workstream_create',
      result: 'success',
      duration: 'lt_100ms',
      correlationOperationId: operationId,
    }));
  });
});

function sequentialClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
