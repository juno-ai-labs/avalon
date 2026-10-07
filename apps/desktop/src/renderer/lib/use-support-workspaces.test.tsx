import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { SupportWorkspace } from '@rally/contracts';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORT_WORKSPACES_REFRESH_MS, useSupportWorkspaces } from './use-support-workspaces';

const refreshListeners = vi.hoisted(() => new Set<() => void>());

vi.mock('./platform', () => ({
  desktopBridge: () => ({
    onOrganizationListRefreshRequested: (listener: () => void) => {
      refreshListeners.add(listener);
      return () => refreshListeners.delete(listener);
    },
  }),
}));

const ACME: SupportWorkspace = { id: 'acme', name: 'Acme Robotics', region: 'global', expiresAt: '2026-10-14T00:00:00.000Z' };

function mount(list: () => Promise<SupportWorkspace[] | null>) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSupportWorkspaces('staff', list), { wrapper });
}

describe('useSupportWorkspaces', () => {
  beforeEach(() => {
    refreshListeners.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('rereads a staff member\'s list every ten minutes', async () => {
    const list = vi.fn(async () => [ACME]);
    mount(list);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(list).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(SUPPORT_WORKSPACES_REFRESH_MS - 1));
    expect(list).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stops for an account that is not Rally staff', async () => {
    const list = vi.fn(async () => null);
    mount(list);
    await act(() => vi.advanceTimersByTimeAsync(3 * SUPPORT_WORKSPACES_REFRESH_MS));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('rereads at once when View → Refresh Organization List is chosen', async () => {
    const list = vi.fn(async () => [ACME]);
    mount(list);
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => { for (const listener of refreshListeners) listener(); });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(list).toHaveBeenCalledTimes(2);
  });
});
