import { MyThreadsPageSchema, PinListSchema, ArtifactPinListSchema, ChannelRailSchema, WorkstreamPrivateChildSchema } from '@rally/contracts';
import { applyChannelRails, channelRailQueryKey, isRailStale, noteRailWaterline } from './channel-rails';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RallyApi } from './api';
import { LOCAL_CACHE_WRITE_COALESCE_MS } from './local-cache-mirror';
import { clearAllLocalCache, closeLocalCache, defineLocalCacheSlice, localCacheScope } from './local-cache';
import type { AutomationSummary, WorkstreamSummary } from './types';
import { applyChannelViewerState, workstreamChildrenQueryKey, type WorkstreamChildDirectory } from './channel-viewer-state';
import {
  DIRECTORY_CACHE_KEY,
  hydrateWorkspaceDirectory,
  mirrorWorkspaceDirectory,
  workspaceDirectorySlice,
  type CachedWorkspaceDirectory,
} from './workspace-directory-cache';
import { setCachedWorkstreams, WORKSTREAM_PAGE_SIZE, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

const scope = localCacheScope('00000000-0000-7000-8000-0000000000aa', 'global', '00000000-0000-7000-8000-000000000001');

function summary(overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id: '00000000-0000-7000-8000-000000000002',
    title: 'Remembered row',
    titleStatus: 'settled',
    harnessStatus: 'completed',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: '2026-08-17T19:00:00.000Z',
    scope: 'workspace',
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    spaceIds: [],
    ...overrides,
  };
}

const automation: AutomationSummary = {
  id: '00000000-0000-7000-8000-000000000005',
  name: 'Monday brief',
  description: 'Every Monday',
  scope: 'workspace',
  status: 'active',
  updatedAt: '2026-08-17T19:00:00.000Z',
};

function directory(overrides: Partial<CachedWorkspaceDirectory> = {}): CachedWorkspaceDirectory {
  return {
    workstreams: [summary()],
    automations: [automation],
    spaces: { waterline: 3, items: [] },
    inactiveSpaces: { waterline: 3, items: [] },
    ordering: [],
    breakouts: {},
    rails: {},
    ...overrides,
  };
}

async function mappedThreads() {
  const thread = {
    ...summary(), kind: 'channel', workspaceId: '00000000-0000-7000-8000-000000000001',
    objective: 'Keep this preview', createdByUserId: null, createdAt: '2026-10-19T19:00:00.000Z',
    updatedAt: '2026-10-19T19:00:00.000Z', archivedAt: null,
  };
  const wire = MyThreadsPageSchema.parse({ items: [thread], pinned: [thread], nextCursor: 'page-2' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(wire)));
  const api = new RallyApi('https://api.rally.test', {
    accessToken: 'test-token', expiresAt: '2027-01-01T00:00:00.000Z', apiBaseUrl: 'https://api.rally.test',
    user: { id: '00000000-0000-7000-8000-0000000000aa', name: 'Me', email: 'me@rally.test' },
    workspace: { id: thread.workspaceId, name: 'Rally', region: 'global', role: 'owner' },
  });
  return api.getMyThreads(null);
}

