import type { ActivityItem } from '@rally/contracts';
import { IconAt, IconCircleCheck, IconMessageQuestion, IconUserPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';

import { canvasRoute, useCanvasNameSources } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { SIDEBAR_LIST_QUERY_KEYS, type ActivityList } from '../lib/sidebar-list-store';
import { useQuery } from '@tanstack/react-query';
import { SectionHeading, useSectionMotion } from './navigation-rows';
import { RelativeTime } from './relative-time';
import { SidebarSkeletonRows } from './sidebar-skeleton';

/**
 * This viewer's Activity as the workspace socket keeps it; `undefined` until
 * it has said. Read like `useSocketOwnedList`, but the entry is a page with
 * its count rather than a bare list.
 */
export function useActivityList(): ActivityList | undefined {
  return useQuery<ActivityList>({
    queryKey: SIDEBAR_LIST_QUERY_KEYS.activity,
    queryFn: () => {
      throw new Error('activity is pushed by the organization socket, never fetched');
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

export const ACTIVITY_EMPTY = 'Nothing yet. Mentions, Canvases you are added to and Sidekick runs that need you or finish show up here.';

/** What happened, in the row's words; a run's own row names the Sidekick and needs no "in". */
const VERBS: Record<ActivityItem['kind'], string> = {
  mention: 'mentioned you in',
  participant_added: 'added you to',
  needs_input: 'needs your input',
  run_finished: 'finished a run',
};

const GLYPHS: Record<ActivityItem['kind'], ReactNode> = {
  mention: <IconAt aria-hidden="true" size={18} stroke={1.8} />,
  participant_added: <IconUserPlus aria-hidden="true" size={18} stroke={1.8} />,
  needs_input: <IconMessageQuestion aria-hidden="true" size={18} stroke={1.8} />,
  run_finished: <IconCircleCheck aria-hidden="true" size={18} stroke={1.8} />,
};

/**
 * Where a row opens: the Canvas, or the Sidekick's conversation, where a run's
 * row is and an answer to it goes. A mention in one of a Sidekick's runs
 * opens that run.
 */
export function activityRoute(item: ActivityItem): string {
  if (item.parentKind === 'canvas') return canvasRoute(item.parentId);
  const sidekick = `/sidekicks/${encodeURIComponent(item.parentId)}`;
  return item.kind === 'mention' && item.substreamId !== null && item.substreamId !== '0'
    ? `${sidekick}?run=${encodeURIComponent(item.substreamId)}`
    : sidekick;
}

/**
 * The Activity section: what happened to this person in Canvases and
 * Sidekicks, newest first. A row is the kind's glyph, who did what where, the
 * preview and when; an unseen row is bright with a red dot. Opening a row's
 * conversation is what clears it (its read cursor), and Mark all seen in the
 * header clears the rest. `docs/activity.md` owns the model.
 */
export function ActivitySection({ scroll }: { scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const { api } = useCollaborationSession();
  const activity = useActivityList();
  const { membersById, sidekicksById } = useCanvasNameSources(api);
  useSectionMotion(scroll, undefined);
  const who = (item: ActivityItem): string => {
    if (item.actor.kind === 'rally') return 'Rally';
    if (item.actor.kind === 'sidekick') {
      return item.parentTitle ?? (item.actor.id ? sidekicksById.get(item.actor.id)?.name : undefined) ?? 'A Sidekick';
    }
    return (item.actor.id ? membersById.get(item.actor.id)?.name : undefined) || 'Someone';
  };
  const where = (item: ActivityItem): string => item.parentTitle
    ?? (item.parentKind === 'canvas' ? 'a Canvas' : 'a Sidekick');
  return <section aria-label="Activity" className="navigation-section">
    <SectionHeading motionKey="activity">Recent</SectionHeading>
    {activity === undefined && <SidebarSkeletonRows count={5} hint />}
    {activity !== undefined && activity.items.length === 0 && <p className="navigation-empty">{ACTIVITY_EMPTY}</p>}
    {activity?.items.map((item) => {
      const run = item.kind === 'needs_input' || item.kind === 'run_finished';
      return <Link
        className={clsx('activity-row', item.seen ? 'is-seen' : 'is-unseen')}
        data-motion-key={`activity:${item.id}`}
        key={item.id}
        to={activityRoute(item)}
      >
        <span className={clsx('activity-row-glyph', `is-${item.kind}`)}>{GLYPHS[item.kind]}</span>
        <span className="activity-row-body">
          <span className="activity-row-text">
            <strong>{who(item)}</strong> {VERBS[item.kind]}{!run && <> <strong>{where(item)}</strong></>}
          </span>
          {item.preview && <span className="activity-row-detail activity-row-preview">{item.preview}</span>}
          <RelativeTime className="activity-row-detail" format={formatSidebarActivityTime} value={item.createdAt} />
        </span>
        {!item.seen && <span aria-label="Unseen" className="activity-unseen-dot" role="img" />}
      </Link>;
    })}
  </section>;
}
