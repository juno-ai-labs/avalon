import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIENT_FEATURE_FLAGS, useClientFeatureFlags } from './use-client-feature-flags';

function wrapper(): { client: QueryClient; Wrapper: (props: PropsWithChildren) => React.JSX.Element } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    Wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}

describe('useClientFeatureFlags', () => {
  it('renders off defaults while immediately fetching the REST fallback', async () => {
    const clientFeatureFlags = vi.fn(async () => ({
      developerSettings: false,
      suggestedWorkEnabled: true,
      multipleWorkspacesEnabled: true,
      pushNotificationsEnabled: false,
    }));
    const { Wrapper } = wrapper();

    const { result } = renderHook(
      () => useClientFeatureFlags({ clientFeatureFlags }),
      { wrapper: Wrapper },
    );

    expect(result.current.data).toEqual(DEFAULT_CLIENT_FEATURE_FLAGS);
    await waitFor(() => expect(clientFeatureFlags).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.data?.suggestedWorkEnabled).toBe(true));
  });

  it('keeps defaults off without issuing a request before an API exists', () => {
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useClientFeatureFlags(null), { wrapper: Wrapper });

    expect(result.current.data).toEqual(DEFAULT_CLIENT_FEATURE_FLAGS);
    expect(result.current.fetchStatus).toBe('idle');
  });
});
