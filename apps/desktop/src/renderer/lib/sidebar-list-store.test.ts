import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyVersionedProjectSnapshot,
  applyVersionedSidebarList,
} from './sidebar-list-store';
import type { ProjectSnapshot } from '@rally/contracts';
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
