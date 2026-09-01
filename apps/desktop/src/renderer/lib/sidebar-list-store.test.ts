import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyVersionedNotePage,
  applyVersionedProjectSnapshot,
  applyVersionedSidebarList,
  SIDEBAR_LIST_QUERY_KEYS,
} from './sidebar-list-store';
import type { ProjectSnapshot } from '@rally/contracts';
import type { AutomationSummary, NoteSummary } from './types';

function automation(id: string): AutomationSummary {
  return {
    id,
    name: 'Weekly changelog',
    scope: 'workspace',
    status: 'active',
    updatedAt: '2026-08-22T18:00:00.000Z',
  };
}

function note(id: string, lastActivityAt: string): NoteSummary {
  return {
    id,
    workspaceId: '00000000-0000-4000-8000-000000000010',
    resourceId: `${id}-resource`,
    ownerUserId: '00000000-0000-4000-8000-000000000001',
    scope: 'personal',
    title: `Note ${id}`,
    recordingStatus: 'complete',
    recordedMs: 0,
    startedAt: null,
    endedAt: null,
    generatedAt: null,
    lastActivityAt,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    archivedAt: null,
  };
}

function cachedNotes(queryClient: QueryClient): string[] {
  return (queryClient.getQueryData<NoteSummary[]>(SIDEBAR_LIST_QUERY_KEYS.notes) ?? [])
    .map((entry) => entry.id);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('applyVersionedSidebarList', () => {
  it('still refuses an older version after the ledger has sat unobserved', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();

    expect(applyVersionedSidebarList(queryClient, 'automations', 5, [automation('a')])).toBe(true);

    // Nothing renders the waterlines, so React Query counts the entry as
    // inactive from the moment it is written and collects it once `gcTime`
    // elapses. The two lists survive that because the shell observes them; a
    // collected ledger would silently reset the guard and let this stale push
    // overwrite the newer list already applied.
    vi.advanceTimersByTime(30 * 60_000);

    // The list entry is collected here too, because this test observes nothing;
    // in the shell `useSocketOwnedList` holds it. The ledger has no such anchor,
    // which is the whole point — so what is asserted is the guard's answer.
    expect(applyVersionedSidebarList(queryClient, 'automations', 3, [automation('b')])).toBe(false);

    // And a genuinely newer one still applies, so the pin has not frozen it.
    expect(applyVersionedSidebarList(queryClient, 'automations', 6, [automation('c')])).toBe(true);
  });

  it('keeps a late project snapshot from replacing a newer directory', () => {
    const queryClient = new QueryClient();
    const newer = {
      active: { waterline: 8, items: [] },
      inactive: { waterline: 8, items: [] },
    } satisfies ProjectSnapshot;
    const older = {
      active: { waterline: 7, items: [] },
      inactive: { waterline: 7, items: [] },
    } satisfies ProjectSnapshot;

    expect(applyVersionedProjectSnapshot(queryClient, newer)).toBe(true);
    expect(applyVersionedProjectSnapshot(queryClient, older)).toBe(false);
    expect(queryClient.getQueryData(['projects'])).toEqual(newer.active);
    expect(queryClient.getQueryData(['projects-inactive'])).toEqual(newer.inactive);
  });
});

describe('applyVersionedNotePage', () => {
  it('keeps the pages a reader has scrolled to when the push is only the head', () => {
    // The defect this exists to prevent: a push carries the newest page, not
    // the list, so replacing on every push would snap a reader who had scrolled
    // back to one page with nothing on screen to explain it.
    const queryClient = new QueryClient();
    applyVersionedNotePage(queryClient, 1, [
      note('a', '2026-09-01T12:00:00.000Z'),
      note('b', '2026-09-01T11:00:00.000Z'),
      note('c', '2026-09-01T10:00:00.000Z'),
      note('d', '2026-09-01T09:00:00.000Z'),
    ], null);

    applyVersionedNotePage(queryClient, 2, [
      note('a', '2026-09-01T12:00:00.000Z'),
      note('b', '2026-09-01T11:00:00.000Z'),
    ], '2026-09-01T11:00:00.000Z:00000000-0000-4000-8000-00000000000b');

    expect(cachedNotes(queryClient)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops a note the head page covers and no longer lists, but keeps the tail', () => {
    // The other half: within the range this page spans it *is* authoritative,
    // so a held row inside that range and absent from it has been archived —
    // `b` here. Below the range the push says nothing at all, because the row
    // it stops at could be followed by anything; `d` therefore stays until the
    // refetch that walks every loaded page.
    const queryClient = new QueryClient();
    applyVersionedNotePage(queryClient, 1, [
      note('a', '2026-09-01T12:00:00.000Z'),
      note('b', '2026-09-01T11:00:00.000Z'),
      note('c', '2026-09-01T10:00:00.000Z'),
      note('d', '2026-09-01T09:00:00.000Z'),
    ], null);

    applyVersionedNotePage(queryClient, 2, [
      note('a', '2026-09-01T12:00:00.000Z'),
      note('c', '2026-09-01T10:00:00.000Z'),
    ], '2026-09-01T10:00:00.000Z:00000000-0000-4000-8000-00000000000c');

    expect(cachedNotes(queryClient)).toEqual(['a', 'c', 'd']);
  });

  it('replaces outright when the page is the whole list', () => {
    const queryClient = new QueryClient();
    applyVersionedNotePage(queryClient, 1, [
      note('a', '2026-09-01T12:00:00.000Z'),
      note('b', '2026-09-01T11:00:00.000Z'),
    ], null);

    applyVersionedNotePage(queryClient, 2, [note('a', '2026-09-01T12:00:00.000Z')], null);

    expect(cachedNotes(queryClient)).toEqual(['a']);
  });

  it('still refuses a push the ledger has already passed', () => {
    const queryClient = new QueryClient();
    expect(applyVersionedNotePage(queryClient, 5, [note('a', '2026-09-01T12:00:00.000Z')], null))
      .toBe(true);
    expect(applyVersionedNotePage(queryClient, 4, [note('b', '2026-09-01T11:00:00.000Z')], null))
      .toBe(false);
    expect(cachedNotes(queryClient)).toEqual(['a']);
  });
});
