import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { WorkstreamSummary } from './types';
import { WORKSTREAMS_QUERY_KEY, useCachedWorkstreams, useWorkstreamsQuery } from './use-workstreams-query';
import { setCachedWorkstreams } from './workstreams-cache';

const listWorkstreams = vi.hoisted(() => vi.fn());
const socket = vi.hoisted(() => ({
  sidebarConnect: null as { generation: number; nextCursor: string | null } | null,
}));
const getApplicationSettings = vi.hoisted(() => vi.fn());
const settingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());

vi.mock('./workspace-socket', () => ({
  useWorkspaceSocket: () => ({ listWorkstreams, sidebarConnect: socket.sidebarConnect }),
}));
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
    titleStatus: 'settled',
    scope: 'workspace',
    harnessStatus: 'completed',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    lastActivityAt: '2026-08-11T12:00:00.000Z',
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
  } satisfies WorkstreamSummary;
}

describe('useWorkstreamsQuery', () => {
  let queryClient: QueryClient;

  function wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  /**
   * Stand in for the workspace socket's connect payload, which the provider —
   * not this hook — writes. Everything here starts from that having happened,
   * because that is the only way the first page ever arrives now.
   */
  function landConnectPayload(
    rerender: () => void,
    { items = [summary('workstream-1', 'Launch brief')], nextCursor = null as string | null } = {},
  ): void {
    act(() => {
      setCachedWorkstreams(queryClient, items);
      socket.sidebarConnect = {
        generation: (socket.sidebarConnect?.generation ?? 0) + 1,
        nextCursor,
      };
    });
    act(() => rerender());
  }

  beforeEach(() => {
    settingsListeners.clear();
    socket.sidebarConnect = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    listWorkstreams.mockReset();
    listWorkstreams.mockResolvedValue({
      items: [summary('workstream-1', 'Launch brief')],
      nextCursor: null,
    });
    getApplicationSettings.mockReset();
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: false,
      developerSettingsAvailable: true,
    });
  });

  it('stores the list under the unparameterized key producers write to', async () => {
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    landConnectPayload(rerender);
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(WORKSTREAMS_QUERY_KEY).toEqual(['workstreams']);
    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual(result.current.data);
  });

  // The round trip the connect payload exists to remove. A mount that asks for
  // the first page anyway has put it straight back.
  it('never asks for the first page: the connect payload is what delivers it', async () => {
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    // Before the payload there is nothing to render and nothing to ask for.
    expect(result.current.data).toBeUndefined();
    expect(listWorkstreams).not.toHaveBeenCalled();

    landConnectPayload(rerender, { nextCursor: 'cursor-1' });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(listWorkstreams).not.toHaveBeenCalled();
    // The payload's cursor is adopted, so the first scroll continues from it.
    expect(result.current.hasMore).toBe(true);
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
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    landConnectPayload(rerender);
    // Turning debugging on reloads the directory, so let that land before
    // patching: the point here is that the patch survives, not that it races.
    await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    act(() => {
      setCachedWorkstreams(queryClient, (current) =>
        current?.map((item) => ({ ...item, title: 'Renamed in place' })),
      );
    });

    await waitFor(() => expect(result.current.data?.[0]?.title).toBe('Renamed in place'));
  });

  // Debugging is the one thing the connect payload deliberately does not serve:
  // the server has no idea the preference is on, so a viewer who wants system
  // rows asks for the wider directory themselves. Rare, and engineers only.
  it('asks for the wider directory itself when debugging turns on', async () => {
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    landConnectPayload(rerender);
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(listWorkstreams).not.toHaveBeenCalled();

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(1));
    expect(listWorkstreams.mock.calls[0]?.[0]).toMatchObject({ includeSystem: true });
    expect(listWorkstreams.mock.calls[0]?.[0]).not.toHaveProperty('before');
  });

  describe('paging', () => {
    function pagedList(): void {
      listWorkstreams.mockReset();
      listWorkstreams.mockImplementation(async (
        input: { before?: string },
      ) => input.before === 'cursor-1'
        ? { items: [summary('workstream-2', 'Second page')], nextCursor: null }
        : { items: [summary('workstream-1', 'First page')], nextCursor: 'cursor-1' });
    }

    it('reports a further page and appends it without refetching the first', async () => {
      pagedList();
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender, {
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
      });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      expect(result.current.hasMore).toBe(true);

      act(() => result.current.fetchMore());

      await waitFor(() => expect(result.current.data).toHaveLength(2));
      // One request for the page itself: appending is what makes reaching the
      // bottom cost a page rather than the whole list again.
      expect(listWorkstreams).toHaveBeenCalledTimes(1);
      expect(listWorkstreams.mock.calls[0]?.[0]).toMatchObject({ before: 'cursor-1' });
      expect(result.current.data?.map((item) => item.id))
        .toEqual(['workstream-1', 'workstream-2']);
      // The end of the list, so nothing asks again.
      expect(result.current.hasMore).toBe(false);
    });

    it('stops at the end rather than asking for a page that is not there', async () => {
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender);
      await waitFor(() => expect(result.current.data).toHaveLength(1));

      expect(result.current.hasMore).toBe(false);
      act(() => result.current.fetchMore());

      expect(listWorkstreams).not.toHaveBeenCalled();
    });

    // The regression a hand-rolled pager invites: a refetch that walked only
    // the first page would truncate the list under somebody who had scrolled.
    it('reloads every page already on screen when the list refetches', async () => {
      pagedList();
      // Startup's observer mounts first and must never register a second pager.
      const observer = renderHook(() => useCachedWorkstreams(), { wrapper });
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender, {
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
      });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.data).toHaveLength(2));

      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      });

      await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(3));
      expect(listWorkstreams.mock.calls[1]?.[0]).not.toHaveProperty('before');
      expect(listWorkstreams.mock.calls[2]?.[0]).toMatchObject({ before: 'cursor-1' });
      expect(result.current.data?.map((item) => item.id))
        .toEqual(['workstream-1', 'workstream-2']);
      expect(observer.result.current?.map((item) => item.id)).toEqual(['workstream-1', 'workstream-2']);
    });

    // A later payload must not drag the cursor back to the end of page one
    // under a reader who has already scrolled past it.
    it('leaves a scrolled cursor alone when a later connect payload lands', async () => {
      pagedList();
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender, {
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
      });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.data).toHaveLength(2));
      expect(result.current.hasMore).toBe(false);

      landConnectPayload(rerender, {
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
      });

      // Still at the end of the list, not back at the end of page one.
      expect(result.current.hasMore).toBe(false);
    });

    it('keeps the cursor when a page fails, so the next scroll retries it', async () => {
      pagedList();
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender, {
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
      });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      listWorkstreams.mockRejectedValueOnce(new Error('offline'));

      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.isFetchingMore).toBe(false));

      // Still offered, and still the same cursor: a failed page is not an empty
      // one, and ending the list quietly would hide the rest of it for good.
      expect(result.current.hasMore).toBe(true);
      expect(result.current.data).toHaveLength(1);

      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.data).toHaveLength(2));
      expect(listWorkstreams.mock.calls.at(-1)?.[0]).toMatchObject({ before: 'cursor-1' });
    });

    it('starts again from the first page when debugging changes the list', async () => {
      pagedList();
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender, {
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
      });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.data).toHaveLength(2));
      listWorkstreams.mockClear();

      announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

      // The rows are a different population now, so the pages walked before
      // describe a list that no longer exists: one request, from the start.
      await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(1));
      expect(listWorkstreams.mock.calls[0]?.[0]).toMatchObject({ includeSystem: true });
      expect(listWorkstreams.mock.calls[0]?.[0]).not.toHaveProperty('before');
    });
  });
});
