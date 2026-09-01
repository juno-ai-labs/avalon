import { describe, expect, it, vi } from 'vitest';
import { requestWithOnboardingIdentity } from './onboarding-identity-request';

const identity = {
  accessToken: 'expired-access-token',
  refreshToken: 'identity-refresh-token',
};

describe('onboarding identity requests', () => {
  it('refreshes the exact identity credential and retries one rejected request', async () => {
    const renewed = { ...identity, accessToken: 'renewed-access-token' };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const refresh = vi.fn().mockResolvedValue(renewed);

    const result = await requestWithOnboardingIdentity({
      load: vi.fn().mockResolvedValue(identity),
      refresh,
      fetch,
    });

    expect(result.identity).toBe(renewed);
    expect(result.response.status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(1, identity);
    expect(fetch).toHaveBeenNthCalledWith(2, renewed);
    expect(refresh).toHaveBeenCalledWith(identity);
  });

  it('does not refresh for a non-authentication refusal', async () => {
    const response = new Response(null, { status: 403 });
    const refresh = vi.fn();

    const result = await requestWithOnboardingIdentity({
      load: vi.fn().mockResolvedValue(identity),
      refresh,
      fetch: vi.fn().mockResolvedValue(response),
    });

    expect(result).toEqual({ identity, response });
    expect(refresh).not.toHaveBeenCalled();
  });
});
