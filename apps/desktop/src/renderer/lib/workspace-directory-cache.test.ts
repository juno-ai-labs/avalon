import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllLocalCache, closeLocalCache, defineLocalCacheSlice, localCacheScope } from './local-cache';
import type { AutomationSummary, WorkstreamSummary } from './types';
import {
  DIRECTORY_CACHE_KEY,
  hydrateWorkspaceDirectory,
  mirrorWorkspaceDirectory,
  workspaceDirectorySlice,
  type CachedWorkspaceDirectory,
} from './workspace-directory-cache';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

const scope = localCacheScope('global', '00000000-0000-7000-8000-000000000001');

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
    notes: [],
    projects: { waterline: 3, items: [] },
    inactiveProjects: { waterline: 3, items: [] },
    ...overrides,
  };
}

describe('workspace directory cache', () => {
  beforeEach(() => clearAllLocalCache());
  afterEach(() => closeLocalCache());

  it('seeds every list the sidebar and the project space read, when none is there yet', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory());
    const queryClient = new QueryClient();

    await expect(hydrateWorkspaceDirectory(queryClient, scope, () => true)).resolves.toBe(true);

    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual([summary()]);
    expect(queryClient.getQueryData(['automations'])).toEqual([automation]);
    expect(queryClient.getQueryData(['notes'])).toEqual([]);
    expect(queryClient.getQueryData(['projects'])).toEqual({ waterline: 3, items: [] });
    expect(queryClient.getQueryData(['projects-inactive'])).toEqual({ waterline: 3, items: [] });
  });

  it('does not write over a directory the socket already delivered', async () => {
    await workspaceDirectorySlice.write(scope, DIRECTORY_CACHE_KEY, directory());
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ title: 'Live row' })]);

    await expect(hydrateWorkspaceDirectory(queryClient, scope, () => true)).resolves.toBe(false);

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title).toBe('Live row');
    expect(queryClient.getQueryData(['automations'])).toBeUndefined();
  });

  it('refuses a stored directory with a row this build cannot read', async () => {
    const raw = defineLocalCacheSlice<unknown>({ kind: 'directory', version: 1, parse: (value) => value });
    // A row with no title, written the way an older build might have written it.
    await raw.write(scope, DIRECTORY_CACHE_KEY, { ...directory(), workstreams: [{ id: 'no-title' }] });

    expect(await workspaceDirectorySlice.read(scope, DIRECTORY_CACHE_KEY)).toBeNull();
    await expect(hydrateWorkspaceDirectory(new QueryClient(), scope, () => true)).resolves.toBe(false);
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
    expect(row?.projects).toBeNull();
    mirror.stop();
  });
});
