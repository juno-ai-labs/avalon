import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import {
  applyPinnedWorkstreams,
  applyPinnedWorkstreamsIfCurrent,
  openWorkstreamId,
  staleHarnessStatusWorkstreamId,
} from './app-shell';

const workstreamId = '00000000-0000-7000-8000-000000000001';

function summary(harnessStatus: WorkstreamSummary['harnessStatus'], id = workstreamId): WorkstreamSummary {
  return {
    id,
    title: 'Draft the reply',
    titleStatus: 'settled',
    origin: 'ad_hoc',
    scope: 'workspace',
    harnessStatus,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    pinPosition: null,
    lastActivityAt: '2026-08-11T10:00:00.000Z',
  };
}

function detail(
  harnessStatus: WorkstreamDetail['harnessStatus'],
  dataUpdatedAt: number,
): { data?: WorkstreamDetail; dataUpdatedAt: number } {
  return { data: { id: workstreamId, harnessStatus } as WorkstreamDetail, dataUpdatedAt };
}

describe('openWorkstreamId', () => {
  it('names the work stream the route has open', () => {
    expect(openWorkstreamId(`/workstreams/${workstreamId}`)).toBe(workstreamId);
  });

  it('decodes an escaped segment, and survives a malformed one', () => {
    expect(openWorkstreamId('/workstreams/a%20b')).toBe('a b');
    expect(() => openWorkstreamId('/workstreams/%')).not.toThrow();
    expect(openWorkstreamId('/workstreams/%')).toBe('%');
  });

  it('has none for the composer, other screens, or a nested route', () => {
    expect(openWorkstreamId('/workstreams/new')).toBeNull();
    expect(openWorkstreamId('/automations/abc')).toBeNull();
    expect(openWorkstreamId(`/workstreams/${workstreamId}/settings`)).toBeNull();
  });
});

describe('applyPinnedWorkstreams', () => {
  const other = '00000000-0000-7000-8000-000000000002';

  function cacheWith(items: WorkstreamSummary[]): QueryClient {
    const queryClient = new QueryClient();
    queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, items);
    return queryClient;
  }

  it('takes every position from the response, including the pins it does not name', () => {
    const queryClient = cacheWith([
      { ...summary('completed'), pinPosition: 0 },
      { ...summary('completed', other), pinPosition: null },
    ]);

    applyPinnedWorkstreams(queryClient, [
      { ...summary('completed', other), pinPosition: 0 },
    ]);

    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY))
      .toEqual([
        expect.objectContaining({ id: workstreamId, pinPosition: null }),
        expect.objectContaining({ id: other, pinPosition: 0 }),
      ]);
  });

  // Two quick moves, the second answered first. The first response then
  // describes an order the server has already moved past, and the local drag
  // order has been cleared by the time it lands, so nothing else would hold the
  // newer arrangement on screen.
  it('discards a response a later request has superseded', () => {
    const newest = { ...summary('completed'), pinPosition: 1 };
    const queryClient = cacheWith([newest, { ...summary('completed', other), pinPosition: 0 }]);

    const stale = [{ ...summary('completed'), pinPosition: 0 }];
    expect(applyPinnedWorkstreamsIfCurrent(queryClient, stale, 1, 2)).toBe(false);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toBe(newest);

    // The response of the newest request is the one that wins, whenever it lands.
    expect(applyPinnedWorkstreamsIfCurrent(queryClient, stale, 2, 2)).toBe(true);
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY))
      .toEqual([
        expect.objectContaining({ id: workstreamId, pinPosition: 0 }),
        expect.objectContaining({ id: other, pinPosition: null }),
      ]);
  });

  it('leaves a row untouched when its position has not moved', () => {
    const unchanged = { ...summary('completed'), pinPosition: 0 };
    const queryClient = cacheWith([unchanged]);

    applyPinnedWorkstreams(queryClient, [{ ...summary('running'), pinPosition: 0 }]);

    // Rewriting the row would replace a status the socket is authoritative for
    // with whatever the pin response happened to carry.
    expect(queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)?.[0]).toBe(unchanged);
  });
});

describe('staleHarnessStatusWorkstreamId', () => {
  it('catches a detail left behind by a status the poll already has', () => {
    expect(staleHarnessStatusWorkstreamId(
      workstreamId,
      [summary('needs_input')],
      2_000,
      detail('running', 1_000),
    )).toBe(workstreamId);
  });

  it('leaves a detail written after the poll alone, so a push is not undone', () => {
    expect(staleHarnessStatusWorkstreamId(
      workstreamId,
      [summary('needs_input')],
      1_000,
      detail('running', 2_000),
    )).toBeNull();
  });

  it('stays quiet while the two agree', () => {
    expect(staleHarnessStatusWorkstreamId(
      workstreamId,
      [summary('running')],
      2_000,
      detail('running', 1_000),
    )).toBeNull();
  });

  it('stays quiet with no work stream open, no list yet, or no detail yet', () => {
    expect(staleHarnessStatusWorkstreamId(null, [summary('needs_input')], 2_000, detail('running', 1_000))).toBeNull();
    expect(staleHarnessStatusWorkstreamId(workstreamId, undefined, 2_000, detail('running', 1_000))).toBeNull();
    expect(staleHarnessStatusWorkstreamId(workstreamId, [summary('needs_input')], 2_000, undefined)).toBeNull();
    expect(staleHarnessStatusWorkstreamId(workstreamId, [], 2_000, detail('running', 1_000))).toBeNull();
  });
});
