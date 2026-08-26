import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { createTestEnv, createTestQueue } from './helpers/cloudflare-test';

function env(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    APP_ENV: 'development',
    ACE_DEV_AUTH: 'true',
    APP_VERSION: 'test',
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    ...overrides,
  });
}

describe('Ace Hono application', () => {
  afterEach(() => vi.restoreAllMocks());
  it('serves the operator session through the local Access bypass', async () => {
    const response = await worker.fetch!(new Request('https://ace.internal.rallywith.ai/api/session'), env(), {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {},
    } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: 'developer@local', version: 'test' });
  });

  it('fails closed when Access is not configured', async () => {
    const response = await worker.fetch!(new Request('https://ace.internal.rallywith.ai/'), env({
      APP_ENV: 'production',
    }), { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'access_not_configured' });
  });

  it('writes an enabled-named flag to Flagship and queues only its key after success', async () => {
    const send = vi.fn(async () => undefined);
    const cloudflare = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      success: true,
      result: { key: 'meeting-recording-enabled', default_variation: 'off' },
    }));
    const request = new Request('https://ace.internal.rallywith.ai/api/flags/meeting-recording-enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://ace.internal.rallywith.ai' },
      body: JSON.stringify({
        key: 'meeting-recording-enabled',
        description: 'Meeting Recording Enabled',
        enabled: true,
        default_variation: 'off',
        rules: [],
      }),
    });
    const response = await worker.fetch!(request, env({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      FLAGSHIP_APP_ID: 'app',
      CLOUDFLARE_FLAGSHIP_API_TOKEN: 'secret',
      PRODUCT_FLAG_CHANGE_QUEUE: createTestQueue({ send }),
    }), { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    expect(cloudflare).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/flagship/apps/app/flags/meeting-recording-enabled',
      expect.objectContaining({ method: 'PUT' }),
    );
    const [, requestInit] = cloudflare.mock.calls[0]!;
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      variations: { off: false, on: true },
    });
    expect(send).toHaveBeenCalledWith(
      { kind: 'flagship_product_flag_changed', flagKey: 'meeting-recording-enabled' },
      { delaySeconds: 30 },
    );
  });

  it('rejects a cross-origin write before it reaches Flagship', async () => {
    const cloudflare = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/flags/hypersight-enabled',
      { method: 'PUT', headers: { Origin: 'https://attacker.example' } },
    ), env(), { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(403);
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin Queue peek before it reaches Cloudflare', async () => {
    const cloudflare = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/queues/dead-letters/queue-id/peek',
      { method: 'POST', headers: { Origin: 'https://attacker.example' } },
    ), env(), { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(403);
    expect(cloudflare).not.toHaveBeenCalled();
  });
});
