import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { WorkstreamSummary } from './types';
import { setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import {
  applyVersionedWorkstreamState,
  applyWorkspaceWorkstreamFields,
} from './workstream-state-store';

const id = '00000000-0000-7000-8000-000000000001';

function summary(overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id,
    title: 'Initial',
    titleStatus: 'settled',
    origin: 'ad_hoc',
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
});
