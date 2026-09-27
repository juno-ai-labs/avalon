import { WorkstreamPrivateChildSchema } from '@rally/contracts';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    ...overrides,
  };
}

describe('organization directory cache', () => {
  beforeEach(() => clearAllLocalCache());
  afterEach(() => closeLocalCache());

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
