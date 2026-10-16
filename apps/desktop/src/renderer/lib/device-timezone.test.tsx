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

afterEach(() => { vi.restoreAllMocks(); });

describe('useDeviceTimezoneSync', () => {
  it('reports the device zone at launch and on every focus, since another device may have moved the account', async () => {
    deviceIn('Europe/Berlin');
    const reportDeviceTimezone = vi.fn(async (timezone: string) => ({ timezone, followsDevice: true }));
    const { client, Wrapper } = wrapper();

    renderHook(() => useDeviceTimezoneSync({ reportDeviceTimezone }, true), { wrapper: Wrapper });

    await waitFor(() => expect(client.getQueryData(MY_TIMEZONE_QUERY_KEY))
      .toEqual({ timezone: 'Europe/Berlin', followsDevice: true }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(reportDeviceTimezone).toHaveBeenCalledTimes(2));
    expect(reportDeviceTimezone).toHaveBeenLastCalledWith('Europe/Berlin');
  });

  it('drops a report that lands after the account it was sent for is gone', async () => {
    deviceIn('Europe/Berlin');
    let land!: (state: { timezone: string; followsDevice: boolean }) => void;
    const reportDeviceTimezone = vi.fn(() => new Promise<{ timezone: string; followsDevice: boolean }>((resolve) => { land = resolve; }));
    const { client, Wrapper } = wrapper();

    const { unmount } = renderHook(() => useDeviceTimezoneSync({ reportDeviceTimezone }, true), { wrapper: Wrapper });
    unmount();
    await act(async () => { land({ timezone: 'Europe/Berlin', followsDevice: true }); });

    expect(client.getQueryData(MY_TIMEZONE_QUERY_KEY)).toBeUndefined();
  });

  it('reports nothing during a support session', () => {
    deviceIn('Europe/Berlin');
    const reportDeviceTimezone = vi.fn(async (timezone: string) => ({ timezone, followsDevice: true }));
    const { Wrapper } = wrapper();

    renderHook(() => useDeviceTimezoneSync({ reportDeviceTimezone }, false), { wrapper: Wrapper });

    expect(reportDeviceTimezone).not.toHaveBeenCalled();
  });
});
