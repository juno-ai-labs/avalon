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

  it('lists only the model flags Ace knows how to explain and edit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      success: true,
      result: [
        { key: 'agent-model-workstream', variations: { current: { model: 'x-ai/grok-4.3', fallbackModels: [] } } },
        { key: 'meeting-recording-enabled', variations: { off: false, on: true } },
        { key: 'agent-model-unregistered', variations: { current: { model: 'unknown/model', fallbackModels: [] } } },
      ],
    }));

    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/models',
    ), env({ CLOUDFLARE_ACCOUNT_ID: 'account', FLAGSHIP_APP_ID: 'app', CLOUDFLARE_FLAGSHIP_API_TOKEN: 'secret' }), {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ flags: [{
      key: 'agent-model-workstream',
      variations: { current: { model: 'x-ai/grok-4.3', fallbackModels: [] } },
    }] });
  });

  it('validates exact model ids against OpenRouter without sending the Flagship credential', async () => {
    const openrouter = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/x-ai/grok-4.3/endpoints')) {
        return Response.json({ data: { id: 'x-ai/grok-4.3', endpoints: [{ provider_name: 'xAI' }] } });
      }
      if (url.endsWith('/missing/model/endpoints')) return new Response(null, { status: 404 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/models/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ace.internal.rallywith.ai' },
        body: JSON.stringify({ modelIds: ['x-ai/grok-4.3', 'missing/model'] }),
      },
    ), env({ CLOUDFLARE_FLAGSHIP_API_TOKEN: 'must-not-leak' }), {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: [
      { modelId: 'x-ai/grok-4.3', valid: true },
      { modelId: 'missing/model', valid: false },
    ] });
    expect(openrouter).toHaveBeenCalledTimes(2);
    for (const [, init] of openrouter.mock.calls) {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    }
  });

  it('updates the default model route without dropping staged variations or targeting rules', async () => {
    const stagedRouting = { model: 'google/gemini-3.6-flash', fallbackModels: ['x-ai/grok-4.3'] };
    const rules = [{
      priority: 1,
      conditions: [{ attribute: 'workspaceId', operator: 'equals', value: 'workspace-id' }],
      serve_variation: 'next',
    }];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://openrouter.ai/api/v1/models/')) {
        const modelId = url.slice('https://openrouter.ai/api/v1/models/'.length, -'/endpoints'.length);
        return Response.json({ data: { id: modelId, endpoints: [{ provider_name: 'test' }] } });
      }
      if (url.endsWith('/flags/agent-model-workstream') && init?.method === 'PUT') {
        return Response.json({
          success: true,
          result: { key: 'agent-model-workstream', default_variation: 'current' },
        });
      }
      if (url.endsWith('/flags/agent-model-workstream')) {
        return Response.json({
          success: true,
          result: {
            key: 'agent-model-workstream',
            description: 'Work-stream agent OpenRouter models',
            enabled: true,
            default_variation: 'current',
            variations: {
              current: { model: 'x-ai/grok-4.3', fallbackModels: ['google/gemini-3.6-flash'] },
              next: stagedRouting,
            },
            rules,
            type: 'json',
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const request = new Request('https://ace.internal.rallywith.ai/api/models/workstream', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://ace.internal.rallywith.ai' },
      body: JSON.stringify({
        role: 'workstream',
        routing: { model: 'custom/primary', fallbackModels: ['custom/first', 'custom/second'] },
      }),
    });

    const response = await worker.fetch!(request, env({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      FLAGSHIP_APP_ID: 'app',
      CLOUDFLARE_FLAGSHIP_API_TOKEN: 'secret',
    }), { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/flagship/apps/app/flags/agent-model-workstream',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }),
    );
    const [, writeInit] = fetch.mock.calls.find(([input, init]) => (
      String(input).includes('api.cloudflare.com') && init?.method === 'PUT'
    ))!;
    expect(JSON.parse(String(writeInit?.body))).toEqual({
      key: 'agent-model-workstream',
      description: 'Work-stream agent OpenRouter models',
      enabled: true,
      default_variation: 'current',
      variations: {
        current: { model: 'custom/primary', fallbackModels: ['custom/first', 'custom/second'] },
        next: stagedRouting,
      },
      rules,
      type: 'json',
    });
  });

  it('rejects an unavailable OpenRouter model before reading or writing Flagship', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/models/workstream',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ace.internal.rallywith.ai' },
        body: JSON.stringify({
          role: 'workstream',
          routing: { model: 'missing/model', fallbackModels: [] },
        }),
      },
    ), env(), { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_openrouter_models',
      invalidModelIds: ['missing/model'],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain('openrouter.ai');
  });

  it('rejects a model write whose role does not match its path', async () => {
    const cloudflare = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/models/workstream',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ace.internal.rallywith.ai' },
        body: JSON.stringify({
          role: 'meeting_notes',
          routing: { model: 'custom/primary', fallbackModels: [] },
        }),
      },
    ), env(), { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(400);
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

  it('returns dynamically discovered dead-letter Queue summaries', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        success: true,
        result: [
          { queue_id: 'source-id', queue_name: 'source', consumers: [{ dead_letter_queue: 'dead' }] },
          { queue_id: 'dead-id', queue_name: 'dead', consumers: [] },
        ],
        result_info: { page: 1, total_pages: 1 },
      }))
      .mockResolvedValueOnce(Response.json({
        success: true,
        result: { backlog_bytes: 20, backlog_count: 2 },
      }));

    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/queues/dead-letters',
    ), env({ CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_FLAGSHIP_API_TOKEN: 'secret' }), {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ queues: [{
      id: 'dead-id',
      name: 'dead',
      sourceQueues: ['source'],
      metrics: { backlogBytes: 20, backlogCount: 2, oldestMessageTimestampMs: null },
    }] });
  });

  it('returns a same-origin non-consuming Queue peek', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        success: true,
        result: [
          { queue_id: 'source-id', queue_name: 'source', consumers: [{ dead_letter_queue: 'dead' }] },
          { queue_id: 'dead-id', queue_name: 'dead', consumers: [] },
        ],
        result_info: { page: 1, total_pages: 1 },
      }))
      .mockResolvedValueOnce(Response.json({
        success: true,
        result: { messages: [{ id: 'message-id', body: 'body', attempts: 2 }] },
      }));

    const response = await worker.fetch!(new Request(
      'https://ace.internal.rallywith.ai/api/queues/dead-letters/dead-id/peek',
      { method: 'POST', headers: { Origin: 'https://ace.internal.rallywith.ai' } },
    ), env({ CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_FLAGSHIP_API_TOKEN: 'secret' }), {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messages: [{
      id: 'message-id',
      attempts: 2,
      body: 'body',
      metadata: null,
      timestampMs: null,
    }] });
  });
});
