import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { WorkstreamSummary } from './types';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import {
  applyVersionedWorkstreamState,
  applyWorkspaceWorkstreamFields,
  patchCachedWorkstreamViewerState,
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
    expect(result).toEqual({ commonApplied: false, viewerApplied: false });
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]?.title).toBe('Current');
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
      },
      viewer: {},
      visible: true,
    });

    expect(result.commonApplied).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toMatchObject({
      participantUserIds: ['user-a', 'user-b'],
      participantExtraCount: 1,
    });
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
    });
  });

  it('does not put a facepile on a workspace-scoped row', () => {
    const queryClient = new QueryClient();
    const personal = summary({
      title: 'Launch',
      scope: 'personal',
      participantUserIds: ['user-a', 'user-b'],
      participantExtraCount: 1,
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
