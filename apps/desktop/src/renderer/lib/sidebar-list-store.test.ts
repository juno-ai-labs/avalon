import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyNavigationState,
  applyContainerOrder,
  applyVersionedSpaceSnapshot,
  applyVersionedSidebarList,
} from './sidebar-list-store';
import type { PersonalOrder, SpaceSnapshot } from '@rally/contracts';
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

  it('orders the Canvas list by its own waterline, apart from the Sidekick list', () => {
    const queryClient = new QueryClient();
    const row = (id: string) => ({
      id, title: 'Launch plan', createdByUserId: '00000000-0000-7000-8000-0000000000c1',
      createdAt: '2026-11-07T10:00:00.000Z', updatedAt: '2026-11-07T10:00:00.000Z', lastEditor: null,
      writerSidekickId: null, visibility: 'creator' as const, artifactKind: null, unread: false,
      presentUserIds: [], pinnedPosition: null, sharedWithMe: false,
    });
    expect(applyVersionedSidebarList(queryClient, 'automations', 9, [automation('a')])).toBe(true);
    // A Canvas push at a lower number is newer for its own list.
    expect(applyVersionedSidebarList(queryClient, 'canvases', 2, [row('00000000-0000-7000-8000-0000000000d1')])).toBe(true);
    expect(applyVersionedSidebarList(queryClient, 'canvases', 1, [])).toBe(false);
    expect(queryClient.getQueryData(['canvases'])).toEqual([row('00000000-0000-7000-8000-0000000000d1')]);
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

  // A pin or a Channel read republishes the snapshot without moving the Space
  // waterline; that republication is how a person's other windows hear of it.
  it('takes pins and Channel stats from a snapshot whose Space waterline did not move', () => {
    const queryClient = new QueryClient();
    const spaces = {
      active: { waterline: 4, items: [] },
      inactive: { waterline: 4, items: [] },
    } satisfies SpaceSnapshot;
    applyVersionedSpaceSnapshot(queryClient, spaces, [], true, [], { pins: [], channelStats: [] });

    const pins = [{ kind: 'channel' as const, id: SPACE_ID, parentId: null }];
    const channelStats = [{
      channelId: SPACE_ID,
      threadCount: 2,
      newThreadCount: 0,
      lastActivityAt: '2026-10-10T18:00:00.000Z',
      latestAttentionSequenceNumber: 3,
      readThroughSequenceNumber: 3,
      firstUnreadSequenceNumber: null,
      hasUnread: false,
    }];
    expect(applyVersionedSpaceSnapshot(queryClient, spaces, [], true, [], { pins, channelStats })).toBe(false);

    expect(queryClient.getQueryData(['pins'])).toEqual(pins);
    expect(queryClient.getQueryData(['channel-stats'])).toEqual(channelStats);
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

  it('does not let an older reorder response overwrite a newer snapshot', () => {
    const queryClient = new QueryClient();
    applyVersionedSpaceSnapshot(queryClient, {
      active: { waterline: 4, items: [] }, inactive: { waterline: 4, items: [] },
    }, [{ container: { kind: 'space', id: SPACE_ID }, itemIds: [CHANNEL_ID] }], true);
    const expected = queryClient.getQueryData<PersonalOrder>(['personal-order']);

    applyVersionedSpaceSnapshot(queryClient, {
      active: { waterline: 5, items: [] }, inactive: { waterline: 5, items: [] },
    }, [{ container: { kind: 'space', id: SPACE_ID }, itemIds: [] }], true);
    applyContainerOrder(queryClient, {
      container: { kind: 'space', id: SPACE_ID }, itemIds: [CHANNEL_ID],
    }, expected);

    expect(queryClient.getQueryData(['personal-order'])).toEqual([
      { container: { kind: 'space', id: SPACE_ID }, itemIds: [] },
    ]);
  });
});

describe('applyNavigationState', () => {
  const row = (channelId: string, hasUnread: boolean) => ({
    channelId, threadCount: 1, newThreadCount: hasUnread ? 1 : 0, lastActivityAt: null, latestAttentionSequenceNumber: 1,
    readThroughSequenceNumber: hasUnread ? 0 : 1, firstUnreadSequenceNumber: hasUnread ? 1 : null, hasUnread,
  });

  it('replaces the pin list and only the Channel rows another window read', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['pins'], [{ kind: 'thread', id: CHANNEL_ID, parentId: null }]);
    queryClient.setQueryData(['channel-stats'], [row(SPACE_ID, true), row(CHANNEL_ID, true)]);

    applyNavigationState(queryClient, { pins: [], channelStats: [row(SPACE_ID, false)] });

    expect(queryClient.getQueryData(['pins'])).toEqual([]);
    expect(queryClient.getQueryData(['channel-stats'])).toEqual([row(SPACE_ID, false), row(CHANNEL_ID, true)]);
  });
});
