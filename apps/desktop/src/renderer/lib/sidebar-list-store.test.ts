import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyVersionedSidebarList } from './sidebar-list-store';
import { CanvasSidebarRowSchema } from '@rally/contracts';
import type { AutomationSummary } from './types';

function automation(id: string): AutomationSummary {
  return {
    id,
    name: 'Weekly changelog',
    description: 'What shipped this week.',
    scope: 'workspace',
    status: 'active',
    updatedAt: '2026-08-22T18:00:00.000Z',
  };
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

  it('orders the Canvas list by its own waterline, apart from the Sidekick list', () => {
    const queryClient = new QueryClient();
    const row = (id: string) => CanvasSidebarRowSchema.parse({
      id, title: 'Launch plan', createdByUserId: '00000000-0000-7000-8000-0000000000c1',
      createdAt: '2026-11-07T10:00:00.000Z', updatedAt: '2026-11-07T10:00:00.000Z', lastEditor: null,
      writerSidekickId: null, visibility: 'creator', artifactKind: null, unread: false,
      presentUserIds: [], pinnedPosition: null, sharedWithMe: false,
    });
    expect(applyVersionedSidebarList(queryClient, 'automations', 9, [automation('a')])).toBe(true);
    // A Canvas push at a lower number is newer for its own list.
    expect(applyVersionedSidebarList(queryClient, 'canvases', 2, [row('00000000-0000-7000-8000-0000000000d1')])).toBe(true);
    expect(applyVersionedSidebarList(queryClient, 'canvases', 1, [])).toBe(false);
    expect(queryClient.getQueryData(['canvases'])).toEqual([row('00000000-0000-7000-8000-0000000000d1')]);
  });

});

