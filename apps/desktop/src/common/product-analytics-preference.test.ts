import { describe, expect, it, vi } from 'vitest';
import { RallyApiResponseError } from '../main/api-response-error';
import { ProductAnalyticsPreferenceClient } from './product-analytics-preference';

describe('shared account analytics preference protocol', () => {
  it('uses one versioned account endpoint for reads and writes', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ enabled: false, version: 7 })
      .mockResolvedValueOnce({ enabled: true, version: 8 });
    const client = new ProductAnalyticsPreferenceClient(request);
    const signal = new AbortController().signal;
    expect(await client.read(signal)).toEqual({ enabled: false, version: 7 });
    expect(await client.update(true, 7)).toEqual({ enabled: true, version: 8 });
    expect(request.mock.calls).toEqual([
      ['/telemetry/preference', { method: 'GET', schema: expect.anything(), signal }],
      ['/telemetry/preference', { method: 'PATCH', schema: expect.anything(), body: { enabled: true, expectedVersion: 7 } }],
    ]);
  });

  it('adopts the current account preference on a native transport conflict without retrying PATCH', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new RallyApiResponseError('Preference changed', 409, 'preference_conflict'))
      .mockResolvedValueOnce({ enabled: true, version: 9 });
    const client = new ProductAnalyticsPreferenceClient(request);
    expect(await client.update(false, 7)).toEqual({ enabled: true, version: 9 });
    expect(request.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
      ['/telemetry/preference', 'PATCH'], ['/telemetry/preference', 'GET'],
    ]);
  });

  it('preserves a failed native save for the desktop controller to retry later', async () => {
    const error = new RallyApiResponseError('Unavailable', 503);
    const request = vi.fn().mockRejectedValue(error);
    await expect(new ProductAnalyticsPreferenceClient(request).update(false, 7)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
