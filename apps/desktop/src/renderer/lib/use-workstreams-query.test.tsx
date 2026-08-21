import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { WorkstreamSummary } from './types';
import { WORKSTREAMS_QUERY_KEY, useWorkstreamsQuery } from './use-workstreams-query';
import { setCachedWorkstreams } from './workstreams-cache';

const listWorkstreams = vi.hoisted(() => vi.fn());
const listSidebar = vi.hoisted(() => vi.fn());
const getApplicationSettings = vi.hoisted(() => vi.fn());
const settingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());

vi.mock('./workspace-socket', () => ({ useWorkspaceSocket: () => ({ listSidebar, listWorkstreams }) }));
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
    origin: 'ad_hoc',
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
  } satisfies WorkstreamSummary;
}

describe('useWorkstreamsQuery', () => {
  let queryClient: QueryClient;

  function wrapper({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    settingsListeners.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    listWorkstreams.mockReset();
    listWorkstreams.mockResolvedValue({
      items: [summary('workstream-1', 'Launch brief')],
      nextCursor: null,
    });
    listSidebar.mockReset();
    listSidebar.mockResolvedValue({
      items: [summary('workstream-1', 'Launch brief')],
      nextCursor: null,
      automations: [],
      notes: [],
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
    const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(WORKSTREAMS_QUERY_KEY).toEqual(['workstreams']);
    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual(result.current.data);
  });

  // The sidebar's three lists are one answer, and the two the shell reads by
  // key are only useful if the batch writes them under the keys it reads. A
  // literal typed differently in either place fails here rather than as an
  // empty sidebar section nobody can explain.
  it('seeds the automations and notes the shell reads, from the one batch', async () => {
    listSidebar.mockResolvedValue({
      items: [summary('workstream-1', 'Launch brief')],
      nextCursor: null,
      automations: [{ id: 'automation-1', name: 'Monday brief', scope: 'workspace', status: 'active', updatedAt: '2026-08-21T09:00:00.000Z' }],
      notes: [{ id: 'note-1', title: 'Standup', lastActivityAt: '2026-08-21T10:00:00.000Z' }],
    });
    const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(queryClient.getQueryData(['automations']))
      .toEqual([expect.objectContaining({ id: 'automation-1', name: 'Monday brief' })]);
    expect(queryClient.getQueryData(['notes']))
      .toEqual([expect.objectContaining({ id: 'note-1', title: 'Standup' })]);
    // One request for all three. The REST fetchers are the refresh path, not
    // part of opening the sidebar.
    expect(listSidebar).toHaveBeenCalledTimes(1);
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  // Nothing else loads the automations and notes, so a retry that asked for the
  // directory alone would open a sidebar permanently missing two of its lists.
  it('retries a failed batch as a batch', async () => {
    listSidebar.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(queryClient.getQueryData(['automations'])).toBeUndefined();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
    });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(listSidebar).toHaveBeenCalledTimes(2);
    expect(listWorkstreams).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['notes'])).toEqual([]);
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
      setCachedWorkstreams(queryClient, (current) =>
        current?.map((item) => ({ ...item, title: 'Renamed in place' })),
      );
    });

    await waitFor(() => expect(result.current.data?.[0]?.title).toBe('Renamed in place'));
  });

  it('asks for system work streams only while debugging is on, without a duplicate first fetch', async () => {
    const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(listSidebar).toHaveBeenCalledTimes(1);
    expect(listSidebar.mock.calls[0]?.[0]).toMatchObject({ includeSystem: false });
    expect(listWorkstreams).not.toHaveBeenCalled();

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    // The reload is another batch, not a bare directory page: the two lists
    // riding along have no other loader, so every reload has to carry them.
    await waitFor(() => expect(listSidebar).toHaveBeenCalledTimes(2));
    expect(listSidebar.mock.calls[1]?.[0]).toMatchObject({ includeSystem: true });
    expect(listWorkstreams).not.toHaveBeenCalled();
  });

  describe('paging', () => {
    function pagedList(): void {
      listWorkstreams.mockReset();
      listWorkstreams.mockImplementation(async (
        input: { before?: string },
      ) => input.before === 'cursor-1'
        ? { items: [summary('workstream-2', 'Second page')], nextCursor: null }
        : { items: [summary('workstream-1', 'First page')], nextCursor: 'cursor-1' });
      // The batch answers the cold first page, so it has to offer the same
      // cursor the paged list continues from.
      listSidebar.mockReset();
      listSidebar.mockResolvedValue({
        items: [summary('workstream-1', 'First page')],
        nextCursor: 'cursor-1',
        automations: [],
        notes: [],
      });
    }

    it('reports a further page and appends it without refetching the first', async () => {
      pagedList();
      const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
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
      const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      await waitFor(() => expect(result.current.data).toHaveLength(1));

      expect(result.current.hasMore).toBe(false);
      act(() => result.current.fetchMore());

      expect(listWorkstreams).not.toHaveBeenCalled();
    });

    // The regression a hand-rolled pager invites: the list polls every fifteen
    // seconds, and a refetch that walked only the first page would truncate the
    // list under somebody who had scrolled.
    it('reloads every page already on screen when the list refetches', async () => {
      pagedList();
      const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.data).toHaveLength(2));

      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      });

      // The refetch walks both pages again: page one as a batch, page two as a
      // directory page. So two paged requests in total, and two batches.
      await waitFor(() => expect(listWorkstreams).toHaveBeenCalledTimes(2));
      expect(listSidebar).toHaveBeenCalledTimes(2);
      expect(listSidebar.mock.calls[1]?.[0]).not.toHaveProperty('before');
      expect(listWorkstreams.mock.calls[1]?.[0]).toMatchObject({ before: 'cursor-1' });
      expect(result.current.data?.map((item) => item.id))
        .toEqual(['workstream-1', 'workstream-2']);
    });

    it('keeps the cursor when a page fails, so the next scroll retries it', async () => {
      pagedList();
      const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
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
      const { result } = renderHook(() => useWorkstreamsQuery(), { wrapper });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      act(() => result.current.fetchMore());
      await waitFor(() => expect(result.current.data).toHaveLength(2));
      listWorkstreams.mockClear();
      listSidebar.mockClear();

      announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

      // The rows are a different population now, so the pages walked before
      // describe a list that no longer exists: one request, from the start.
      await waitFor(() => expect(listSidebar).toHaveBeenCalledTimes(1));
      expect(listSidebar.mock.calls[0]?.[0]).toMatchObject({ includeSystem: true });
      expect(listSidebar.mock.calls[0]?.[0]).not.toHaveProperty('before');
      expect(listWorkstreams).not.toHaveBeenCalled();
    });
  });
});
