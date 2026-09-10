import type { Env } from '../src/env';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { createExecutionContext, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../src/worker-events';

beforeEach(async () => { await reset(); });
it('refuses anonymous traffic with the real rate binding before the authority database read', async () => {
  const key = crypto.randomUUID();
  await env.ACCESS_EDGE_RATE_LIMITER!.limit({ key });
  await env.ACCESS_EDGE_RATE_LIMITER!.limit({ key });
  // D1 deliberately has no authority schema. Reaching it fails, rather than a
  // mocked database claiming it was not used. The platform limiter is real.
  const response = await worker.fetch(new Request('https://api.rallywith.ai/access/requests', {
    method: 'POST', headers: { origin: 'https://rallywith.ai', 'cf-connecting-ip': key, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'unused@example.com' }),
  }), { ...env, ALLOWED_ORIGINS: 'https://rallywith.ai', AVALON_REGION: 'global' }, createExecutionContext());
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ error: { code: 'access_request_rate_limited' } });
  expect(response.headers.get('access-control-allow-origin')).toBe('https://rallywith.ai');
});

it('refuses production without a limiter and serves preflight without touching D1', async () => {
  const request = new Request('https://api.rallywith.ai/access/requests', { method: 'POST', headers: { origin: 'https://rallywith.ai' } });
  const bindings: Env = { ...env, APP_ENV: 'production' as const, AVALON_REGION: 'global' as const, PUBLIC_API_BASE_URL: 'https://api.rallywith.ai', ALLOWED_ORIGINS: 'https://rallywith.ai' };
  delete bindings.ACCESS_EDGE_RATE_LIMITER;
  const refusal = await worker.fetch(request, bindings, createExecutionContext());
  expect(refusal.status).toBe(503);
  expect(await refusal.json()).toMatchObject({ error: { code: 'access_unavailable' } });
  expect((await worker.fetch(new Request(request.url, { method: 'OPTIONS', headers: { origin: 'https://rallywith.ai' } }), bindings, createExecutionContext())).status).toBe(204);
});


it('refuses encoded acquisition paths before they can bypass the pre-database boundary', async () => {
  for (const path of ['/%61ccess/requests', '/access/%72equests', '/%61ccess/downloads/redeem']) {
    const response = await worker.fetch(new Request(`https://api.rallywith.ai${path}`, { method: 'POST' }), env, createExecutionContext());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  }
});
