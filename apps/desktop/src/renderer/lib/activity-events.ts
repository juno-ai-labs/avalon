import type { ActivityEvent, ActivityItem, ActivityPage, ActivitySubject } from '@rally/contracts';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { RallyApi } from './api';
import { ACTIVITY_QUERY_KEY } from './sidebar-list-store';

/** The subject a conversation's events are about: the thread itself, or one of its breakouts. */
export function conversationActivitySubject(threadId: string, substreamId: string): ActivitySubject {
  return substreamId === '0'
    ? { kind: 'thread', threadId: threadId as Extract<ActivitySubject, { kind: 'thread' }>['threadId'] }
    : { kind: 'breakout', threadId: threadId as Extract<ActivitySubject, { kind: 'breakout' }>['threadId'], substreamId };
}

/** Whether a held Activity row is one a read of this subject could clear. */
function aboutSubject(item: ActivityItem, subject: ActivitySubject): boolean {
  switch (subject.kind) {
    case 'thread': return item.threadId === subject.threadId && item.breakout === null;
    case 'breakout': return item.breakout?.substreamId === subject.substreamId;
    case 'channel': return item.channelIds.includes(subject.channelId);
  }
}

/**
 * Tell the server what the person did, so every Activity row it covers is done
 * (`docs/digests.md#the-activity-tab`). Activity is read again only when a row
 * it holds is unread and about this subject, so opening and reading cost one
 * small write and nothing more. Fire and forget: a lost event leaves a dot
 * standing until the next read of that subject or Mark all read, which is a
 * failure the person sees.
 */
export function reportActivityEvent(api: RallyApi, queryClient: QueryClient, event: ActivityEvent): void {
  void api.recordActivityEvents([event])
    .then(() => {
      const held = queryClient.getQueriesData<InfiniteData<ActivityPage>>({ queryKey: ACTIVITY_QUERY_KEY });
      const affected = held.some(([, data]) => data?.pages.some((page) => page.items
        .some((item) => item.unread && aboutSubject(item, event.subject))));
      if (affected) return queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
      return undefined;
    })
    .catch(() => undefined);
}
