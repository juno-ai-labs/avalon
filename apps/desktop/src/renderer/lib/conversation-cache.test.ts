import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationCacheKey,
  conversationSlice,
  forgetConversation,
  forgetConversationParent,
  hydrateConversation,
  mirrorConversation,
  retainConversationChildren,
  retainConversationParents,
  type ConversationCacheKeys,
} from './conversation-cache';
import { clearAllLocalCache, closeLocalCache, localCacheScope } from './local-cache';
import type { WorkstreamDetail } from './types';

const scope = localCacheScope('global', '00000000-0000-7000-8000-000000000001');
const otherScope = localCacheScope('eu', '00000000-0000-7000-8000-000000000001');
const parentId = '00000000-0000-7000-8000-000000000010';
const childId = '00000000-0000-7000-8000-000000000011';

function detail(overrides: Partial<WorkstreamDetail> = {}): WorkstreamDetail {
  return {
    id: parentId,
    title: 'Remembered',
    titleStatus: 'settled',
    harnessStatus: 'completed',
    scope: 'workspace',
    latestAttentionSequenceNumber: 3,
    readThroughSequenceNumber: 3,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    lastActivityAt: '2026-09-01T12:00:00.000Z',
    createdAt: '2026-09-01T11:00:00.000Z',
    participants: [],
    viewers: [{ id: 'viewer-1', name: 'Someone', email: 'someone@example.com', timezone: 'UTC', viewing: true }],
    resources: [],
    connections: [],
    backgroundTasks: [],
    ...overrides,
  };
}

function turn(sequence: number, text: string) {
  return {
    transcriptSequence: sequence,
    turnId: `turn-${sequence}`,
    entryKind: 'conversation' as const,
    actor: 'assistant' as const,
    authorUserId: null,
    authorSnapshot: null,
    attentionOrdinal: null,
    createdAtUtc: '2026-09-01T12:00:00.000Z',
    revision: 1,
    blocks: [{ type: 'text' as const, blockId: `turn-${sequence}:text:0`, blockIndex: 0, text, streaming: false }],
    activityId: null,
  };
}

function transcript(): WorkstreamTranscriptSnapshot {
  return {
    snapshotId: '00000000-0000-7000-8000-000000000777',
    snapshotThrough: 3,
    eventSequence: 40,
    snapshotAtUtc: '2026-09-01T12:00:00.000Z',
    unreadAnchorSequence: null,
    unreadReason: 'no_unread',
    ranges: [
      {
        purpose: 'requested',
        requested: { startInclusive: 1, endExclusive: 3 },
        covered: { startInclusive: 1, endExclusive: 3 },
        turns: [turn(1, 'paged in'), turn(2, 'also paged in')],
        activities: [],
        pluginRuns: [],
      },
      {
        purpose: 'latest',
        requested: { startInclusive: 3, endExclusive: 4 },
        covered: { startInclusive: 3, endExclusive: 4 },
        turns: [turn(3, 'the latest')],
        activities: [],
        pluginRuns: [],
      },
    ],
    activities: [],
    activeActivities: [],
    pluginRuns: [],
    activeTurns: [],
    pendingInputs: [],
  };
}

