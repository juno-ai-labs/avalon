import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MY_TIMEZONE_QUERY_KEY, useDeviceTimezoneSync } from './device-timezone';

function wrapper(): { client: QueryClient; Wrapper: (props: PropsWithChildren) => React.JSX.Element } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, Wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}

function deviceIn(zone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockReturnValue({ timeZone: zone } as Intl.ResolvedDateTimeFormatOptions);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useDeviceTimezoneSync', () => {
  it('reports the device zone once, and again only after the device moves', async () => {
    deviceIn('Europe/Berlin');
    const reportDeviceTimezone = vi.fn(async (timezone: string) => ({ timezone, followsDevice: true }));
    const { client, Wrapper } = wrapper();

    renderHook(() => useDeviceTimezoneSync({ reportDeviceTimezone }, 'user-1', true), { wrapper: Wrapper });

    await waitFor(() => expect(client.getQueryData(MY_TIMEZONE_QUERY_KEY))
      .toEqual({ timezone: 'Europe/Berlin', followsDevice: true }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(reportDeviceTimezone).toHaveBeenCalledTimes(1);

    deviceIn('Asia/Tokyo');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(reportDeviceTimezone).toHaveBeenLastCalledWith('Asia/Tokyo'));
    expect(reportDeviceTimezone).toHaveBeenCalledTimes(2);
  });

  it('reports nothing during a support session', () => {
    deviceIn('Europe/Berlin');
    const reportDeviceTimezone = vi.fn(async (timezone: string) => ({ timezone, followsDevice: true }));
    const { Wrapper } = wrapper();

    renderHook(() => useDeviceTimezoneSync({ reportDeviceTimezone }, 'user-1', false), { wrapper: Wrapper });

    expect(reportDeviceTimezone).not.toHaveBeenCalled();
  });
});
