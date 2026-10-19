import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { attentionItemPath, attentionItems, useAttentionItems, type BreakoutLists } from './attention-items';
import { workstreamChildrenQueryKey } from './channel-viewer-state';
import type { WorkstreamSummary } from './types';

function channel(id: string, title: string, overrides: Partial<WorkstreamSummary> = {}): WorkstreamSummary {
  return {
    id,
    title,
    titleStatus: 'settled',
    scope: 'workspace',
    harnessStatus: 'completed',
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
    spaceIds: ['space-1'],
    lastActivityAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function breakout(substreamId: string, title: string, overrides: Record<string, unknown> = {}): NonNullable<BreakoutLists[string]>[number] {
  return {
    substreamId,
    title,
    createdByUserId: 'user-2',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as NonNullable<BreakoutLists[string]>[number];
}

function summarize(items: ReturnType<typeof attentionItems>): string[] {
  return items.map((item) => `${item.reason}:${item.title}${item.channelTitle ? ` in ${item.channelTitle}` : ''}`);
}

describe('attentionItems', () => {
  it('lists unseen, then mentioned, then unread, newest first within each', () => {
    const items = attentionItems([
      channel('a', 'Older unread', { hasUnread: true, lastActivityAt: '2026-10-01T08:00:00.000Z' }),
      channel('b', 'Newer unread', { hasUnread: true, lastActivityAt: '2026-10-01T09:00:00.000Z' }),
      channel('c', 'Mention', { hasUnread: true, youAreMentioned: true }),
      channel('d', 'Added', { unseen: true, youAreMentioned: true, lastActivityAt: '2026-01-01T00:00:00.000Z' }),
    ], {});

    expect(summarize(items)).toEqual([
      'unseen:Added',
      'mentioned:Mention',
      'unread:Newer unread',
      'unread:Older unread',
    ]);
  });

  it('leaves out a Channel whose only state is a running agent', () => {
    expect(attentionItems([channel('a', 'Working', { harnessStatus: 'running' })], {})).toEqual([]);
  });

  it('lists Breakouts that need the reader under their Channel, and skips the caught-up ones', () => {
    const items = attentionItems([channel('a', 'Launch plan')], {
      a: [
        breakout('11', 'Pricing', { unreadCount: 3, lastActivityAt: '2026-10-02T00:00:00.000Z' }),
        breakout('12', 'Legal', { youAreMentioned: true }),
        breakout('13', 'Read already', { unreadCount: 0 }),
        breakout('14', 'New room', { unseen: true }),
      ],
    });

    expect(summarize(items)).toEqual([
      'unseen:New room in Launch plan',
      'mentioned:Legal in Launch plan',
      'unread:Pricing in Launch plan',
    ]);
    expect(items[2]).toMatchObject({ workstreamId: 'a', substreamId: '11', at: '2026-10-02T00:00:00.000Z' });
  });

  it('leaves out Main when it is not the reader’s, but keeps their Breakouts', () => {
    const items = attentionItems([
      channel('a', 'Withheld', { hasUnread: true, mainWithheld: true }),
      channel('b', 'Entered through a Breakout', { hasUnread: true, associativeSubstreamId: '21' }),
    ], { a: [breakout('11', 'Shared with me', { unreadCount: 1 })] });

    expect(summarize(items)).toEqual(['unread:Shared with me in Withheld']);
  });

  it('leaves out Main of a thread the reader does not take part in, but keeps their Breakouts', () => {
    const items = attentionItems([
      channel('a', 'Somebody else’s thread', { hasUnread: true, isParticipant: false }),
      channel('b', 'Mine', { hasUnread: true, isParticipant: true }),
    ], { a: [breakout('11', 'Pulled into', { unreadCount: 1 })] });

    expect(summarize(items)).toEqual(['unread:Mine', 'unread:Pulled into in Somebody else’s thread']);
  });

  it('leaves out archived, system and pending rows', () => {
    expect(attentionItems([
      channel('a', 'Archived', { hasUnread: true, archivedAt: '2026-10-01T00:00:00.000Z' }),
      channel('b', 'Digest', { hasUnread: true, systemKind: 'digest' }),
      channel('c', 'Creating', { unseen: true, pending: true }),
    ], {})).toEqual([]);
  });
});

describe('attentionItemPath', () => {
  it('opens Main at the Channel and a Breakout through its substream', () => {
    expect(attentionItemPath({ workstreamId: 'a b', substreamId: null })).toBe('/workstreams/a%20b');
    expect(attentionItemPath({ workstreamId: 'a', substreamId: '11' })).toBe('/workstreams/a?substream=11');
  });
});

describe('useAttentionItems', () => {
  it('says the Breakout lists are not loaded until every Channel waiting on one has it', () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    const rows = [channel('c1', 'Plans', { breakoutAttentionCount: 1 }), channel('c2', 'Ops')];
    const { result, rerender } = renderHook(() => useAttentionItems(rows), { wrapper });
    expect(result.current.breakoutListsLoaded).toBe(false);

    queryClient.setQueryData(workstreamChildrenQueryKey('c1'), {
      privateChildren: [breakout('b1', 'Launch', { unreadCount: 2 })],
    });
    rerender();
    expect(result.current.breakoutListsLoaded).toBe(true);
    expect(result.current.items.map((item) => item.key)).toEqual(['c1:b1']);
  });
});
