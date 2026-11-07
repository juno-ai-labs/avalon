import "../../../../../tests/isolated-region";
import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import { WorkspaceConversationViewEventSchema } from '@rally/contracts/conversation-view';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationCacheKey,
  conversationSlice,
  forgetConversation,
  forgetConversationParent,
  hydrateConversation,
  seedWorkspaceConversation,
  mirrorConversation,
  retainConversationParents,
  type ConversationCacheKeys,
} from './conversation-cache';
import { clearAllLocalCache, closeLocalCache, defineLocalCacheSlice, localCacheScope } from './local-cache';
import type { WorkstreamDetail } from './types';

const scope = localCacheScope('00000000-0000-7000-8000-0000000000aa', 'global', '00000000-0000-7000-8000-000000000001');
const otherScope = localCacheScope('00000000-0000-7000-8000-0000000000aa', 'enterprise', '00000000-0000-7000-8000-000000000001');
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

  it('paints a workspace projection read-only and refuses late projections over live data', () => {
    const client = new QueryClient();
    const keys = keysFor('0');
    const event = WorkspaceConversationViewEventSchema.parse({
      type: 'workspace_conversation_view', parentId, substreamId: '0',
      requestId: '00000000-0000-7000-8000-000000000012',
      view: { header: {
        title: 'Workspace preview', titleStatus: 'settled', scope: 'workspace', harnessStatus: 'completed',
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      }, transcript: transcript() },
    });
    expect(seedWorkspaceConversation(client, event, keys)).toBe(true);
    expect(client.getQueryData<WorkstreamDetail>(keys.detail)?.title).toBe('Workspace preview');
    expect(client.getQueryData(keys.feedSource)).toBe('local_cache');
    client.setQueryData(keys.detail, detail({ title: 'Authoritative snapshot' }));
    client.setQueryData(keys.feedSource, 'socket_snapshot');
    expect(seedWorkspaceConversation(client, event, keys)).toBe(false);
    expect(client.getQueryData<WorkstreamDetail>(keys.detail)?.title).toBe('Authoritative snapshot');
    expect(client.getQueryData(keys.feedSource)).toBe('socket_snapshot');
    client.clear();
  });

  it('does not let a header-only preview prevent disk hydration', () => {
    const client = new QueryClient();
    const keys = keysFor('0');
    const empty = transcript();
    empty.ranges = [];
    const event = WorkspaceConversationViewEventSchema.parse({
      type: 'workspace_conversation_view', parentId, substreamId: '0',
      requestId: '00000000-0000-7000-8000-000000000012',
      view: { header: { title: 'Only a header', titleStatus: 'settled', scope: 'workspace', harnessStatus: 'completed',
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }, transcript: empty },
    });
    expect(seedWorkspaceConversation(client, event, keys)).toBe(false);
    expect(client.getQueryData(keys.detail)).toBeUndefined();
    expect(client.getQueryData(keys.transcript)).toBeUndefined();
    client.clear();
  });

  it.each(['0', childId])('refreshes a disk seed only with newer visible turns (%s)', (substreamId) => {
    const client = new QueryClient();
    const keys = keysFor(substreamId);
    client.setQueryData(keys.feedSource, 'local_cache');
    client.setQueryData(keys.detail, detail());
    client.setQueryData(keys.transcript, transcript());
    client.setQueryData(keys.initialContext, { remembered: true });
    const held = client.getQueryData(keys.transcript);
    const preview = transcript();
    preview.ranges = [preview.ranges[1]!];
    const event = WorkspaceConversationViewEventSchema.parse({
      type: 'workspace_conversation_view', parentId, substreamId,
      requestId: '00000000-0000-7000-8000-000000000012',
      view: { header: { title: 'Fresh preview', titleStatus: 'settled', scope: 'workspace', harnessStatus: 'completed',
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }, transcript: preview },
    });
    // Equal compact content cannot throw away the disk's richer ranges.
    expect(seedWorkspaceConversation(client, event, keys)).toBe(false);
    expect(client.getQueryData(keys.transcript)).toBe(held);
    event.view!.transcript.ranges[0]!.turns[0] = { ...turn(3, 'Edited on another device'), revision: 2 };
    expect(seedWorkspaceConversation(client, event, keys)).toBe(true);
    expect(client.getQueryData<WorkstreamTranscriptSnapshot>(keys.transcript)?.ranges.flatMap((range) => range.turns).find((item) => item.turnId === 'turn-3')?.blocks[0])
      .toMatchObject({ text: 'Edited on another device' });
    expect(client.getQueryData<WorkstreamTranscriptSnapshot>(keys.transcript)?.ranges.flatMap((range) => range.turns).map((item) => item.turnId))
      .toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(client.getQueryData<WorkstreamDetail>(keys.detail)?.latestAttentionSequenceNumber).toBe(3);
    expect(client.getQueryData(keys.initialContext)).toEqual({ remembered: true });
    expect(client.getQueryData(keys.feedSource)).toBe('local_cache');
    // Even a later tail must not put the edited turn's previous revision back.
    event.view!.transcript.snapshotThrough = 4;
    event.view!.transcript.ranges[0]!.turns = [turn(3, 'Old edit'), turn(4, 'New tail')];
    expect(seedWorkspaceConversation(client, event, keys)).toBe(false);
    event.view!.transcript.snapshotThrough = 2;
    event.view!.transcript.ranges[0]!.turns = [turn(2, 'Old tail')];
    expect(seedWorkspaceConversation(client, event, keys)).toBe(false);
    client.clear();
  });

  it('refreshes visible revisions across hidden interior and tail turns without losing rich state', () => {
    const client = new QueryClient();
    const keys = keysFor('0');
    const disk = transcript();
    const rich = { ...turn(1, 'Unchanged answer'), activityId: 'assistant-1', blocks: [
      ...turn(1, 'Unchanged answer').blocks,
      { type: 'thinking' as const, blockId: 'thinking-1', blockIndex: 1, providerEvidence: 'reasoning_summary' as const, summary: null, activityId: 'thinking-work' },
    ] };
    const hidden = (sequence: number) => ({ ...turn(sequence, ''), blocks: [
      { type: 'thinking' as const, blockId: `hidden-${sequence}`, blockIndex: 0, providerEvidence: 'reasoning_summary' as const, summary: null, activityId: `hidden-work-${sequence}` },
    ] });
    disk.snapshotThrough = 5;
    disk.ranges = [{ ...disk.ranges[1]!, covered: { startInclusive: 1, endExclusive: 6 },
      requested: { startInclusive: 1, endExclusive: 6 }, turns: [rich, hidden(2), turn(3, 'Stale answer'), hidden(5)] }];
    const activity = { activityId: 'thinking-work', parentActivityId: 'assistant-1', scope: 'thinking' as const,
      subjectId: 'turn-1', callIndex: null, label: 'Thinking', state: 'active' as const, intervals: [], revision: 1 };
    disk.activities = [activity];
    disk.activeActivities = [activity];
    disk.pluginRuns = [{ pluginRunId: 'plugin-1', turnId: 'turn-1', pluginId: 'terminal', displayName: 'Terminal',
      state: 'completed', durationMs: 123, elapsedMsAtSnapshot: null, timingAccuracy: 'observed', toolCallIds: ['tool-1'] }];
    disk.ranges[0]!.activities = disk.activities;
    disk.ranges[0]!.pluginRuns = disk.pluginRuns;
    const preview = transcript();
    preview.ranges = [{ ...preview.ranges[1]!, covered: { startInclusive: 1, endExclusive: 4 },
      requested: { startInclusive: 1, endExclusive: 4 }, turns: [turn(1, 'Unchanged answer'), { ...turn(3, 'Fresh answer'), revision: 2 }] }];
    const event = WorkspaceConversationViewEventSchema.parse({
      type: 'workspace_conversation_view', parentId, substreamId: '0',
      requestId: '00000000-0000-7000-8000-000000000012',
      view: { header: { title: 'Fresh', titleStatus: 'settled', scope: 'workspace', harnessStatus: 'completed',
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }, transcript: preview },
    });
    client.setQueryData(keys.feedSource, 'local_cache');
    client.setQueryData(keys.detail, detail());
    client.setQueryData(keys.transcript, disk);
    expect(seedWorkspaceConversation(client, event, keys)).toBe(true);
    const result = client.getQueryData<WorkstreamTranscriptSnapshot>(keys.transcript)!;
    expect(result.ranges.flatMap((range) => range.turns).map((item) => [item.turnId, item.blocks[0]?.type === 'text' ? item.blocks[0].text : item.blocks[0]?.type]))
      .toEqual([['turn-5', 'thinking'], ['turn-1', 'Unchanged answer'], ['turn-2', 'thinking'], ['turn-3', 'Fresh answer']]);
    expect(result.ranges.flatMap((range) => range.turns).find((item) => item.turnId === 'turn-1')?.blocks)
      .toEqual([expect.objectContaining({ text: 'Unchanged answer' }), expect.objectContaining({ type: 'thinking', activityId: 'thinking-work' })]);
    expect(result.pluginRuns).toEqual([expect.objectContaining({ toolCallIds: ['tool-1'], durationMs: 123 })]);
    expect(result.ranges.flatMap((range) => range.pluginRuns)).toEqual([expect.objectContaining({ toolCallIds: ['tool-1'] })]);
    expect(result.activeActivities).toEqual([expect.objectContaining({ activityId: 'thinking-work', state: 'active' })]);
    // A missing projectable answer is still a real incomplete delivery.
    event.view!.transcript.ranges[0]!.turns = [{ ...turn(3, 'Even fresher'), revision: 3 }];
    expect(seedWorkspaceConversation(client, event, keys)).toBe(false);
    client.clear();
  });

  it('retains an active-only turn and its rendering state outside the preview window', () => {
    const client = new QueryClient();
    const keys = keysFor('0');
    const disk = transcript();
    disk.ranges = [disk.ranges[1]!];
    disk.activeTurns = [{ ...turn(1, 'Still running'), activityId: 'active-assistant' }];
    disk.activities = [{ activityId: 'active-assistant', parentActivityId: null, scope: 'assistant_turn',
      subjectId: 'turn-1', callIndex: null, label: 'Rally', state: 'active', intervals: [], revision: 1 }];
    disk.activeActivities = disk.activities;
    disk.pluginRuns = [{ pluginRunId: 'active-plugin', turnId: 'turn-1', pluginId: 'terminal', displayName: 'Terminal',
      state: 'active', durationMs: null, elapsedMsAtSnapshot: 123, timingAccuracy: 'observed', toolCallIds: ['active-call'] }];
    const preview = transcript();
    preview.ranges = [preview.ranges[1]!];
    preview.ranges[0]!.turns[0] = { ...turn(3, 'Fresh answer'), revision: 2 };
    const event = WorkspaceConversationViewEventSchema.parse({
      type: 'workspace_conversation_view', parentId, substreamId: '0',
      requestId: '00000000-0000-7000-8000-000000000012',
      view: { header: { title: 'Fresh', titleStatus: 'settled', scope: 'workspace', harnessStatus: 'completed',
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }, transcript: preview },
    });
    client.setQueryData(keys.feedSource, 'local_cache');
    client.setQueryData(keys.detail, detail());
    client.setQueryData(keys.transcript, disk);
    expect(seedWorkspaceConversation(client, event, keys)).toBe(true);
    const result = client.getQueryData<WorkstreamTranscriptSnapshot>(keys.transcript)!;
    expect(result.activeTurns).toEqual([expect.objectContaining({ turnId: 'turn-1', blocks: [expect.objectContaining({ text: 'Still running' })] })]);
    expect(result.activeActivities).toEqual([expect.objectContaining({ activityId: 'active-assistant', state: 'active' })]);
    expect(result.pluginRuns).toEqual([expect.objectContaining({ pluginRunId: 'active-plugin', toolCallIds: ['active-call'] })]);
    client.clear();
  });

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

  it('refuses a row a wipe overtook while it was being read', async () => {
    await conversationSlice.write(scope, conversationCacheKey(parentId, '0'), {
      detail: detail(), transcript: transcript(), initialContext: null, cachedAt: '',
    }, parentId);
    const queryClient = new QueryClient();
    const keys = keysFor('0');
    // The wipe begins after the row has been read and before it is seeded:
    // the account changed while the read was in flight.
    let wipe: Promise<void> | null = null;
    const stillWanted = (): boolean => {
      wipe = clearAllLocalCache();
      return true;
    };

    await expect(hydrateConversation(queryClient, scope, parentId, '0', keys, stillWanted)).resolves.toBe('skipped');
    await wipe;

    expect(queryClient.getQueryData(keys.detail)).toBeUndefined();
    expect(queryClient.getQueryData(keys.feedSource)).toBeUndefined();
  });

  it('refuses a row whose nested detail lacks a field the screens read', async () => {
    const raw = defineLocalCacheSlice<unknown>({ kind: 'conversation', version: 1, parse: (value) => value });
    // A participant written by a build whose people had no email yet.
    await raw.write(scope, conversationCacheKey(parentId, '0'), {
      detail: { ...detail(), participants: [{ id: 'person-1', name: 'Someone' }] },
      transcript: transcript(),
      initialContext: null,
      cachedAt: '',
    }, parentId);

    expect(await conversationSlice.read(scope, conversationCacheKey(parentId, '0'))).toBeNull();
    await expect(hydrateConversation(new QueryClient(), scope, parentId, '0', keysFor('0'), () => true))
      .resolves.toBe('missing');
  });

  it('reports a missing row, and one written under another organization', async () => {
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

  it('keeps only the parents the directory lists, with every conversation under them', async () => {
    const other = '00000000-0000-7000-8000-000000000020';
    const row = { detail: detail(), transcript: transcript(), initialContext: null, cachedAt: '' };
    await conversationSlice.write(scope, conversationCacheKey(parentId, '0'), row, parentId);
    await conversationSlice.write(scope, conversationCacheKey(parentId, childId), row, parentId);
    await conversationSlice.write(scope, conversationCacheKey(parentId, 'gone'), row, parentId);
    await conversationSlice.write(scope, conversationCacheKey(other, '0'), { ...row, detail: detail({ id: other }) }, other);

    await expect(retainConversationParents(scope, new Set([parentId]))).resolves
      .toEqual([conversationCacheKey(other, '0')]);
    expect((await conversationSlice.entries(scope)).map((entry) => entry.key).sort()).toEqual([
      conversationCacheKey(parentId, '0'),
      conversationCacheKey(parentId, childId),
      conversationCacheKey(parentId, 'gone'),
    ].sort());
  });

  it('forgets a parent in every organization, and one child on its own', async () => {
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
