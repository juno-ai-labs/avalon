import type { ActivityEvent, ActivitySubject } from '@rally/contracts';
import type { QueryClient } from '@tanstack/react-query';

import type { RallyApi } from './api';
import { ACTIVITY_QUERY_KEY } from './sidebar-list-store';

/** The subject a conversation's events are about: the thread itself, or one of its breakouts. */
export function conversationActivitySubject(threadId: string, substreamId: string): ActivitySubject {
  return substreamId === '0'
    ? { kind: 'thread', threadId: threadId as Extract<ActivitySubject, { kind: 'thread' }>['threadId'] }
    : { kind: 'breakout', threadId: threadId as Extract<ActivitySubject, { kind: 'breakout' }>['threadId'], substreamId };
}

/**
 * Tell the server what the person did, so every Activity row it covers is done
 * (`docs/digests.md#the-activity-tab`), then read Activity again if it is on
 * screen. Fire and forget: a lost event leaves a dot standing until the next
 * read of that subject or Mark all read, which is a failure the person sees.
 */
export function reportActivityEvent(api: RallyApi, queryClient: QueryClient, event: ActivityEvent): void {
  void api.recordActivityEvents([event])
    .then(() => queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY }))
    .catch(() => undefined);
}
