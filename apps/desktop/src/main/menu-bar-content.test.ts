import { WorkstreamPrivateChildSchema } from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import type { DirectoryChannel } from './channel-directory-watch';
import { menuBarContentFromDirectory } from './menu-bar-content';

function channel(id: string, title: string, extra: Partial<DirectoryChannel> = {}): DirectoryChannel {
  return {
    id,
    title,
    titleStatus: 'settled',
    lastActivityAt: '2026-10-06T10:00:00.000Z',
    archivedAt: null,
    systemKind: null,
    hasUnread: false,
    unseen: false,
    youAreMentioned: false,
    ...extra,
  };
}

const breakout = WorkstreamPrivateChildSchema.parse({
  substreamId: '00000000-0000-7000-8000-0000000000b1',
  title: 'Discount call',
  unreadCount: 2,
  createdByUserId: '00000000-0000-7000-8000-0000000000c1',
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-06T08:00:00.000Z',
});

describe('menu bar content', () => {
  it('lists the sidebar\'s attention rows, most urgent first', () => {
    const content = menuBarContentFromDirectory({
      complete: true,
      channels: [
        channel('a', 'Unread', { hasUnread: true, lastActivityAt: '2026-10-06T12:00:00.000Z' }),
        channel('b', 'New to you', { unseen: true, lastActivityAt: '2026-10-06T09:00:00.000Z' }),
        channel('c', 'Caught up'),
      ],
      breakouts: {},
    });

    expect(content.attention.map((row) => [row.title, row.reason])).toEqual([
      ['New to you', 'unseen'],
      ['Unread', 'unread'],
    ]);
    expect(content.attentionComplete).toBe(true);
  });

  it('reads a Channel\'s Breakouts only when its row counts one, as the sidebar does', () => {
    const counted = menuBarContentFromDirectory({
      complete: true,
      channels: [channel('a', 'Pricing', { breakoutAttentionCount: 1 })],
      breakouts: { a: [breakout] },
    });
    expect(counted.attention).toEqual([{
      key: `a:${breakout.substreamId}`,
      workstreamId: 'a',
      substreamId: breakout.substreamId,
      title: 'Discount call',
      channelTitle: 'Pricing',
      reason: 'unread',
    }]);

    const uncounted = menuBarContentFromDirectory({
      complete: true,
      channels: [channel('a', 'Pricing')],
      breakouts: { a: [breakout] },
    });
    expect(uncounted.attention).toEqual([]);
  });

  it('orders Most recent by last activity, ties A to Z, with no Space filter and no archived or system rows', () => {
    const content = menuBarContentFromDirectory({
      complete: true,
      channels: [
        channel('a', 'Beta', { lastActivityAt: '2026-10-06T10:00:00.000Z' }),
        channel('b', 'Alpha', { lastActivityAt: '2026-10-06T10:00:00.000Z' }),
        channel('c', 'Newest', { lastActivityAt: '2026-10-06T12:00:00.000Z' }),
        channel('d', 'Archived', { archivedAt: '2026-10-06T11:00:00.000Z', lastActivityAt: '2026-10-06T13:00:00.000Z' }),
        channel('e', 'Digest', { systemKind: 'digest', lastActivityAt: '2026-10-06T13:00:00.000Z' }),
      ],
      breakouts: {},
    });

    expect(content.recents).toEqual([
      { id: 'c', title: 'Newest' },
      { id: 'b', title: 'Alpha' },
      { id: 'a', title: 'Beta' },
    ]);
  });

  it('names a Channel Rally is still naming rather than showing its placeholder', () => {
    const content = menuBarContentFromDirectory({
      complete: true,
      channels: [channel('a', 'placeholder', { titleStatus: 'naming', hasUnread: true })],
      breakouts: {},
    });

    expect(content.recents[0]?.title).toBe('Untitled channel');
    expect(content.attention[0]?.title).toBe('Untitled channel');
  });
});
