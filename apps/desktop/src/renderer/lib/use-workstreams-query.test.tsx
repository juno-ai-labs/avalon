import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { WorkstreamSummary } from './types';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from './use-workstreams-query';

const getWorkstreams = vi.hoisted(() => vi.fn());
const getApplicationSettings = vi.hoisted(() => vi.fn());
const settingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());

vi.mock('./app-session', () => ({ useAppSession: () => ({ api: { getWorkstreams } }) }));
vi.mock('./platform', () => ({
  desktopBridge: () => ({
    getApplicationSettings,
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
  }),
}));

function announce(settings: DesktopApplicationSettings): void {
  act(() => {
    for (const listener of settingsListeners) listener(settings);
  });
}

function summary(id: string, title: string): WorkstreamSummary {
  return {
    id,
    title,
    scope: 'workspace',
    systemKind: null,
    harnessStatus: 'idle',
    lastActivityAt: '2026-08-11T12:00:00.000Z',
    unreadCount: 0,
  } as unknown as WorkstreamSummary;
}

describe('useWorkstreamsQuery', () => {
  let queryClient: QueryClient;

  function wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    settingsListeners.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getWorkstreams.mockReset();
    getWorkstreams.mockResolvedValue([summary('workstream-1', 'Launch brief')]);
    getApplicationSettings.mockReset();
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: false,
      developerSettingsAvailable: true,
    });
  });

  it('stores the list under the unparameterized key producers write to', async () => {
    const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(WORKSTREAMS_QUERY_KEY).toEqual(['workstreams']);
    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual(result.current.data);
  });

  // The regression this hook exists to prevent: realtime handlers, renames and
  // read-state callbacks patch the cache directly, so a key that varied with
  // the debug preference would strand every one of those writes.
  it('serves a direct cache write while debugging is on', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: true,
      developerSettingsAvailable: true,
    });
    const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    act(() => {
      queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
        current?.map((item) => ({ ...item, title: 'Renamed in place' })),
      );
    });

    await waitFor(() => expect(result.current.data?.[0]?.title).toBe('Renamed in place'));
  });

  it('asks for system work streams only while debugging is on, without a duplicate first fetch', async () => {
    const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(getWorkstreams).toHaveBeenCalledTimes(1);
    expect(getWorkstreams.mock.calls[0]?.[1]).toBe(false);

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, launchAtLogin: true, launchAtLoginAvailable: true });

    await waitFor(() => expect(getWorkstreams).toHaveBeenCalledTimes(2));
    expect(getWorkstreams.mock.calls[1]?.[1]).toBe(true);
  });
});
