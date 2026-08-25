import { describe, expect, it, vi } from 'vitest';
import { refreshTelemetryCapability, resolveTelemetryRoute } from './telemetry-route';

const anonymousEpochId = '018f0000-0000-7000-8000-000000000001';
const bootstrap = {
  journeyId: '018f0000-0000-7000-8000-000000000002',
  route: 'eu' as const,
  routingBasis: 'ip_geolocation' as const,
  capability: 'c'.repeat(64),
  expiresAt: '2026-08-12T21:00:00.000Z',
};

describe('desktop telemetry route gate', () => {
  it('uses an explicit signed-in workspace binding without asking Global geolocation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(resolveTelemetryRoute({
      explicitRegion: 'eu', anonymousEpochId, globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
    })).resolves.toEqual({ route: 'eu', basis: 'explicit_binding', anonymous: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the coarse Cloudflare result and retains only its route-fixed capability', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(bootstrap), {
      status: 201, headers: { 'content-type': 'application/json' },
    }));
    await expect(resolveTelemetryRoute({
      explicitRegion: null, anonymousEpochId, globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
    })).resolves.toEqual({ route: 'eu', basis: 'ip_geolocation', anonymous: bootstrap });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ anonymousEpochId });
  });

  it('falls back immediately to Global with no replay capability on failure or malformed data', async () => {
    const failed = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    await expect(resolveTelemetryRoute({
      explicitRegion: null, anonymousEpochId, globalApiBaseUrl: 'https://api.rallywith.ai', fetch: failed,
    })).resolves.toEqual({ route: 'global', basis: 'geolocation_fallback', anonymous: null });

    const malformed = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 201 }));
    await expect(resolveTelemetryRoute({
      explicitRegion: null, anonymousEpochId, globalApiBaseUrl: 'https://api.rallywith.ai', fetch: malformed,
    })).resolves.toEqual({ route: 'global', basis: 'geolocation_fallback', anonymous: null });
  });

  it('refreshes only the same journey and rejects a route change', async () => {
    const current = { route: 'eu' as const, basis: 'ip_geolocation' as const, anonymous: bootstrap };
    const refreshed = { ...bootstrap, capability: 'd'.repeat(64), expiresAt: '2026-08-12T22:00:00.000Z' };
    const matching = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(refreshed), {
      status: 201, headers: { 'content-type': 'application/json' },
    }));
    await expect(refreshTelemetryCapability({
      current, anonymousEpochId, globalApiBaseUrl: 'https://api.rallywith.ai', fetch: matching,
    })).resolves.toEqual(refreshed);

    const moved = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      ...refreshed, route: 'global', routingBasis: 'geolocation_fallback',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    await expect(refreshTelemetryCapability({
      current, anonymousEpochId, globalApiBaseUrl: 'https://api.rallywith.ai', fetch: moved,
    })).resolves.toBeNull();
  });
});
