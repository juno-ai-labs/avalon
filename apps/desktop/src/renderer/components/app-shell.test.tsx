import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { WorkstreamSummary } from '../lib/types';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { setCachedWorkstreams } from '../lib/workstreams-cache';
import {
  applyPinnedWorkstreams,
  applyPinnedWorkstreamsIfCurrent,
  backgroundRealtimeWorkstreamIds,
  openWorkstreamId,
  RUNNING_HARNESS_STATUSES,
  showsAutomation,
  workstreamMatchesBatchFilter,
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
    nextPendingWakeup: null,
    pinPosition: null,
    lastActivityAt: '2026-08-11T10:00:00.000Z',
  };
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

describe('workstreamMatchesBatchFilter', () => {
  it('matches the selected unpinned non-system row against the same half-open range', () => {
    expect(workstreamMatchesBatchFilter(summary('completed'), {
      lastActivityAt: {
        atOrAfter: '2026-08-11T00:00:00.000Z',
        before: '2026-08-12T00:00:00.000Z',
      },
      pinned: false,
      includeSystem: false,
    })).toBe(true);
    expect(workstreamMatchesBatchFilter(summary('completed'), {
      lastActivityAt: { before: '2026-08-11T10:00:00.000Z' },
      pinned: false,
      includeSystem: false,
    })).toBe(false);
  });
});

describe('RUNNING_HARNESS_STATUSES', () => {
  // Which states get a stop before the archive. Archiving takes away every
  // surface that could stop a run afterwards — `authorize` refuses an archived
  // work stream, so the stop route and the transcript both 404 — so a state
  // missing from this set is a run left burning with nothing left to reach it.
  it('covers every state that still has a run to stop', () => {
    expect([...RUNNING_HARNESS_STATUSES].sort()).toEqual(['needs_input', 'running', 'scheduled']);
  });

  it('leaves the finished states alone, so an idle row costs no request', () => {
    // `needs_input` is in the set rather than out of it: the run is parked for a
    // person who cannot answer once the row is gone from their sidebar.
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      expect(RUNNING_HARNESS_STATUSES.has(status)).toBe(false);
    }
  });
});

describe('backgroundRealtimeWorkstreamIds', () => {
  it('keeps other running work streams live without opening sockets for scheduled or foreground work', () => {
    const running = summary('running');
    const scheduled = summary('scheduled', '00000000-0000-7000-8000-000000000002');
    const completed = summary('completed', '00000000-0000-7000-8000-000000000003');

    expect(backgroundRealtimeWorkstreamIds(running.id, [running, scheduled, completed]))
      .toEqual([]);
    expect(backgroundRealtimeWorkstreamIds(null, [running, scheduled, completed]))
      .toEqual([running.id]);
  });
});

describe('applyPinnedWorkstreams', () => {
  const other = '00000000-0000-7000-8000-000000000002';

  function cacheWith(items: WorkstreamSummary[]): QueryClient {
    const queryClient = new QueryClient();
    setCachedWorkstreams(queryClient, items);
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

describe('showsAutomation', () => {
  const automationId = '00000000-0000-7000-8000-000000000002';

  it('catches the builder holding a draft, not only the overview', () => {
    expect(showsAutomation(`/automations/${automationId}`, '', automationId)).toBe(true);
    // Archiving and deleting both go through this: a draft is read here, and
    // the builder has no path of its own to match on.
    expect(showsAutomation('/automations/new', `?draft=${automationId}`, automationId)).toBe(true);
  });

  it('leaves a screen showing something else alone', () => {
    expect(showsAutomation('/automations/new', '?draft=another-draft', automationId)).toBe(false);
    expect(showsAutomation('/automations/new', '', automationId)).toBe(false);
    expect(showsAutomation('/automations/00000000-0000-7000-8000-000000000009', '', automationId)).toBe(false);
    expect(showsAutomation('/workstreams/new', '', automationId)).toBe(false);
  });
});
