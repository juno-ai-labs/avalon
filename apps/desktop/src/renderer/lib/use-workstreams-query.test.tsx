import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLayoutEffect, type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { WorkstreamSummary } from './types';
import { WORKSTREAMS_QUERY_KEY, useCachedWorkstreams, useWorkstreamsQuery } from './use-workstreams-query';
import { holdCachedWorkstreamArchive, setCachedWorkstreams } from './workstreams-cache';
import { WORKSTREAM_STATE_WATERLINES_KEY } from './workstream-state-store';

const listWorkstreams = vi.hoisted(() => vi.fn());
const walkSpaceChannels = vi.hoisted(() => vi.fn());
const socket = vi.hoisted(() => ({
  sidebarConnect: null as { generation: number; nextCursor: string | null } | null,
}));
const getApplicationSettings = vi.hoisted(() => vi.fn());
const settingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());

vi.mock('./workspace-socket', () => ({
  useWorkspaceSocket: () => ({ listWorkstreams, walkSpaceChannels, sidebarConnect: socket.sidebarConnect }),
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
    spaceIds: [],
  } satisfies WorkstreamSummary;
}

describe('useWorkstreamsQuery', () => {
  let queryClient: QueryClient;

  function wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it('exposes archive tombstones to list overlays while ordinary directory readers omit them', async () => {
    const open = summary('open', 'Open');
    const archived = { ...summary('archived', 'Archived'), archivedAt: '2026-10-21T12:00:00.000Z' };
    setCachedWorkstreams(queryClient, [open, archived]);
    const { result } = renderHook(() => ({
      directory: useWorkstreamsQuery().data,
      overlay: useWorkstreamsQuery({ includeArchived: true }).data,
    }), { wrapper });
    expect(result.current.directory?.map((row) => row.id)).toEqual(['open']);
    expect(result.current.overlay?.map((row) => row.id)).toEqual(['open', 'archived']);
    act(() => holdCachedWorkstreamArchive(queryClient, { ...open, archivedAt: '2026-10-21T13:00:00.000Z' }));
    await waitFor(() => expect(result.current.directory).toEqual([]));
    expect(result.current.overlay?.every((row) => Boolean(row.archivedAt))).toBe(true);
  });

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
    // A connection whose sidebar carried Channel rows: nothing to walk.
    walkSpaceChannels.mockReset();
    walkSpaceChannels.mockResolvedValue(null);
    getApplicationSettings.mockReset();
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: false,
      developerSettingsAvailable: true,
    });
  });

  // The refetch writes its answer itself rather than through
  // `setCachedWorkstreams`, and prefers the resident copy of a row it fetched,
  // so both halves of the pending rule have to hold here on their own.
  it('keeps a Channel whose create is in flight across a refetch, and takes the fetched fields for it once listed while it stays pending', async () => {
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    landConnectPayload(rerender);
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    act(() => setCachedWorkstreams(queryClient, (rows) => [
      { ...summary('workstream-new', ''), pending: true },
      ...rows ?? [],
    ]));

    await act(async () => { await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }); });
    await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.data?.map((row) => [row.id, row.pending]))
      .toEqual([['workstream-new', true], ['workstream-1', undefined]]));

    listWorkstreams.mockResolvedValue({
      items: [summary('workstream-new', 'Named'), summary('workstream-1', 'Launch brief')],
      nextCursor: null,
    });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }); });
    await waitFor(() => expect(result.current.data?.find((row) => row.id === 'workstream-new'))
      .toEqual(expect.objectContaining({ title: 'Named' })));
    // Listed is not created: the room may still be written. Its create ends it.
    expect(result.current.data?.find((row) => row.id === 'workstream-new')?.pending).toBe(true);
  });

  it('stores the list under the unparameterized key producers write to', async () => {
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    landConnectPayload(rerender);
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(WORKSTREAMS_QUERY_KEY).toEqual(['workstreams']);
    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual(result.current.data);
  });

  it('exposes and follows the opening cursor before passive effects run', async () => {
    setCachedWorkstreams(queryClient, [summary('workstream-1', 'Launch brief')]);
    socket.sidebarConnect = { generation: 1, nextCursor: 'older-page' };
    const seen: boolean[] = [];
    renderHook(() => {
      const query = useWorkstreamsQuery();
      useLayoutEffect(() => {
        seen.push(query.hasMore);
        if (query.hasMore) query.fetchMore();
      }, [query.hasMore]);
      return query;
    }, { wrapper });
    expect(seen[0]).toBe(true);
    await waitFor(() => expect(listWorkstreams).toHaveBeenCalledWith(expect.objectContaining({ before: 'older-page' })));
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

  it('hides a confirmed archive while retaining its ordering marker in the raw cache', async () => {
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    const active = summary('workstream-1', 'Launch brief');
    landConnectPayload(rerender, { items: [active] });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    act(() => holdCachedWorkstreamArchive(queryClient, {
      ...active,
      archivedAt: '2026-09-21T12:00:00.000Z',
      updatedAt: '2026-09-21T12:00:00.000Z',
    }));

    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.archivedAt)
      .toBe('2026-09-21T12:00:00.000Z');
  });

  // Debugging is the one thing the connect payload deliberately does not serve:
  // the server has no idea the preference is on, so a viewer who wants system
  // rows asks for the wider directory themselves. Rare, and engineers only.
  it('asks for the wider directory itself when debugging turns on', async () => {
    const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    landConnectPayload(rerender);
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(listWorkstreams).not.toHaveBeenCalled();

    announce({ releaseChannel: 'stable', releaseChannelAvailable: true, lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

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

    it('does not republish an archived first-page row after a later page finishes', async () => {
      pagedList();
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender, {
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
      });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.data).toHaveLength(2));

      let releaseSecondPage: ((page: {
        items: WorkstreamSummary[];
        nextCursor: null;
      }) => void) | undefined;
      listWorkstreams.mockReset();
      listWorkstreams.mockImplementation((input: { before?: string }) => input.before
        ? new Promise((resolve) => {
          releaseSecondPage = resolve;
        })
        : Promise.resolve({
          items: [summary('workstream-1', 'Stale first page')],
          nextCursor: 'cursor-1',
        }));

      act(() => {
        void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      });
      await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(2));
      act(() => {
        queryClient.setQueryData(WORKSTREAM_STATE_WATERLINES_KEY, {
          'workstream-1': { visible: false },
        });
        setCachedWorkstreams(queryClient, (current) =>
          current?.filter((workstream) => workstream.id !== 'workstream-1'));
      });
      act(() => releaseSecondPage?.({
        items: [summary('workstream-2', 'Second page')],
        nextCursor: null,
      }));

      await waitFor(() => expect(result.current.isFetching).toBe(false));
      expect(result.current.data?.map((workstream) => workstream.id)).toEqual(['workstream-2']);
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

      announce({ releaseChannel: 'stable', releaseChannelAvailable: true, lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

      // The rows are a different population now, so the pages walked before
      // describe a list that no longer exists: one request, from the start.
      await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(1));
      expect(listWorkstreams.mock.calls[0]?.[0]).toMatchObject({ includeSystem: true });
      expect(listWorkstreams.mock.calls[0]?.[0]).not.toHaveProperty('before');
    });
  });

  describe('loading a Space at a time', () => {
    // The walk itself writes each page as it lands (the provider's job); what
    // the query adds is dropping what no Space returned.
    it('drops a row no Space returned, and keeps pending rows and rows that arrived during the walk', async () => {
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender, { items: [summary('kept', 'Kept'), summary('gone', 'Gone')] });
      await waitFor(() => expect(result.current.data).toHaveLength(2));
      act(() => setCachedWorkstreams(queryClient, (rows) => [
        { ...summary('creating', ''), pending: true },
        ...rows ?? [],
      ]));
      walkSpaceChannels.mockImplementation(async () => {
        setCachedWorkstreams(queryClient, (rows) => [...rows ?? [], summary('pushed', 'Pushed mid-walk')]);
        return new Set(['kept']);
      });

      await act(async () => { await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }); });

      await waitFor(() => expect(result.current.data?.map((row) => row.id).sort())
        .toEqual(['creating', 'kept', 'pushed']));
      expect(listWorkstreams).not.toHaveBeenCalled();
      expect(result.current.hasMore).toBe(false);
    });

    it('adds the directory\'s system rows while debugging, since they sit in no Space', async () => {
      getApplicationSettings.mockResolvedValue({
        lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true,
      });
      walkSpaceChannels.mockResolvedValue(new Set(['workstream-1']));
      // The system row sits past a page of newer ordinary Channels.
      listWorkstreams.mockImplementation(async (input: { before?: string }) => input.before === 'page-2'
        ? { items: [{ ...summary('digest', 'Digest'), systemKind: 'digest' }], nextCursor: null }
        : { items: [summary('workstream-1', 'Launch brief')], nextCursor: 'page-2' });
      const { result, rerender } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      landConnectPayload(rerender);
      await waitFor(() => expect(result.current.data?.map((row) => row.id)).toEqual(['workstream-1', 'digest']));
      expect(listWorkstreams.mock.calls.at(-1)?.[0]).toMatchObject({ includeSystem: true, before: 'page-2' });
    });
  });
});
