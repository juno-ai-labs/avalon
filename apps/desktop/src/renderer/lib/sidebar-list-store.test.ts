import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyContainerOrder,
  applyVersionedSpaceSnapshot,
  applyVersionedSidebarList,
} from './sidebar-list-store';
import type { SpaceSnapshot } from '@rally/contracts';
import type { AutomationSummary } from './types';

const SPACE_ID = '00000000-0000-7000-8000-0000000000a1';
const CHANNEL_ID = '00000000-0000-7000-8000-0000000000a2';

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

  it('keeps a late space snapshot from replacing a newer directory', () => {
    const queryClient = new QueryClient();
    const newer = {
      active: { waterline: 8, items: [] },
      inactive: { waterline: 8, items: [] },
    } satisfies SpaceSnapshot;
    const older = {
      active: { waterline: 7, items: [] },
      inactive: { waterline: 7, items: [] },
    } satisfies SpaceSnapshot;

    const arranged = [{ container: { kind: 'space' as const, id: SPACE_ID }, itemIds: [CHANNEL_ID] }];

    expect(applyVersionedSpaceSnapshot(queryClient, newer, arranged, true)).toBe(true);
    expect(applyVersionedSpaceSnapshot(queryClient, older, [], true)).toBe(false);
    expect(queryClient.getQueryData(['spaces'])).toEqual(newer.active);
    expect(queryClient.getQueryData(['spaces-inactive'])).toEqual(newer.inactive);
    // The ordering rides the same waterline: a late payload that lost the
    // arrangement must not take it off the screen either.
    expect(queryClient.getQueryData(['personal-order'])).toEqual(arranged);
  });

  // `spacesReady` has no ledger of its own: a write can be the write that
  // finishes the cutover, so it is only ever as current as the snapshot it
  // arrived with. An older payload must not put the opening state back.
  it('does not let an older snapshot reinstate the organization-opening state', () => {
    const queryClient = new QueryClient();
    const ready = {
      active: { waterline: 8, items: [] },
      inactive: { waterline: 8, items: [] },
    } satisfies SpaceSnapshot;
    const opening = {
      active: { waterline: 7, items: [] },
      inactive: { waterline: 7, items: [] },
    } satisfies SpaceSnapshot;

    applyVersionedSpaceSnapshot(queryClient, ready, [], true);
    expect(applyVersionedSpaceSnapshot(queryClient, opening, [], false)).toBe(false);
    expect(queryClient.getQueryData(['spaces-ready'])).toBe(true);
  });

  // The write's own answer goes in without a waterline, so the arrangement a
  // drag committed is on screen in the frame between the response and the
  // republication that carries it.
  it('applies one container order without moving the ledger the snapshot is judged by', () => {
    const queryClient = new QueryClient();
    const snapshot = {
      active: { waterline: 4, items: [] },
      inactive: { waterline: 4, items: [] },
    } satisfies SpaceSnapshot;
    applyVersionedSpaceSnapshot(queryClient, snapshot, [], true);

    applyContainerOrder(queryClient, {
      container: { kind: 'space', id: SPACE_ID },
      itemIds: [CHANNEL_ID],
    });
    expect(queryClient.getQueryData(['personal-order'])).toEqual([
      { container: { kind: 'space', id: SPACE_ID }, itemIds: [CHANNEL_ID] },
    ]);

    // One entry per container: a second write for the same one replaces it
    // rather than leaving two answers to the same question.
    applyContainerOrder(queryClient, { container: { kind: 'space', id: SPACE_ID }, itemIds: [] });
    expect(queryClient.getQueryData(['personal-order'])).toEqual([
      { container: { kind: 'space', id: SPACE_ID }, itemIds: [] },
    ]);

    // And the ledger is untouched, so the republication that follows still
    // applies over it.
    expect(applyVersionedSpaceSnapshot(queryClient, {
      active: { waterline: 5, items: [] },
      inactive: { waterline: 5, items: [] },
    }, [], true)).toBe(true);
  });
});
