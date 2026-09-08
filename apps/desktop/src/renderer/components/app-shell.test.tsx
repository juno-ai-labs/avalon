import { QueryClient } from '@tanstack/react-query';
import { ProjectSummarySchema } from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import type { WorkstreamSummary } from '../lib/types';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { setCachedWorkstreams } from '../lib/workstreams-cache';
import {
  applyPinnedWorkstreams,
  applyPinnedWorkstreamsIfCurrent,
  backgroundRealtimeWorkstreamIds,
  invitationAccountMismatch,
  openWorkstreamId,
  showsAutomation,
  upsertProjectDirectory,
  windowControlsShellClass,
  workstreamMatchesBatchFilter,
} from './app-shell';

const workstreamId = '00000000-0000-7000-8000-000000000001';
const project = ProjectSummarySchema.parse({
  id: '00000000-0000-7000-8000-0000000000f2',
  name: 'Hiring',
  iconKey: 'target',
  colorKey: 'green',
  scope: 'personal',
  status: 'active',
  presentationRevision: 1,
  audienceGeneration: 1,
  lifecycleGeneration: 1,
  participants: [],
  workstreamIds: [],
  defaultResourceIds: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
});

function summary(harnessStatus: WorkstreamSummary['harnessStatus'], id = workstreamId): WorkstreamSummary {
  return {
    id,
    title: 'Draft the reply',
    titleStatus: 'settled',
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
    participantUserIds: [],
    participantExtraCount: 0,
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

describe('invitationAccountMismatch', () => {
  it('explains which account must sign in without exposing a dead invitation prompt', () => {
    expect(invitationAccountMismatch('invited@example.com', 'active@example.com')).toBe(
      'This invitation is for invited@example.com. Sign in with that account to continue.',
    );
    expect(invitationAccountMismatch('Invited@example.com', 'invited@example.com')).toBeNull();
  });
});

describe('upsertProjectDirectory', () => {
  it('does not duplicate a project when its socket push beats the REST response', () => {
    expect(upsertProjectDirectory({ waterline: 4, items: [project] }, project)).toEqual({
      waterline: 4,
      items: [project],
    });
  });
});

describe('workstreamMatchesBatchFilter', () => {
  it('uses visits for access-based archive cleanup and activity for legacy commands', () => {
    const row = { ...summary('completed'), lastActivityAt: '2026-08-01T00:00:00.000Z',
      lastAccessedAt: '2026-09-08T00:00:00.000Z' };
    const range = { lastActivityAt: { atOrAfter: '2026-09-01T00:00:00.000Z' }, includeSystem: false };
    expect(workstreamMatchesBatchFilter(row, { ...range, recency: 'access' })).toBe(true);
    expect(workstreamMatchesBatchFilter(row, range)).toBe(false);
    expect(workstreamMatchesBatchFilter({ ...row, lastActivityAt: row.lastAccessedAt,
      lastAccessedAt: '2026-08-01T00:00:00.000Z' }, { ...range, recency: 'access' })).toBe(false);
  });
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

describe('backgroundRealtimeWorkstreamIds', () => {
  it('opens every pinned pair, five recent unpinned pairs, and any other running pair', () => {
    const running = summary('running');
    const scheduled = summary('scheduled', '00000000-0000-7000-8000-000000000002');
    const completed = summary('completed', '00000000-0000-7000-8000-000000000003');
    const pinned = {
      ...summary('completed', '00000000-0000-7000-8000-000000000004'),
      pinPosition: 0,
      lastActivityAt: '2025-01-01T00:00:00.000Z',
    };
    const unpinned = Array.from({ length: 7 }, (_, index) => ({
      ...summary('completed', `00000000-0000-7000-8000-${String(index + 5).padStart(12, '0')}`),
      lastActivityAt: `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
    }));
    const oldButRunning = {
      ...running,
      lastActivityAt: '2024-01-01T00:00:00.000Z',
    };
    const finishedOld = {
      ...completed,
      lastActivityAt: '2023-01-01T00:00:00.000Z',
    };

    expect(backgroundRealtimeWorkstreamIds(scheduled.id, [
      oldButRunning,
      scheduled,
      finishedOld,
      pinned,
      ...unpinned,
    ])).toEqual([
      oldButRunning.id,
      pinned.id,
      ...unpinned.slice(2).map((workstream) => workstream.id),
    ]);
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

  it('catches the stable automation route in either lifecycle state', () => {
    expect(showsAutomation(`/automations/${automationId}`, automationId)).toBe(true);
  });

  it('leaves a screen showing something else alone', () => {
    expect(showsAutomation('/automations/new', automationId)).toBe(false);
    expect(showsAutomation('/automations/00000000-0000-7000-8000-000000000009', automationId)).toBe(false);
    expect(showsAutomation('/workstreams/new', automationId)).toBe(false);
  });
});

/**
 * The mapping itself, not just the decision behind it.
 *
 * A predicate returning `true` proves nothing about which class the shell then
 * writes, and nothing in this suite renders `AppShell` — so an inverted ternary
 * at the call site would put the traffic-light defect back on macOS with every
 * test still green. Returning the class name is what makes that reachable here.
 */
describe('windowControlsShellClass', () => {
  // The main window asks `hiddenInset` of darwin, which paints the traffic
  // lights over the page. Everywhere else it asks `hidden`, and the buttons are
  // in the window manager's frame or not drawn at all.
  it('names the class on macOS and nothing anywhere else', () => {
    expect(windowControlsShellClass('darwin')).toBe('has-overlay-window-controls');
    expect(windowControlsShellClass('win32')).toBe('');
    expect(windowControlsShellClass('linux')).toBe('');
  });

  // The runtime config is fetched, so the platform is briefly unknown. Reading
  // that as "nothing to clear" leaves the header where it already is rather
  // than jumping it sideways when the answer lands.
  it('names nothing while the platform is still unknown', () => {
    expect(windowControlsShellClass(undefined)).toBe('');
  });
});