describe('organization directory cache', () => {
  beforeEach(() => clearAllLocalCache());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); closeLocalCache(); });

  it('seeds every list the sidebar and the space dashboard read, when none is there yet', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory());
    const queryClient = new QueryClient();

    await expect(hydrateWorkspaceDirectory(queryClient, scope, () => true)).resolves.toBe(true);

    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual([summary()]);
    expect(queryClient.getQueryData(['automations'])).toEqual([automation]);
    expect(queryClient.getQueryData(['notes'])).toBeUndefined();
    expect(queryClient.getQueryData(['spaces'])).toEqual({ waterline: 3, items: [] });
    expect(queryClient.getQueryData(['spaces-inactive'])).toEqual({ waterline: 3, items: [] });
  });

  it('restores pins with API-mapped thread rows and keeps only the first thread page', async () => {
    const before = new QueryClient();
    const mirror = mirrorWorkspaceDirectory(before, scope, { live: () => true });
    setCachedWorkstreams(before, [summary()]);
    await mirror.flush();
    const pins = PinListSchema.parse([{ kind: 'thread', id: summary().id, parentId: null }]);
    const artifacts = ArtifactPinListSchema.parse([{
      id: '00000000-0000-7000-8000-000000000003', threadId: summary().id,
      title: 'Launch plan', resourceType: 'generated_file', mimeType: 'text/markdown',
      updatedAt: '2026-10-19T19:00:00.000Z', currentVersion: 1, unread: false,
      thread: { title: 'Remembered row', appearance: null, spaceIds: [] },
    }]);
    const threads = await mappedThreads();
    before.setQueryData(['pins'], pins);
    before.setQueryData(['artifact-pins'], artifacts);
    before.setQueryData(['channel-stats'], []);
    before.setQueryData(['my-threads'], {
      pages: [threads, { items: [], pinned: [], nextCursor: null }], pageParams: [null, 'page-2'],
    });
    await mirror.flush();
    mirror.stop();

    const after = new QueryClient();
    await expect(hydrateWorkspaceDirectory(after, scope, () => true)).resolves.toBe(true);
    expect(after.getQueryData(['pins'])).toEqual([{ kind: 'thread', id: summary().id, parentId: null }]);
    expect(after.getQueryData<Array<{ title: string }>>(['artifact-pins'])?.map((pin) => pin.title)).toEqual(['Launch plan']);
    expect(after.getQueryData(['channel-stats'])).toEqual([]);
    const restored = after.getQueryData<{ pages: Array<{ items: Array<{ title: string }>; pinned: Array<{ title: string }>; nextCursor: string }>; pageParams: unknown[] }>(['my-threads']);
    expect(restored?.pages).toHaveLength(1);
    expect(restored?.pages[0]?.pinned.map((row) => row.title)).toEqual(['Remembered row']);
    expect(restored?.pages[0]?.items.map((row) => row.title)).toEqual(['Remembered row']);
    expect(restored?.pages[0]?.nextCursor).toBe('page-2');
    expect(restored?.pageParams).toEqual([null]);
    expect(after.getQueryData<{ pages: Array<{ items: Array<{ preview: string }> }> }>(['my-threads'])?.pages[0]?.items[0]?.preview).toBe('Keep this preview');
  });

  it('keeps live navigation answers that beat disk hydration', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory({ navigation: {
      pins: PinListSchema.parse([{ kind: 'thread', id: summary().id, parentId: null }]),
      threads: await mappedThreads(),
    } }));

    // A REST answer can beat disk hydration even before the socket arrives.
    const raced = new QueryClient();
    raced.setQueryData(['pins'], []);
    raced.setQueryData(['artifact-pins'], []);
    raced.setQueryData(['my-threads'], { pages: [{ items: [], pinned: [], nextCursor: null }], pageParams: [null] });
    await hydrateWorkspaceDirectory(raced, scope, () => true);
    expect(raced.getQueryData(['pins'])).toEqual([]);
    expect(raced.getQueryData(['artifact-pins'])).toEqual([]);
    expect(raced.getQueryData(['my-threads'])).toEqual({ pages: [{ items: [], pinned: [], nextCursor: null }], pageParams: [null] });
  });

  it('marks seeded Channel stats stale for Infinity readers without invalidating a live answer', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory({ navigation: { channelStats: [] } }));
    const client = new QueryClient();
    await hydrateWorkspaceDirectory(client, scope, () => true);
    const observer = new QueryObserver(client, { queryKey: ['channel-stats'], staleTime: Infinity });
    expect(observer.getCurrentResult().data).toEqual([]);
    expect(observer.getCurrentResult().isStale).toBe(true);
    observer.destroy();

    const live = new QueryClient();
    live.setQueryData(['channel-stats'], []);
    await hydrateWorkspaceDirectory(live, scope, () => true);
    const liveObserver = new QueryObserver(live, { queryKey: ['channel-stats'], staleTime: Infinity });
    expect(liveObserver.getCurrentResult().isStale).toBe(false);
    liveObserver.destroy();
  });

  it('seeds missing REST thread rows even when the socket directory arrived first', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory({ navigation: { threads: await mappedThreads() } }));
    const client = new QueryClient();
    setCachedWorkstreams(client, [summary({ title: 'Live row' })]);
    client.setQueryData(['pins'], []);
    await expect(hydrateWorkspaceDirectory(client, scope, () => true)).resolves.toBe(false);
    expect(client.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title).toBe('Live row');
    expect(client.getQueryData(['pins'])).toEqual([]);
    expect(client.getQueryData<{ pages: Array<{ pinned: Array<{ title: string }> }> }>(['my-threads'])?.pages[0]?.pinned[0]?.title).toBe('Remembered row');
  });

  it('keeps valid navigation lists when cached thread rows cannot be read', async () => {
    const raw = defineLocalCacheSlice<unknown>({ kind: 'directory', version: 4, parse: (value) => value });
    await raw.write(scope, DIRECTORY_CACHE_KEY, { ...directory(), navigation: {
      pins: [{ kind: 'thread', id: summary().id, parentId: null }],
      artifactPins: [], channelStats: [], threads: { items: [{ title: 'Broken' }], pinned: [], nextCursor: null },
    } });
    const client = new QueryClient();
    await hydrateWorkspaceDirectory(client, scope, () => true);
    expect(client.getQueryData(['pins'])).toEqual([{ kind: 'thread', id: summary().id, parentId: null }]);
    expect(client.getQueryData(['artifact-pins'])).toEqual([]);
    expect(client.getQueryData(['channel-stats'])).toEqual([]);
    expect(client.getQueryData(['my-threads'])).toBeUndefined();
  });

  it.each([
    ['pins', 'pins'], ['artifact-pins', 'artifactPins'], ['channel-stats', 'channelStats'], ['my-threads', 'threads'],
  ] as const)('persists a %s-only change through the scheduled mirror', async (key, field) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = new QueryClient();
    const mirror = mirrorWorkspaceDirectory(client, scope, { live: () => true });
    setCachedWorkstreams(client, [summary()]);
    await mirror.flush();
    const value = field === 'threads' ? await mappedThreads() : [];
    client.setQueryData([key], field === 'threads' ? { pages: [value], pageParams: [null] } : value);
    await vi.advanceTimersByTimeAsync(LOCAL_CACHE_WRITE_COALESCE_MS);
    // Neither flush nor stop may cause this write: only the query event can.
    await vi.waitFor(async () => {
      const saved = await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY);
      if (field === 'threads') expect(saved?.navigation?.threads?.items[0]?.title).toBe('Remembered row');
      else expect(saved?.navigation?.[field]).toEqual([]);
    });
    mirror.stop();
  });

  it('does not write over a directory the socket already delivered', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory());
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ title: 'Live row' })]);

    await expect(hydrateWorkspaceDirectory(queryClient, scope, () => true)).resolves.toBe(false);

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title).toBe('Live row');
    expect(queryClient.getQueryData(['automations'])).toBeUndefined();
  });

  it('refuses a row a wipe overtook while it was being read', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory());
    const queryClient = new QueryClient();
    let wipe: Promise<void> | null = null;
    const stillWanted = (): boolean => {
      wipe = clearAllLocalCache();
      return true;
    };

    await expect(hydrateWorkspaceDirectory(queryClient, scope, stillWanted)).resolves.toBe(false);
    await wipe;

    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(['spaces'])).toBeUndefined();
  });

  it('refuses a stored directory with a row this build cannot read', async () => {
    const raw = defineLocalCacheSlice<unknown>({ kind: 'directory', version: 1, parse: (value) => value });
    // A row with no title, written the way an older build might have written it.
    await raw.write(scope, DIRECTORY_CACHE_KEY, { ...directory(), workstreams: [{ id: 'no-title' }] });

    expect(await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY)).toBeNull();
    await expect(hydrateWorkspaceDirectory(new QueryClient(), scope, () => true)).resolves.toBe(false);
  });

  /**
   * The claim that kept the arrangement off the version.
   *
   * The arrangement was added to the directory row without bumping, on the
   * argument that a row written without the key still reads: absorbing the
   * absence costs one launch drawn in the natural order, and bumping would
   * cost every person a cold, empty sidebar to avoid it. The slice has since
   * gone to 4 for a field `parse` genuinely *cannot* absorb — a Space's reach
   * — which does not retire this: the rule is per key, and the next person to
   * add one has to say which of the two it is.
   *
   * Written at the slice's own version, so it is `parseCachedDirectory` being
   * asked rather than the version gate in front of it. An older version never
   * reaches `parse` at all, so a test that used one would pass on the gate and
   * prove nothing about the shape.
   */
  it('hydrates a directory row written before the ordering existed', async () => {
    const raw = defineLocalCacheSlice<unknown>({ kind: 'directory', version: 4, parse: (value) => value });
    const { workstreams, automations, spaces, inactiveSpaces } = directory();
    await raw.write(scope, DIRECTORY_CACHE_KEY, { workstreams, automations, spaces, inactiveSpaces });
    const queryClient = new QueryClient();

    await expect(hydrateWorkspaceDirectory(queryClient, scope, () => true)).resolves.toBe(true);

    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual([summary()]);
    // Read as "this person has arranged nothing", which is what every list then
    // draws in its natural order until the socket says otherwise.
    expect(queryClient.getQueryData(['personal-order'])).toEqual([]);
    // Nor any breakout list: that Channel's rail waits for the socket.
    expect(queryClient.getQueryData(workstreamChildrenQueryKey(summary().id))).toBeUndefined();
  });

  it('paints each remembered Channel\'s breakouts on the next launch until the socket says them', async () => {
    const channel = summary().id;
    const breakout = (substreamId: string, title: string) => WorkstreamPrivateChildSchema.parse({
      substreamId, title,
      createdByUserId: '00000000-0000-7000-8000-0000000000aa',
      createdAt: '2026-08-17T19:00:00.000Z',
      updatedAt: '2026-08-17T19:00:00.000Z',
    });
    const version = (waterline: number) => ({
      commonEventId: '00000000-0000-7000-8000-00000000c001',
      viewerEventId: '00000000-0000-7000-8000-00000000c002',
      authorityGeneration: 1,
      commonWaterline: waterline,
      viewerWaterline: waterline,
    });
    const before = new QueryClient();
    const mirror = mirrorWorkspaceDirectory(before, scope, { live: () => true });
    setCachedWorkstreams(before, [summary()]);
    // A breakout list moving on its own is a change to the row too.
    applyChannelViewerState(before, { id: channel, privateChildren: [breakout('00000000-0000-7000-8000-000000000011', 'Pricing')], privateChildrenWaterline: 9 }, version(9), null);
    await mirror.flush();
    mirror.stop();

    const after = new QueryClient();
    await expect(hydrateWorkspaceDirectory(after, scope, () => true)).resolves.toBe(true);
    expect(after.getQueryData<WorkstreamChildDirectory>(workstreamChildrenQueryKey(channel))?.privateChildren)
      .toEqual([breakout('00000000-0000-7000-8000-000000000011', 'Pricing')]);

    // The live row replaces the seed even though it is numbered below the row
    // the device remembered: a seed holds no version against the socket.
    applyChannelViewerState(after, { id: channel, privateChildren: [breakout('00000000-0000-7000-8000-000000000012', 'Launch')], privateChildrenWaterline: 1 }, version(1), null);
    expect(after.getQueryData<WorkstreamChildDirectory>(workstreamChildrenQueryKey(channel))?.privateChildren)
      .toEqual([breakout('00000000-0000-7000-8000-000000000012', 'Launch')]);
  });

  it('paints each remembered Channel\'s rail on the next launch, current at the waterline it was answered at', async () => {
    const channel = summary().id;
    const rail = ChannelRailSchema.parse({
      workstreamId: channel, railWaterline: 6, participantUserIds: ['00000000-0000-7000-8000-0000000000aa'],
      sidekicks: { owned: [], recommended: [], attached: [] },
      resources: [{ id: '00000000-0000-7000-8000-0000000000c1', title: 'Plan', resourceType: 'document', mimeType: null, direction: 'source', currentVersion: 2 }],
    });
    const before = new QueryClient();
    const mirror = mirrorWorkspaceDirectory(before, scope, { live: () => true });
    setCachedWorkstreams(before, [summary()]);
    applyChannelRails(before, { rails: [rail], oversized: [], unavailable: [] });
    await mirror.flush();
    mirror.stop();

    const after = new QueryClient();
    await expect(hydrateWorkspaceDirectory(after, scope, () => true)).resolves.toBe(true);
    expect(after.getQueryData(channelRailQueryKey(channel))).toEqual({ railWaterline: 6, rail });
    noteRailWaterline(after, channel, 6);
    expect(isRailStale(after, channel)).toBe(false);
  });

  it('keeps one page of the flat list, however many pages the sidebar has loaded', async () => {
    const queryClient = new QueryClient();
    const mirror = mirrorWorkspaceDirectory(queryClient, scope, { live: () => true });
    const loaded = Array.from({ length: WORKSTREAM_PAGE_SIZE + 1 }, (_, index) => summary({
      id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      title: `Row ${index}`,
    }));

    setCachedWorkstreams(queryClient, loaded);
    await mirror.flush();

    const row = await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY);
    expect(row?.workstreams).toHaveLength(WORKSTREAM_PAGE_SIZE);
    expect(row?.workstreams[0]?.title).toBe('Row 0');
    mirror.stop();
  });

  it('mirrors the lists only once the caller says they are the socket\'s', async () => {
    const queryClient = new QueryClient();
    let live = false;
    const mirror = mirrorWorkspaceDirectory(queryClient, scope, { live: () => live });

    setCachedWorkstreams(queryClient, [summary({ title: 'Seed' })]);
    await mirror.flush();
    expect(await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY)).toBeNull();

    live = true;
    setCachedWorkstreams(queryClient, [summary({ title: 'From the socket' })]);
    queryClient.setQueryData(['automations'], [automation]);
    await mirror.flush();
    const row = await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY);
    expect(row?.workstreams[0]?.title).toBe('From the socket');
    expect(row?.automations).toEqual([automation]);
    expect(row?.spaces).toBeNull();
    mirror.stop();
  });
});
