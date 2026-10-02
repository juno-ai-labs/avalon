import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { FlagAdministration } from '../src/flag-administration';
import { createTestEnv, createTestQueue } from './helpers/cloudflare-test';

const actor = { subject: 'engineer-1', email: 'engineer@rallywith.ai' };
const flagshipBase = 'https://api.cloudflare.com/client/v4/accounts/account/flagship/apps/app/flags';

function administration(overrides: Partial<Env> = {}): FlagAdministration {
  return new FlagAdministration({ waitUntil: vi.fn() } as unknown as ExecutionContext, createTestEnv({
    CLOUDFLARE_ACCOUNT_ID: 'account',
    FLAGSHIP_APP_ID: 'app',
    CLOUDFLARE_FLAGSHIP_API_TOKEN: 'secret',
    PRODUCT_FLAG_CHANGE_QUEUE: createTestQueue({ send: vi.fn(async () => undefined) }),
    ...overrides,
  }));
}

const liveArtifactsUpdate = {
  key: 'live-artifacts-enabled',
  description: 'Live artifacts.',
  enabled: true,
  default_variation: 'off',
  rules: [{
    priority: 1,
    conditions: [{ attribute: 'userEmailDomain', operator: 'equals', value: 'rallywith.ai' }],
    serve_variation: 'on',
  }],
};

describe('FlagAdministration', () => {
  it('lists every managed product flag beside its live definition, null where none is provisioned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      success: true,
      result: [
        { key: 'digests-enabled', enabled: true, default_variation: 'on', rules: [] },
        { key: 'agent-model-workstream', variations: {} },
      ],
    }));

    const result = await administration().listProductFlags();

    expect(result.ok).toBe(true);
    const flags = result.ok ? result.value : [];
    expect(flags.find((flag) => flag.key === 'digests-enabled')).toEqual({
      key: 'digests-enabled',
      label: 'Digests Enabled',
      description: expect.any(String),
      defaultVariation: 'on',
      flag: { key: 'digests-enabled', enabled: true, default_variation: 'on', rules: [] },
    });
    expect(flags.find((flag) => flag.key === 'suggested-work-enabled')?.flag).toBeNull();
    expect(flags.map((flag) => flag.key)).not.toContain('agent-model-workstream');
  });

  it('writes a product flag to Flagship, queues its key, and records the engineer', async () => {
    const send = vi.fn(async () => undefined);
    const cloudflare = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      success: true,
      result: { key: 'live-artifacts-enabled', default_variation: 'off' },
    }));
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await administration({ PRODUCT_FLAG_CHANGE_QUEUE: createTestQueue({ send }) })
      .updateProductFlag({ actor, update: liveArtifactsUpdate });

    expect(result).toEqual({ ok: true, value: { key: 'live-artifacts-enabled', default_variation: 'off' } });
    expect(cloudflare).toHaveBeenCalledWith(
      `${flagshipBase}/live-artifacts-enabled`,
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(JSON.parse(String(cloudflare.mock.calls[0]![1]?.body))).toEqual({
      ...liveArtifactsUpdate,
      variations: { off: false, on: true },
    });
    expect(send).toHaveBeenCalledWith(
      { kind: 'flagship_product_flag_changed', flagKey: 'live-artifacts-enabled' },
      { delaySeconds: 30 },
    );
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([{
      event: 'ace_product_flag_updated',
      actor_subject: 'engineer-1',
      via: 'engineering_mcp',
      flag_key: 'live-artifacts-enabled',
    }]);
  });

  it('refuses a definition naming the field it rejected, before any Flagship I/O', async () => {
    const cloudflare = vi.spyOn(globalThis, 'fetch');

    const result = await administration().updateProductFlag({
      actor,
      update: { ...liveArtifactsUpdate, rules: [{ ...liveArtifactsUpdate.rules[0], serve_variation: 'maybe' }] },
    });

    expect(result).toEqual({
      ok: false,
      code: 'flag_update_invalid:rules.0.serve_variation:invalid_value',
      message: expect.stringContaining('rules.0.serve_variation'),
    });
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it('names a Flagship refusal by its status without forwarding its text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(
      { success: false, errors: [{ message: 'Authentication error' }] },
      { status: 403 },
    ));

    const result = await administration().updateProductFlag({ actor, update: liveArtifactsUpdate });

    expect(result).toEqual({
      ok: false,
      code: 'flagship_request_failed_403',
      message: 'Flagship refused the request with HTTP 403. Nothing was changed by this call.',
    });
  });

  it('says the save landed and records the engineer when only the client notification failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ success: true, result: {} }));
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await administration({
      PRODUCT_FLAG_CHANGE_QUEUE: createTestQueue({ send: vi.fn(async () => { throw new Error('queue down'); }) }),
    }).updateProductFlag({ actor, update: liveArtifactsUpdate });

    expect(result).toEqual({
      ok: false,
      code: 'flag_change_notification_failed',
      message: expect.stringContaining('Flagship saved the flag'),
    });
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([{
      event: 'ace_product_flag_updated',
      actor_subject: 'engineer-1',
      via: 'engineering_mcp',
      flag_key: 'live-artifacts-enabled',
    }]);
  });

  it('refuses a model OpenRouter does not route before reading or writing Flagship', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    const result = await administration().updateModelRouting({
      actor,
      update: { role: 'workstream', routing: { model: 'example/missing', fallbackModels: [] } },
    });

    expect(result).toEqual({
      ok: false,
      code: 'invalid_openrouter_models',
      message: 'OpenRouter does not recognize or currently route: example/missing',
    });
    expect(fetch.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('api.cloudflare.com'))).toEqual([]);
  });

  it('replaces only the default route of a model flag and records the engineer', async () => {
    const rules = [{ priority: 1, conditions: [], serve_variation: 'next' }];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://openrouter.ai/')) {
        const id = url.slice('https://openrouter.ai/api/v1/models/'.length, -'/endpoints'.length);
        return Response.json({ data: { id, endpoints: [{}] } });
      }
      if (init?.method === 'PUT') return Response.json({ success: true, result: { key: 'agent-model-workstream' } });
      return Response.json({
        success: true,
        result: {
          key: 'agent-model-workstream',
          enabled: true,
          default_variation: 'current',
          variations: { current: { model: 'old/model', fallbackModels: [] }, next: { model: 'staged/model', fallbackModels: [] } },
          rules,
        },
      });
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await administration().updateModelRouting({
      actor,
      update: { role: 'workstream', routing: { model: 'new/model', fallbackModels: ['new/fallback'] } },
    });

    expect(result).toEqual({ ok: true, value: { key: 'agent-model-workstream' } });
    const [, write] = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(write?.body))).toMatchObject({
      default_variation: 'current',
      variations: {
        current: { model: 'new/model', fallbackModels: ['new/fallback'] },
        next: { model: 'staged/model', fallbackModels: [] },
      },
      rules,
    });
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([{
      event: 'ace_agent_model_updated',
      actor_subject: 'engineer-1',
      via: 'engineering_mcp',
      agent_role: 'workstream',
    }]);
  });
});
