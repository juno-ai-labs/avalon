import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useClientFeatureFlags } from './use-client-feature-flags';

function wrapper(): { client: QueryClient; Wrapper: (props: PropsWithChildren) => React.JSX.Element } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    Wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}

describe('useClientFeatureFlags', () => {
  it('offers organization switching immediately and honors an explicit server opt-out', async () => {
    const clientFeatureFlags = vi.fn(async () => ({
      developerSettings: false,
      multipleWorkspacesEnabled: false,
      pushNotificationsEnabled: false,
    }));
    const { Wrapper } = wrapper();

    const { result } = renderHook(
      () => useClientFeatureFlags({ clientFeatureFlags }),
      { wrapper: Wrapper },
    );

    expect(result.current.data).toEqual({
      developerSettings: false, multipleWorkspacesEnabled: true, pushNotificationsEnabled: false,
    });
    await waitFor(() => expect(clientFeatureFlags).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.data?.multipleWorkspacesEnabled).toBe(false));
  });

  it('keeps organization switching available without issuing a request before an API exists', () => {
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useClientFeatureFlags(null), { wrapper: Wrapper });

    expect(result.current.data).toEqual({
      developerSettings: false, multipleWorkspacesEnabled: true, pushNotificationsEnabled: false,
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('keeps organization switching available when the flag read fails', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useClientFeatureFlags({
      clientFeatureFlags: async () => { throw new Error('offline'); },
    }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data?.multipleWorkspacesEnabled).toBe(true);
  });
});
