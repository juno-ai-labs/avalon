import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { WorkstreamSummary } from './types';
import { holdCachedWorkstreamArchive, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import {
  applyVersionedWorkstreamState,
  applyWorkspaceWorkstreamFields,
  patchCachedWorkstreamViewerState,
  workstreamSummaryState,
} from './workstream-state-store';

const id = '00000000-0000-7000-8000-000000000001';

function summary(overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id,
    title: 'Initial',
    titleStatus: 'settled',
    scope: 'workspace',
    harnessStatus: 'running',
    latestAttentionSequenceNumber: 1,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: true,
    firstUnreadSequenceNumber: 1,
    nextPendingWakeup: null,
    pinPosition: null,
    participantUserIds: [],
    participantExtraCount: 0,
    spaceIds: [],
    lastActivityAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

function version(commonWaterline: number, viewerWaterline: number, generation = 1) {
  return {
    commonEventId: '0198bf7c-1000-7000-8000-000000000001',
    viewerEventId: '0198bf7c-1000-7000-8001-000000000001',
    authorityGeneration: generation,
    commonWaterline,
    viewerWaterline,
  };
}

describe('applyVersionedWorkstreamState', () => {
  // The directory lists a new Channel through this path, merged over the row
  // the create listed early; once the server describes it, it is not pending.
  // The server lists a Channel when its Space placement commits, before its
  // room is written; only the create's answer says the room is ready.
  it('takes the server\'s fields onto a row listed ahead of its create and keeps it pending', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ pending: true, title: '' })]);
    const seed = summary({ title: 'Launch plan' });

    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(1, 1),
      common: seed,
      viewer: seed,
      seed,
      visible: true,
    });

    const [row] = queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [];
    expect(row).toMatchObject({ title: 'Launch plan', pending: true, pendingListed: true });
  });

  it('merges independently ordered common and viewer rows from either socket', () => {
    const queryClient = new QueryClient();
    const seed = summary();
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(4, 2),
      common: { ...seed, title: 'Common four' },
      viewer: { readThroughSequenceNumber: 0 },
      seed,
      visible: true,
    });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(3, 3),
      common: { title: 'Stale common' },
      viewer: { readThroughSequenceNumber: 1 },
      seed,
      visible: true,
    });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toMatchObject({
      title: 'Common four',
      readThroughSequenceNumber: 1,
      hasUnread: false,
    });
  });

  it('ignores duplicate and stale rows delivered by the second socket', () => {
    const queryClient = new QueryClient();
    const seed = summary({ title: 'Current' });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: seed,
      viewer: seed,
      seed,
      visible: true,
    });
    const result = applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 4),
      common: { title: 'Duplicate' },
      viewer: { readThroughSequenceNumber: 0 },
      seed,
      visible: true,
    });
    expect(result).toEqual({ commonApplied: false, viewerApplied: false, visible: true });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title).toBe('Current');
  });

  it.each([
    { initialVisible: true, nextVersion: version(6, 4), incomingVisible: false },
    { initialVisible: true, nextVersion: version(4, 6), incomingVisible: false },
    { initialVisible: false, nextVersion: version(6, 4), incomingVisible: true },
    { initialVisible: false, nextVersion: version(4, 6), incomingVisible: true },
  ])(
    'keeps listability at $initialVisible when one half of a composite snapshot is stale',
    ({ initialVisible, nextVersion, incomingVisible }) => {
      const queryClient = new QueryClient();
      const seed = summary();
      applyVersionedWorkstreamState(queryClient, {
        workstreamId: id,
        stateVersion: version(5, 5),
        ...workstreamSummaryState(seed),
        visible: initialVisible,
      });

      const result = applyVersionedWorkstreamState(queryClient, {
        workstreamId: id,
        stateVersion: nextVersion,
        ...workstreamSummaryState(summary({
          ...(incomingVisible ? {} : { archivedAt: '2026-09-21T12:00:01.000Z' }),
        })),
        visible: incomingVisible,
      });

      expect(result.visible).toBe(initialVisible);
      expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [])
        .toHaveLength(initialVisible ? 1 : 0);
      if (initialVisible) {
        expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.archivedAt)
          .not.toBe('2026-09-21T12:00:01.000Z');
      }
    },
  );

  it('holds a confirmed archive through a newer in-flight page, then rejects that page after the tombstone', () => {
    const queryClient = new QueryClient();
    const active = summary({ updatedAt: '2026-09-21T12:00:00.000Z' });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      ...workstreamSummaryState(active),
      visible: true,
    });

    holdCachedWorkstreamArchive(queryClient, {
      ...active,
      archivedAt: '2026-09-21T12:00:01.000Z',
      updatedAt: '2026-09-21T12:00:01.000Z',
    });
    const delayedPage = applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(6, 6),
      ...workstreamSummaryState({ ...active, title: 'Delayed page' }),
      visible: true,
    });
    expect(delayedPage.visible).toBe(true);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0])
      .toMatchObject({ title: 'Initial', archivedAt: '2026-09-21T12:00:01.000Z' });

    const tombstone = applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(7, 7),
      common: {},
      viewer: {},
      visible: false,
    });
    expect(tombstone.visible).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)).toEqual([]);

    const staleAfterTombstone = applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(6, 6),
      ...workstreamSummaryState({ ...active, title: 'Delayed page' }),
      visible: true,
    });
    expect(staleAfterTombstone.visible).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)).toEqual([]);
  });

  it('accepts a newer restore even when the archive tombstone has not arrived', () => {
    const queryClient = new QueryClient();
    const active = summary({
      updatedAt: '2026-09-21T12:00:00.000Z',
    });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      ...workstreamSummaryState(active),
      visible: true,
    });
    holdCachedWorkstreamArchive(queryClient, {
      ...active,
      archivedAt: '2026-09-21T12:00:01.000Z',
      updatedAt: '2026-09-21T12:00:01.000Z',
    });

    const restored = summary({
      title: 'Restored',
      updatedAt: '2026-09-21T12:00:02.000Z',
    });
    const result = applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(6, 5),
      ...workstreamSummaryState(restored),
      visible: true,
    });

    expect(result).toEqual({ commonApplied: true, viewerApplied: false, visible: true });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0])
      .toMatchObject({ title: 'Restored', archivedAt: undefined });
  });

  it('resets both tables when an authority generation changes', () => {
    const queryClient = new QueryClient();
    const seed = summary();
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(50, 50),
      common: seed,
      viewer: seed,
      seed,
      visible: true,
    });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(1, 1, 2),
      common: { title: 'New generation' },
      viewer: { readThroughSequenceNumber: 1 },
      seed,
      visible: true,
    });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title)
      .toBe('New generation');
  });

  it('does not let an older directory page roll back WorkspaceDO-owned fields', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, () => [summary({ pinPosition: null })]);

    expect(applyWorkspaceWorkstreamFields(queryClient, id, { pinPosition: 2 }, 9)).toBe(true);
    expect(applyWorkspaceWorkstreamFields(queryClient, id, { pinPosition: null }, 8)).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.pinPosition)
      .toBe(2);
  });

  it('fills an empty control-socket pile from a later directory row at the same waterline', () => {
    const queryClient = new QueryClient();
    const empty = summary({
      title: 'Staffing',
      scope: 'personal',
      participantUserIds: [],
      participantExtraCount: 0,
      spaceIds: [],
    });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: { title: 'Staffing' },
      viewer: empty,
      seed: empty,
      visible: true,
    });

    const result = applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: {
        title: 'Staffing',
        participantUserIds: ['user-a', 'user-b'],
        participantExtraCount: 1,
        spaceIds: [],
      },
      viewer: {},
      visible: true,
    });

    expect(result.commonApplied).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toMatchObject({
      participantUserIds: ['user-a', 'user-b'],
      participantExtraCount: 1,
      spaceIds: [],
    });
  });

  it('takes a placement pushed at the waterline the row already had', () => {
    const queryClient = new QueryClient();
    const seed = summary({ title: 'Investigate ENG-142', spaceIds: ['general'] });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: seed,
      viewer: seed,
      seed,
      visible: true,
    });

    // Adding an Organization-wide Channel to a second Organization-wide Space
    // changes nothing the Channel's own authority projects, so WorkspaceDO
    // republishes this row at the waterline it already had. Dropping it as a
    // duplicate left the Channel under one Space for the session, and the
    // local cache then carried that row through a reload.
    const result = applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: { title: 'Investigate ENG-142', spaceIds: ['general', 'customer-launch'] },
      viewer: {},
      visible: true,
    });

    expect(result.commonApplied).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.spaceIds)
      .toEqual(['general', 'customer-launch']);
  });

  it('refuses a placement from a superseded authority generation', () => {
    const queryClient = new QueryClient();
    const seed = summary({ spaceIds: ['general'] });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5, 2),
      common: seed,
      viewer: seed,
      seed,
      visible: true,
    });

    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(9, 9, 1),
      common: { spaceIds: ['general', 'older-epoch'] },
      viewer: {},
      visible: true,
    });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.spaceIds)
      .toEqual(['general']);
  });

  it('does not invent a pile from an empty directory preview at a pinned waterline', () => {
    const queryClient = new QueryClient();
    const empty = summary({ title: 'Public room', scope: 'workspace' });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: { title: 'Public room' },
      viewer: empty,
      seed: empty,
      visible: true,
    });

    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: { title: 'Public room', participantUserIds: [], participantExtraCount: 0 },
      viewer: {},
      visible: true,
    });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toMatchObject({
      participantUserIds: [],
      participantExtraCount: 0,
      spaceIds: [],
    });
  });

  it('does not put a facepile on an organization-scoped row', () => {
    const queryClient = new QueryClient();
    const personal = summary({
      title: 'Launch',
      scope: 'personal',
      participantUserIds: ['user-a', 'user-b'],
      participantExtraCount: 1,
      spaceIds: [],
    });
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(4, 4),
      common: personal,
      viewer: personal,
      seed: personal,
      visible: true,
    });

    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(5, 5),
      common: { title: 'Launch', scope: 'workspace' },
      viewer: {},
      visible: true,
    });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toMatchObject({
      scope: 'workspace',
      participantUserIds: [],
      participantExtraCount: 0,
      spaceIds: [],
    });
  });
});

