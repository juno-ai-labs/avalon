import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { conversationCacheKey, conversationSlice } from './conversation-cache';
import { clearAllLocalCache, localCacheScope } from './local-cache';
import {
  evictCachedSubstream,
  evictCachedWorkstream,
  invalidateCachedWorkstreamDetails,
  patchCachedWorkstream,
  workstreamDetailQueryKey,
} from './workstreams-cache';
import { applyHarnessStatus } from './use-workstream-socket';
import type { WorkstreamSummary } from './types';

function summary(): WorkstreamSummary {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    title: 'Typed cache boundary',
    titleStatus: 'settled',
    harnessStatus: 'completed',
    scope: 'workspace',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    lastActivityAt: '2026-08-12T12:00:00.000Z',
  };
}

describe('evictCachedWorkstream', () => {
  it('evicts every per-channel cache family after access revocation', () => {
    const queryClient = new QueryClient();
    const workstreamId = summary().id;
    const other = { ...summary(), id: '00000000-0000-7000-8000-000000000002' };
    const prefixes = [
      'workstream',
      'ordered-transcript',
      'transcript-overlays',
      'workstream-feed-source',
      'workstream-socket-snapshot-generation',
      'workstream-context',
      'terminal-workstream',
    ];
    const childPrefixes = [
      'substream-workstream',
      'substream-initial-context',
      'substream-ordered-transcript',
      'substream-transcript-overlays',
      'substream-workstream-feed-source',
      'substream-workstream-socket-snapshot-generation',
    ];
    for (const prefix of prefixes) {
      queryClient.setQueryData([prefix, workstreamId], { sensitive: true });
      queryClient.setQueryData([prefix, other.id], { retained: true });
    }
    for (const prefix of childPrefixes) {
      queryClient.setQueryData([prefix, workstreamId, 'child'], { sensitive: true });
      queryClient.setQueryData([prefix, other.id, 'child'], { retained: true });
    }
    queryClient.setQueryData(['workstream-context', workstreamId, null], { sensitive: true });

    evictCachedWorkstream(queryClient, workstreamId);

    for (const prefix of prefixes) {
      expect(queryClient.getQueryData([prefix, workstreamId])).toBeUndefined();
      expect(queryClient.getQueryData([prefix, other.id])).toEqual({ retained: true });
    }
    for (const prefix of childPrefixes) {
      expect(queryClient.getQueryData([prefix, workstreamId, 'child'])).toBeUndefined();
      expect(queryClient.getQueryData([prefix, other.id, 'child'])).toEqual({ retained: true });
    }
    expect(queryClient.getQueryData(['workstream-context', workstreamId, null])).toBeUndefined();
  });

  it('evicts one child without evicting its parent or sibling', () => {
    const queryClient = new QueryClient();
    const workstreamId = summary().id;
    queryClient.setQueryData(['workstream', workstreamId], { title: 'Parent' });
    queryClient.setQueryData(['substream-workstream', workstreamId, 'child-a'], { title: 'A' });
    queryClient.setQueryData(['substream-workstream', workstreamId, 'child-b'], { title: 'B' });
    queryClient.setQueryData(['substream-initial-context', workstreamId, 'child-a'], { sensitive: true });
    queryClient.setQueryData(['substream-initial-context', workstreamId, 'child-b'], { retained: true });

    evictCachedSubstream(queryClient, workstreamId, 'child-a');

    expect(queryClient.getQueryData(['workstream', workstreamId])).toEqual({ title: 'Parent' });
    expect(queryClient.getQueryData(['substream-workstream', workstreamId, 'child-a']))
      .toBeUndefined();
    expect(queryClient.getQueryData(['substream-workstream', workstreamId, 'child-b']))
      .toEqual({ title: 'B' });
    expect(queryClient.getQueryData(['substream-initial-context', workstreamId, 'child-a']))
      .toBeUndefined();
    expect(queryClient.getQueryData(['substream-initial-context', workstreamId, 'child-b']))
      .toEqual({ retained: true });
  });

  it('invalidates parent and child detail namespaces together', async () => {
    const queryClient = new QueryClient();
    const workstreamId = summary().id;
    queryClient.setQueryData(['workstream', workstreamId], { title: 'Parent' });
    queryClient.setQueryData(['substream-workstream', workstreamId, 'child-a'], { title: 'A' });
    queryClient.setQueryData(
      ['substream-workstream', '00000000-0000-7000-8000-000000000002', 'child-b'],
      { title: 'B' },
    );

    await invalidateCachedWorkstreamDetails(queryClient, workstreamId);

    expect(queryClient.getQueryState(['workstream', workstreamId])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['substream-workstream', workstreamId, 'child-a'])?.isInvalidated)
      .toBe(true);
    expect(queryClient.getQueryState([
      'substream-workstream',
      '00000000-0000-7000-8000-000000000002',
      'child-b',
    ])?.isInvalidated).toBe(false);
  });
});