function keysFor(substreamId: string): ConversationCacheKeys {
  return substreamId === '0'
    ? {
        detail: ['workstream', parentId],
        transcript: ['ordered-transcript', parentId],
        initialContext: ['substream-initial-context', parentId, substreamId],
        feedSource: ['workstream-feed-source', parentId],
      }
    : {
        detail: ['substream-workstream', parentId, substreamId],
        transcript: ['substream-ordered-transcript', parentId, substreamId],
        initialContext: ['substream-initial-context', parentId, substreamId],
        feedSource: ['substream-workstream-feed-source', parentId, substreamId],
      };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('conversation cache', () => {
  beforeEach(() => clearAllLocalCache());
  afterEach(() => closeLocalCache());

  it('seeds empty caches from the row and marks them as a seed', async () => {
    await conversationSlice.write(scope, conversationCacheKey(parentId, '0'), {
      detail: detail(), transcript: transcript(), initialContext: null, cachedAt: '2026-09-01T12:00:00.000Z',
    }, parentId);
    const queryClient = new QueryClient();
    const keys = keysFor('0');

    await expect(hydrateConversation(queryClient, scope, parentId, '0', keys, () => true)).resolves.toBe('seeded');

    expect(queryClient.getQueryData<WorkstreamDetail>(keys.detail)?.title).toBe('Remembered');
    expect(queryClient.getQueryData<WorkstreamTranscriptSnapshot>(keys.transcript)?.eventSequence).toBe(40);
    expect(queryClient.getQueryData(keys.feedSource)).toBe('local_cache');
    expect(queryClient.getQueryData(keys.initialContext)).toBeUndefined();
  });

  it('leaves live data alone when it arrived first, and stands down when no longer wanted', async () => {
    await conversationSlice.write(scope, conversationCacheKey(parentId, '0'), {
      detail: detail(), transcript: transcript(), initialContext: null, cachedAt: '',
    }, parentId);
    const queryClient = new QueryClient();
    const keys = keysFor('0');
    queryClient.setQueryData(keys.detail, detail({ title: 'Live' }));

    await expect(hydrateConversation(queryClient, scope, parentId, '0', keys, () => true)).resolves.toBe('skipped');
    expect(queryClient.getQueryData<WorkstreamDetail>(keys.detail)?.title).toBe('Live');
    expect(queryClient.getQueryData(keys.feedSource)).toBeUndefined();

    const fresh = new QueryClient();
    await expect(hydrateConversation(fresh, scope, parentId, '0', keys, () => false)).resolves.toBe('skipped');
    expect(fresh.getQueryData(keys.detail)).toBeUndefined();
  });

  it('reports a missing row, and one written under another workspace', async () => {
    await conversationSlice.write(otherScope, conversationCacheKey(parentId, '0'), {
      detail: detail(), transcript: transcript(), initialContext: null, cachedAt: '',
    }, parentId);

    await expect(hydrateConversation(new QueryClient(), scope, parentId, '0', keysFor('0'), () => true))
      .resolves.toBe('missing');
  });

  it('persists a live conversation trimmed to its opening ranges, and never a seed', async () => {
    const queryClient = new QueryClient();
    const keys = keysFor('0');
    const mirror = mirrorConversation(queryClient, scope, parentId, '0', keys);

    queryClient.setQueryData(keys.feedSource, 'local_cache');
    queryClient.setQueryData(keys.detail, detail({ title: 'Seeded' }));
    queryClient.setQueryData(keys.transcript, transcript());
    await mirror.flush();
    expect(await conversationSlice.read(scope, conversationCacheKey(parentId, '0'))).toBeNull();

    queryClient.setQueryData(keys.feedSource, 'socket_snapshot');
    queryClient.setQueryData(keys.detail, detail({ title: 'Live' }));
    queryClient.setQueryData(keys.transcript, transcript());
    await mirror.flush();
    const row = await conversationSlice.read(scope, conversationCacheKey(parentId, '0'));
    expect(row?.detail.title).toBe('Live');
    expect(row?.transcript.ranges.map((range) => range.purpose)).toEqual(['latest']);
    expect(row?.detail.viewers).toEqual([]);
    mirror.stop();
  });

  it('waits for a child\'s inherited context before persisting it', async () => {
    const queryClient = new QueryClient();
    const keys = keysFor(childId);
    const mirror = mirrorConversation(queryClient, scope, parentId, childId, keys);
    queryClient.setQueryData(keys.feedSource, 'socket_snapshot');
    queryClient.setQueryData(keys.detail, detail({ title: 'Child' }));
    queryClient.setQueryData(keys.transcript, transcript());
    await mirror.flush();
    expect(await conversationSlice.read(scope, conversationCacheKey(parentId, childId))).toBeNull();

    queryClient.setQueryData(keys.initialContext, null);
    await mirror.flush();
    const row = await conversationSlice.read(scope, conversationCacheKey(parentId, childId));
    expect(row?.detail.title).toBe('Child');
    expect(row?.initialContext).toBeNull();
    mirror.stop();

    const hydrated = new QueryClient();
    await expect(hydrateConversation(hydrated, scope, parentId, childId, keys, () => true)).resolves.toBe('seeded');
    expect(hydrated.getQueryData(keys.initialContext)).toBeNull();
  });

  it('keeps only the parents the directory lists, and only the children the roster lists', async () => {
    const other = '00000000-0000-7000-8000-000000000020';
    const row = { detail: detail(), transcript: transcript(), initialContext: null, cachedAt: '' };
    await conversationSlice.write(scope, conversationCacheKey(parentId, '0'), row, parentId);
    await conversationSlice.write(scope, conversationCacheKey(parentId, childId), row, parentId);
    await conversationSlice.write(scope, conversationCacheKey(parentId, 'gone'), row, parentId);
    await conversationSlice.write(scope, conversationCacheKey(other, '0'), { ...row, detail: detail({ id: other }) }, other);

    await expect(retainConversationChildren(scope, parentId, new Set([childId]))).resolves
      .toEqual([conversationCacheKey(parentId, 'gone')]);
    await expect(retainConversationParents(scope, new Set([parentId]))).resolves
      .toEqual([conversationCacheKey(other, '0')]);
    expect((await conversationSlice.entries(scope)).map((entry) => entry.key).sort()).toEqual([
      conversationCacheKey(parentId, '0'),
      conversationCacheKey(parentId, childId),
    ].sort());
  });

  it('forgets a parent in every workspace, and one child on its own', async () => {
    const row = { detail: detail(), transcript: transcript(), initialContext: null, cachedAt: '' };
    await conversationSlice.write(scope, conversationCacheKey(parentId, '0'), row, parentId);
    await conversationSlice.write(scope, conversationCacheKey(parentId, childId), row, parentId);
    await conversationSlice.write(otherScope, conversationCacheKey(parentId, '0'), row, parentId);

    forgetConversation(parentId, childId);
    await settle();
    expect(await conversationSlice.read(scope, conversationCacheKey(parentId, childId))).toBeNull();
    expect(await conversationSlice.read(scope, conversationCacheKey(parentId, '0'))).not.toBeNull();

    forgetConversationParent(parentId);
    await settle();
    expect(await conversationSlice.entries(scope)).toEqual([]);
    expect(await conversationSlice.entries(otherScope)).toEqual([]);
  });
});
