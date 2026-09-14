import { afterEach, expect, it, vi } from 'vitest';
import { sendApns } from '../src/services/push/apns-transport';
import { createTestEnv } from './helpers/cloudflare-test';
afterEach(() => vi.unstubAllGlobals());
it('maps provider answers without disabling devices on a provider credential failure', async () => {
  const del = vi.fn();
  const env = createTestEnv({ APP_ENV: 'staging', APNS_AUTH_KEY: 'unused cached key', APNS_KEY_ID: 'KEY',
    INFERENCE_PRICING_CACHE: { get: async () => ({ token: 'cached', iat: Math.floor(Date.now() / 1000) }), delete: del } });
  const request = vi.fn(async () => Response.json({ reason: 'TooManyProviderTokenUpdates' }, { status: 429 }));
  vi.stubGlobal('fetch', request);
  const device = { id: 'device', token: 'ab'.repeat(32), topic: 'ai.rallywith.desktop', last_seen_at: '2026-09-14' };
  expect((await sendApns(env, device, '{}', 'collapse')).outcome).toBe('provider_token_throttled');
  expect(del).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(Response.json({ reason: 'InvalidProviderToken' }, { status: 403 }));
  expect((await sendApns(env, device, '{}', 'collapse')).outcome).toBe('provider_auth_failed');
  expect(del).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce(Response.json({ reason: 'Unregistered', timestamp: 123 }, { status: 410 }));
  expect(await sendApns(env, device, '{}', 'collapse')).toMatchObject({ outcome: 'unregistered', timestamp: 123 });
  request.mockResolvedValueOnce(Response.json({ reason: 'TooManyRequests' }, { status: 429 }));
  expect((await sendApns(env, device, '{}', 'collapse')).outcome).toBe('transient');
});