describe('patchCachedWorkstream', () => {
  it('writes the patch to the main detail entry and leaves another conversation\'s alone', () => {
    const queryClient = new QueryClient();
    const other = { ...summary(), id: '00000000-0000-7000-8000-000000000002' };
    queryClient.setQueryData(['workstream', summary().id], summary());
    queryClient.setQueryData(['workstream', other.id], other);

    patchCachedWorkstream(queryClient, summary().id, { title: 'Renamed', titleStatus: 'settled' });

    expect(queryClient.getQueryData<WorkstreamSummary>(['workstream', summary().id])?.title).toBe('Renamed');
    expect(queryClient.getQueryData(['workstream', other.id])).toBe(other);
  });

  it('patches a private child without changing the parent detail', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['workstream', summary().id], summary());
    queryClient.setQueryData(['substream-workstream', summary().id, 'child'], summary());

    patchCachedWorkstream(queryClient, summary().id, { scope: 'personal' }, 'child');

    expect(queryClient.getQueryData<WorkstreamSummary>(['substream-workstream', summary().id, 'child'])?.scope).toBe('personal');
    // The parent's own entry is not this write's to touch; the versioned
    // control snapshot owns it.
    expect(queryClient.getQueryData<WorkstreamSummary>(['workstream', summary().id])?.scope).toBe('workspace');
  });

  it('leaves an absent detail entry absent for a field patch', () => {
    const queryClient = new QueryClient();

    patchCachedWorkstream(queryClient, summary().id, { title: 'Renamed' });

    // A materialized entry with only a title would render as a work stream
    // with no identity; absence has to stay absence.
    expect(queryClient.getQueryData(['workstream', summary().id])).toBeUndefined();
  });

  it('accepts a per-row updater', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['workstream', summary().id], summary());

    patchCachedWorkstream(queryClient, summary().id, (row) => ({ ...row, title: `${row.title}!` }));

    expect(queryClient.getQueryData<WorkstreamSummary>(['workstream', summary().id])?.title).toBe('Typed cache boundary!');
  });
});

describe('applyHarnessStatus', () => {
  it('drops a pending stop with the status the stop belonged to', () => {
    const queryClient = new QueryClient();
    const key = workstreamDetailQueryKey('parent');
    queryClient.setQueryData(key, {
      id: 'parent', harnessStatus: 'running', stopRequested: true,
    });

    // A new run starting locally, ahead of the canonical snapshot. The flag
    // described the run that just ended; carried over, the composer dock opens
    // the next one by announcing a wait nobody asked for.
    applyHarnessStatus(queryClient, 'parent', 'running', '0');
    expect(queryClient.getQueryData(key)).toMatchObject({ stopRequested: true });

    applyHarnessStatus(queryClient, 'parent', 'completed', '0');
    expect(queryClient.getQueryData(key)).toMatchObject({
      harnessStatus: 'completed', stopRequested: false,
    });
  });
});

describe('workstreamDetailQueryKey', () => {
  it('addresses Main by the parent and a child by both ids', () => {
    expect(workstreamDetailQueryKey('parent')).toEqual(['workstream', 'parent']);
    expect(workstreamDetailQueryKey('parent', '0')).toEqual(['workstream', 'parent']);
    expect(workstreamDetailQueryKey('parent', 'child')).toEqual(['substream-workstream', 'parent', 'child']);
  });
});

describe('eviction reaches the disk', () => {
  const scope = localCacheScope('00000000-0000-7000-8000-0000000000aa', 'global', '00000000-0000-7000-8000-000000000001');
  const otherScope = localCacheScope('00000000-0000-7000-8000-0000000000bb', 'global', '00000000-0000-7000-8000-000000000001');
  const parentId = summary().id;
  const row = () => ({
    detail: {
      ...summary(), createdAt: '2026-08-12T11:00:00.000Z',
      participants: [], viewers: [], resources: [], connections: [], backgroundTasks: [],
    },
    transcript: {
      snapshotId: '00000000-0000-7000-8000-000000000777', snapshotThrough: 0, eventSequence: 0,
      snapshotAtUtc: '2026-08-12T12:00:00.000Z', unreadAnchorSequence: null, unreadReason: 'no_unread' as const,
      ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    },
    initialContext: null,
    cachedAt: '',
  });

  it('forgets every remembered conversation under an evicted channel, in every scope', async () => {
    await clearAllLocalCache();
    for (const substreamId of ['0', 'child-a']) {
      await conversationSlice.write(scope, conversationCacheKey(parentId, substreamId), row(), parentId);
    }
    await conversationSlice.write(otherScope, conversationCacheKey(parentId, '0'), row(), parentId);
    await conversationSlice.write(scope, conversationCacheKey('other-parent', '0'), row(), 'other-parent');

    evictCachedWorkstream(new QueryClient(), parentId);

    await vi.waitFor(async () => {
      expect((await conversationSlice.entries(scope)).map((entry) => entry.key)).toEqual([conversationCacheKey('other-parent', '0')]);
      expect(await conversationSlice.entries(otherScope)).toEqual([]);
    });
  });

  it('forgets one evicted child and keeps its parent and sibling', async () => {
    await clearAllLocalCache();
    for (const substreamId of ['0', 'child-a', 'child-b']) {
      await conversationSlice.write(scope, conversationCacheKey(parentId, substreamId), row(), parentId);
    }

    evictCachedSubstream(new QueryClient(), parentId, 'child-a');

    await vi.waitFor(async () => {
      expect((await conversationSlice.entries(scope)).map((entry) => entry.key).sort()).toEqual([
        conversationCacheKey(parentId, '0'),
        conversationCacheKey(parentId, 'child-b'),
      ].sort());
    });
  });
});
