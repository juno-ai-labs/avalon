import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { conversationCacheKey, conversationSlice } from './conversation-cache';
import { clearAllLocalCache, localCacheScope } from './local-cache';
import {
  evictCachedSubstream,
  evictCachedWorkstream,
  invalidateCachedWorkstreamDetails,
  patchCachedWorkstream,
  patchCachedWorkstreamAppearance,
  setCachedWorkstreams,
  WORKSTREAMS_QUERY_KEY,
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
    spaceIds: [],
    lastActivityAt: '2026-08-12T12:00:00.000Z',
  };
}

describe('setCachedWorkstreams', () => {
  it('stores the flat array its readers consume', () => {
    const queryClient = new QueryClient();
    const items = [summary()];

    setCachedWorkstreams(queryClient, items);

    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual(items);
  });

  it('rejects a page object even when a type escape reaches the runtime boundary', () => {
    const queryClient = new QueryClient();

    expect(() => {
      // The compile-time contract rejects the page, and the runtime invariant
      // remains the backstop for a cast or untyped caller in shipped code.
      // @ts-expect-error A page is not the flat array this cache stores.
      setCachedWorkstreams(queryClient, { items: [summary()], nextCursor: null });
    }).toThrow('expected a WorkstreamSummary array');
  });

  it('evicts every per-channel cache family after access revocation', () => {
    const queryClient = new QueryClient();
    const workstreamId = summary().id;
    const other = { ...summary(), id: '00000000-0000-7000-8000-000000000002' };
    setCachedWorkstreams(queryClient, [summary(), other]);
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
    expect(queryClient.getQueryData(WORKSTREAMS_QUERY_KEY)).toEqual([other]);
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

describe('patchCachedWorkstreamAppearance', () => {
  it('merges the patch over the row\'s own appearance in the list and leaves the detail to the versioned push', () => {
    const queryClient = new QueryClient();
    const other = { ...summary(), id: '00000000-0000-7000-8000-000000000002', appearance: { icon: 'rocket', color: 'blue' } as const };
    setCachedWorkstreams(queryClient, [{ ...summary(), appearance: { icon: 'atom', color: 'gray' } }, other]);
    const detail = { ...summary(), appearance: { icon: 'atom', color: 'gray' } };
    queryClient.setQueryData(['workstream', summary().id], detail);

    patchCachedWorkstreamAppearance(queryClient, summary().id, { color: 'purple' });

    const list = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY);
    expect(list?.[0]?.appearance).toEqual({ icon: 'atom', color: 'purple' });
    expect(list?.[1]).toBe(other);
    // The header renders the detail under the picker's own preview; retiring
    // that preview on the receipt is what this write must not do.
    expect(queryClient.getQueryData(['workstream', summary().id])).toBe(detail);
  });

  it('fills the untouched field with null when the row still shows the generated default', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary()]);

    patchCachedWorkstreamAppearance(queryClient, summary().id, { icon: 'rocket' });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.appearance)
      .toEqual({ icon: 'rocket', color: null });
    expect(queryClient.getQueryData(['workstream', summary().id])).toBeUndefined();
  });
});

describe('patchCachedWorkstream', () => {
  it('writes the same patch to the list row and the main detail entry, and nothing else', () => {
    const queryClient = new QueryClient();
    const other = { ...summary(), id: '00000000-0000-7000-8000-000000000002' };
    setCachedWorkstreams(queryClient, [summary(), other]);
    queryClient.setQueryData(['workstream', summary().id], summary());

    patchCachedWorkstream(queryClient, summary().id, { title: 'Renamed', titleStatus: 'settled' });

    const list = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY);
    expect(list?.[0]?.title).toBe('Renamed');
    expect(list?.[1]).toBe(other);
    expect(queryClient.getQueryData<WorkstreamSummary>(['workstream', summary().id])?.title).toBe('Renamed');
  });

  it('patches a private child without changing the parent list row or detail', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary()]);
    queryClient.setQueryData(['workstream', summary().id], summary());
    queryClient.setQueryData(['substream-workstream', summary().id, 'child'], summary());

    patchCachedWorkstream(queryClient, summary().id, { scope: 'personal' }, 'child');

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.scope).toBe('workspace');
    expect(queryClient.getQueryData<WorkstreamSummary>(['substream-workstream', summary().id, 'child'])?.scope).toBe('personal');
    // The parent's own entry is not this write's to touch; the versioned
    // control snapshot owns it.
    expect(queryClient.getQueryData<WorkstreamSummary>(['workstream', summary().id])?.scope).toBe('workspace');
  });

  it('leaves an absent detail entry absent for a field patch', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary()]);

    patchCachedWorkstream(queryClient, summary().id, { title: 'Renamed' });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title).toBe('Renamed');
    // A materialized entry with only a title would render as a work stream
    // with no identity; absence has to stay absence.
    expect(queryClient.getQueryData(['workstream', summary().id])).toBeUndefined();
  });

  it('accepts a per-row updater and leaves an absent detail entry absent', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary()]);

    patchCachedWorkstream(queryClient, summary().id, (row) => ({ ...row, title: `${row.title}!` }));

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title).toBe('Typed cache boundary!');
    expect(queryClient.getQueryData(['workstream', summary().id])).toBeUndefined();
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
