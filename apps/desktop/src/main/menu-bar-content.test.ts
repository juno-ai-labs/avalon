import { WorkstreamPrivateChildSchema, type ActivityItem } from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import type { ActivityFeedSnapshot } from './activity-feed-watch';
import type { ChannelDirectorySnapshot, DirectoryChannel } from './channel-directory-watch';
import { menuBarContent } from './menu-bar-content';

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

const THREAD = '00000000-0000-7000-8000-0000000000a1' as ActivityItem['threadId'];

function activityItem(id: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    kind: 'run_finished',
    occurredAt: '2026-10-06T10:00:00.000Z',
    actorUserId: null,
    actorLabel: 'Rally',
    threadId: THREAD,
    threadTitle: 'GTM review',
    breakout: null,
    channelIds: [],
    unread: true,
    ...extra,
  };
}

const quietDirectory: ChannelDirectorySnapshot = { complete: true, accessRequests: [], channels: [], breakouts: {} };
const activity = (items: ActivityItem[]): ActivityFeedSnapshot => ({ items, complete: true });
const noActivity = activity([]);

const breakout = WorkstreamPrivateChildSchema.parse({
  substreamId: '00000000-0000-7000-8000-0000000000b1',
  title: 'Discount call',
  unreadCount: 2,
  createdByUserId: '00000000-0000-7000-8000-0000000000c1',
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-06T08:00:00.000Z',
});

describe('menu bar content', () => {
  it('lists the Activity tab\'s unread rows in its order, and none it has marked read', () => {
    const content = menuBarContent(quietDirectory, activity([
      activityItem('finished', { occurredAt: '2026-10-06T12:00:00.000Z' }),
      activityItem('mentioned', { kind: 'mentioned', actorUserId: THREAD, actorLabel: 'Katherine Baird', threadTitle: 'Merge mockups' }),
      activityItem('older', { unread: false, threadTitle: 'Read already' }),
    ]));

    expect(content.attention).toEqual([
      { key: 'finished', workstreamId: THREAD, substreamId: null, title: 'GTM review', detail: 'Rally finished' },
      { key: 'mentioned', workstreamId: THREAD, substreamId: null, title: 'Merge mockups', detail: 'Katherine Baird mentioned you' },
    ]);
    expect(content.attentionComplete).toBe(true);
  });

  it('opens a Breakout\'s row on the Breakout, under its title, naming the thread it sits in', () => {
    const content = menuBarContent(quietDirectory, activity([activityItem('b', {
      kind: 'breakout_started', actorUserId: THREAD, actorLabel: '', threadTitle: 'Pricing',
      breakout: { substreamId: breakout.substreamId, title: 'Discount call' },
    })]));

    expect(content.attention).toEqual([{
      key: 'b', workstreamId: THREAD, substreamId: breakout.substreamId, title: 'Discount call', detail: 'New breakout in Pricing',
    }]);
  });

  it('is not whole until Activity has been read once', () => {
    expect(menuBarContent(quietDirectory, { items: [], complete: false }).attentionComplete).toBe(false);
  });

  it('orders Most recent by last activity, ties A to Z, with no Space filter and no archived or system rows', () => {
    const content = menuBarContent({
      complete: true, accessRequests: [],
      channels: [
        channel('a', 'Beta', { lastActivityAt: '2026-10-06T10:00:00.000Z' }),
        channel('b', 'Alpha', { lastActivityAt: '2026-10-06T10:00:00.000Z' }),
        channel('c', 'Newest', { lastActivityAt: '2026-10-06T12:00:00.000Z' }),
        channel('d', 'Archived', { archivedAt: '2026-10-06T11:00:00.000Z', lastActivityAt: '2026-10-06T13:00:00.000Z' }),
        channel('e', 'Digest', { systemKind: 'digest', lastActivityAt: '2026-10-06T13:00:00.000Z' }),
      ],
      breakouts: {},
    }, noActivity);

    expect(content.recents).toEqual([
      { id: 'c', title: 'Newest', substreamId: null },
      { id: 'b', title: 'Alpha', substreamId: null },
      { id: 'a', title: 'Beta', substreamId: null },
    ]);
  });

  it('names a Channel Rally is still naming rather than showing its placeholder', () => {
    const content = menuBarContent({
      complete: true, accessRequests: [],
      channels: [channel('a', 'placeholder', { titleStatus: 'naming' })],
      breakouts: {},
    }, activity([activityItem('a', { threadTitle: '' })]));

    expect(content.recents[0]?.title).toBe('Untitled thread');
    expect(content.attention[0]?.title).toBe('Untitled thread');
  });

  it('opens the Breakout for a Channel listed only through one, and leaves it out until its list arrives', () => {
    const withheld = channel('a', 'Pricing', { mainWithheld: true });
    expect(menuBarContent({ complete: true, accessRequests: [], channels: [withheld], breakouts: { a: [breakout] } }, noActivity).recents)
      .toEqual([{ id: 'a', title: 'Pricing', substreamId: breakout.substreamId }]);
    // Main is not this reader's, so a row with no Breakout to open would lead nowhere.
    expect(menuBarContent({ complete: true, accessRequests: [], channels: [withheld], breakouts: {} }, noActivity).recents).toEqual([]);
  });
});