describe('patchCachedWorkstreamViewerState', () => {
  it('takes only the viewer fields from the response and rederives the unread pair', () => {
    const queryClient = new QueryClient();
    const cached = summary({
      appearance: { icon: 'atom', color: 'purple' },
      harnessStatus: 'running',
      latestAttentionSequenceNumber: 9,
      readThroughSequenceNumber: 3,
      hasUnread: true,
      firstUnreadSequenceNumber: 4,
    });
    setCachedWorkstreams(queryClient, [cached]);
    queryClient.setQueryData(['workstream', id], cached);
    // A response computed before a color change and a run start, delivered
    // after both: its common fields are stale and must not come along.
    const response = summary({
      appearance: { icon: 'atom', color: 'gray' },
      harnessStatus: 'completed',
      latestAttentionSequenceNumber: 9,
      readThroughSequenceNumber: 9,
      hasUnread: true,
      firstUnreadSequenceNumber: 4,
    });

    patchCachedWorkstreamViewerState(queryClient, id, response);

    for (const row of [
      queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0],
      queryClient.getQueryData<WorkstreamSummary>(['workstream', id]),
    ]) {
      expect(row?.appearance).toEqual({ icon: 'atom', color: 'purple' });
      expect(row?.harnessStatus).toBe('running');
      expect(row?.readThroughSequenceNumber).toBe(9);
      // Derived here from the new waterline, not copied from a response that
      // still said unread.
      expect(row?.hasUnread).toBe(false);
      expect(row?.firstUnreadSequenceNumber).toBeNull();
    }
  });

  it('lets a slower acknowledgement for an earlier position lose to the later one', () => {
    // Two can be in flight: the acknowledgement is debounced at 250ms and keyed
    // on the sequence it carries, so a round trip slower than the debounce can
    // land after a later one. Applied in arrival order, the earlier answer puts
    // the divider back above a message that has been read.
    const queryClient = new QueryClient();
    queryClient.setQueryData(['substream-workstream', id, 'child'], summary({
      latestAttentionSequenceNumber: 9,
      readThroughSequenceNumber: 9,
      hasUnread: false,
      firstUnreadSequenceNumber: null,
    }));

    patchCachedWorkstreamViewerState(queryClient, id, summary({
      latestAttentionSequenceNumber: 9,
      readThroughSequenceNumber: 5,
    }), 'child');

    const row = queryClient.getQueryData<WorkstreamSummary>(['substream-workstream', id, 'child']);
    expect(row?.readThroughSequenceNumber).toBe(9);
    expect(row?.firstUnreadSequenceNumber).toBeNull();
  });

  it('applies a mark-unread that raises the generation, whatever its read-through says', () => {
    // The other direction: a manual mark is the newer answer even though it
    // carries no higher waterline, so ordering on the waterline alone would
    // drop it and leave the row read.
    const queryClient = new QueryClient();
    queryClient.setQueryData(['workstream', id], summary({
      latestAttentionSequenceNumber: 9,
      readThroughSequenceNumber: 9,
      manualUnreadGeneration: 0,
      hasUnread: false,
      firstUnreadSequenceNumber: null,
    }));

    patchCachedWorkstreamViewerState(queryClient, id, summary({
      latestAttentionSequenceNumber: 9,
      readThroughSequenceNumber: 9,
      manualUnreadFromSequenceNumber: 9,
      manualUnreadGeneration: 1,
    }));

    const row = queryClient.getQueryData<WorkstreamSummary>(['workstream', id]);
    expect(row?.hasUnread).toBe(true);
    expect(row?.firstUnreadSequenceNumber).toBe(9);
  });

  // WorkspaceDO republishes the Channel's row after it finalizes a membership,
  // and that row is the only thing that tells the sidebar the Channel now sits
  // under another Space. Left out of the common patch, **Add to space** and a
  // drop both appear to do nothing until the whole directory is read again.
  it('carries a channel\'s space placements on a common state push', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary()]);

    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(2, 1),
      visible: true,
      ...workstreamSummaryState(summary({ spaceIds: ['space-a', 'space-b'] })),
    });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.spaceIds)
      .toEqual(['space-a', 'space-b']);
  });

  it('takes a changed Breakout attention total from a duplicate parent version', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ breakoutAttentionCount: 2 })]);
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(2, 1),
      visible: true,
      ...workstreamSummaryState(summary({ breakoutAttentionCount: 2 })),
    });

    applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(2, 1),
      visible: true,
      ...workstreamSummaryState(summary({ breakoutAttentionCount: 0 })),
    });

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.breakoutAttentionCount)
      .toBe(0);
  });

  it('takes participation from a duplicate version once, and never overwrites it after', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary()]);
    const at = (isParticipant?: boolean) => applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(2, 1),
      visible: true,
      ...workstreamSummaryState(summary(isParticipant === undefined ? {} : { isParticipant })),
    });
    const held = () => queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.isParticipant;

    at();
    expect(held()).toBeUndefined();
    at(false);
    expect(held()).toBe(false);
    at(true);
    expect(held()).toBe(false);
  });

  it('keeps participation through a newer row that does not say, and takes a newer one that does', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ isParticipant: false })]);
    const at = (viewerWaterline: number, isParticipant?: boolean) => applyVersionedWorkstreamState(queryClient, {
      workstreamId: id,
      stateVersion: version(2, viewerWaterline),
      visible: true,
      ...workstreamSummaryState(summary(isParticipant === undefined ? {} : { isParticipant })),
    });
    const held = () => queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.isParticipant;

    at(1, false);
    at(2);
    expect(held()).toBe(false);
    at(3, true);
    expect(held()).toBe(true);
  });

  it('writes the addressed child entry without changing Main in the list', () => {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, [summary({ readThroughSequenceNumber: 1 })]);
    queryClient.setQueryData(['substream-workstream', id, 'child'], summary({ readThroughSequenceNumber: 1 }));

    patchCachedWorkstreamViewerState(queryClient, id, summary({ readThroughSequenceNumber: 5 }), 'child');

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.readThroughSequenceNumber).toBe(1);
    expect(queryClient.getQueryData<WorkstreamSummary>(['substream-workstream', id, 'child'])?.readThroughSequenceNumber).toBe(5);
    expect(queryClient.getQueryData(['workstream', id])).toBeUndefined();
  });
});
