import { describe, expect, it } from 'vitest';
import { groupActivityItems, type ActivityItem } from './navigation';

const threadId = '00000000-0000-7000-8000-000000000001' as ActivityItem['threadId'];
function item(id: string, kind: ActivityItem['kind'], time: number, extra: Partial<ActivityItem> = {}): ActivityItem {
  return { id, kind, occurredAt: new Date(time).toISOString(), actorUserId: null, actorLabel: 'Alex',
    threadId, threadTitle: 'Cold email', breakout: null, channelIds: [], unread: true, ...extra };
}

describe('groupActivityItems', () => {
  it('flattens overlapping pages, keeps the human preview and unread mention, and sorts by latest activity', () => {
    const reply = item('message:a', 'new_message', 1000, { preview: 'Need advil?', unreadMessageCount: 3 });
    const groups = groupActivityItems([
      item('finished', 'run_finished', 4000), reply,
      item('other', 'new_message', 3000, { threadId: 'other' as ActivityItem['threadId'] }),
      reply, item('mention', 'mentioned', 500),
    ]);
    expect(groups.map(({ threadTitle, preview, unreadMessages, unreadMention, rallyFinished, occurredAt }) =>
      ({ threadTitle, preview, unreadMessages, unreadMention, rallyFinished, occurredAt }))).toEqual([
      { threadTitle: 'Cold email', preview: 'Need advil?', unreadMessages: 3, unreadMention: true,
        rallyFinished: true, occurredAt: '1970-01-01T00:00:04.000Z' },
      { threadTitle: 'Cold email', preview: undefined, unreadMessages: 1, unreadMention: false,
        rallyFinished: false, occurredAt: '1970-01-01T00:00:03.000Z' },
    ]);
  });

  it('uses the latest server reply count when refetched pages overlap older reply summaries', () => {
    const [group] = groupActivityItems([
      item('message:new', 'new_message', 2000, { unreadMessageCount: 3 }),
      item('message:old', 'new_message', 1000, { unreadMessageCount: 2 }),
    ]);
    expect(group?.unreadMessages).toBe(3);
  });

  it('clears a stale reply count when Mark all read optimistically clears unread', () => {
    const [group] = groupActivityItems([item('message:a', 'new_message', 1, { unread: false, unreadMessageCount: 3 })]);
    expect(group?.unreadMessages).toBe(0);
  });

  it('preserves unread state when a newer event has already been read', () => {
    const [group] = groupActivityItems([item('old', 'mentioned', 1000), item('new', 'run_finished', 2000, { unread: false })]);
    expect(group).toMatchObject({ unread: true, unreadMention: true, kind: 'mentioned' });
  });

  it('keeps private breakouts and artifact destinations independently actionable', () => {
    const groups = groupActivityItems([
      item('main', 'new_message', 1),
      item('breakout', 'new_message', 2, { breakout: { substreamId: 'private', title: 'Private' } }),
      item('artifact', 'artifact_updated', 3, { artifact: { resourceId: 'doc', title: 'Draft', version: 1 } }),
    ]);
    expect(groups.map((group) => group.groupKey)).toEqual([
      'artifact:doc', `conversation:${threadId}:private`, `conversation:${threadId}:0`,
    ]);
  });
});
