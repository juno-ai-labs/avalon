import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_MODEL_VALIDATION_TIMEOUT_MS,
  validateOpenRouterModel,
  validateOpenRouterModels,
} from '../src/openrouter';

describe('Ace OpenRouter model validation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requires an exact id with at least one live endpoint', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        data: { id: 'provider/model', endpoints: [{ provider_name: 'provider' }] },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { id: 'provider/different-model', endpoints: [{ provider_name: 'provider' }] },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { id: 'provider/model', endpoints: [] },
      }));

    await expect(validateOpenRouterModel('provider/model')).resolves.toEqual({
      modelId: 'provider/model', valid: true,
    });
    await expect(validateOpenRouterModel('provider/model')).resolves.toEqual({
      modelId: 'provider/model', valid: false,
    });
    await expect(validateOpenRouterModel('provider/model')).resolves.toEqual({
      modelId: 'provider/model', valid: false,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects a malformed id without contacting OpenRouter and deduplicates a route', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      data: { id: 'provider/model', endpoints: [{}] },
    }));

    await expect(validateOpenRouterModel('not-a-route')).resolves.toEqual({
      modelId: 'not-a-route', valid: false,
    });
    await expect(validateOpenRouterModels(['provider/model', ' provider/model '])).resolves.toEqual([
      { modelId: 'provider/model', valid: true },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when OpenRouter validation is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    await expect(validateOpenRouterModel('provider/model')).rejects.toThrow(
      'OpenRouter model validation failed (503)',
    );
  });

  it('aborts a stalled OpenRouter request at the operator-selected deadline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal = new AbortController().signal;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => await new Promise<Response>(
      (_resolve, reject) => {
        requestSignal = init?.signal ?? requestSignal;
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      },
    ));

    const validation = validateOpenRouterModel('provider/model');
    const rejection = expect(validation).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(OPENROUTER_MODEL_VALIDATION_TIMEOUT_MS - 1);
    expect(requestSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal.aborted).toBe(true);
    await rejection;
  });
});
