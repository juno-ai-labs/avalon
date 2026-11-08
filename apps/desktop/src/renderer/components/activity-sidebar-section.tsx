import type { ActivityItem } from '@rally/contracts';
import { IconAt, IconCircleCheck, IconFilePencil, IconLock, IconLockOpen, IconMessage, IconMessageQuestion, IconUserPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { Fragment, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { canvasRoute, canvasTurnRoute, useCanvasNameSources } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList, type ActivityList } from '../lib/sidebar-list-store';
import { AccessDecisionActions } from './canvas-access-request';
import { RowLayout, SectionHeading, useSectionMotion } from './navigation-rows';
import { RelativeTime } from './relative-time';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import { sidekickRunSearch } from './sidekick-run-row';

/** This viewer's Activity as the workspace socket keeps it; `undefined` until it has said. */
export function useActivityList(): ActivityList | undefined {
  return useSocketOwnedList<ActivityList>(SIDEBAR_LIST_QUERY_KEYS.activity).data;
}

export const ACTIVITY_EMPTY = 'Nothing yet. Mentions, replies, Canvases you are added to and Sidekick runs that need you or finish show up here.';

/**
 * Who did what where, in the row's words. A run's own row names the Sidekick
 * and needs no "in"; a reply is only who and where, its message the preview.
 */
function rowText(item: ActivityItem, who: string, where: string): ReactNode {
  const actor = <strong>{who}</strong>;
  const place = <strong>{where}</strong>;
  switch (item.kind) {
    case 'mention': return <>{actor} mentioned you in {place}</>;
    case 'participant_added': return <>{actor} added you to {place}</>;
    case 'needs_input': return <>{actor} needs your input</>;
    case 'run_finished': return <>{actor} finished a run</>;
    case 'new_message': return <>{actor} in {place}</>;
    case 'artifact_updated': return <>{actor} updated <strong>{item.artifact?.title || 'an artifact'}</strong> in {place}</>;
    case 'access_request': return <>{actor} asked to open {place}</>;
    case 'access_granted': return <>{actor} let you into {place}</>;
  }
}

const GLYPHS: Record<ActivityItem['kind'], ReactNode> = {
  mention: <IconAt aria-hidden="true" size={18} stroke={1.8} />,
  participant_added: <IconUserPlus aria-hidden="true" size={18} stroke={1.8} />,
  needs_input: <IconMessageQuestion aria-hidden="true" size={18} stroke={1.8} />,
  run_finished: <IconCircleCheck aria-hidden="true" size={18} stroke={1.8} />,
  new_message: <IconMessage aria-hidden="true" size={18} stroke={1.8} />,
  artifact_updated: <IconFilePencil aria-hidden="true" size={18} stroke={1.8} />,
  access_request: <IconLock aria-hidden="true" size={18} stroke={1.8} />,
  access_granted: <IconLockOpen aria-hidden="true" size={18} stroke={1.8} />,
};

/**
 * The second line: the preview, except on a settled access request, which
 * says who decided ("Maya approved", "Maya denied") in place of the message.
 */
function rowDetail(item: ActivityItem): string {
  const request = item.kind === 'access_request' ? item.accessRequest : null;
  if (request && request.state !== 'pending') return `${request.decidedByName || 'Someone'} ${request.state}`;
  return item.preview ?? '';
}

/**
 * Where a row opens: a Canvas Chat mention or reply at its message, a pinned
 * Canvas's new version at the Canvas with that artifact open (`?artifact=`),
 * any other Canvas row at the Canvas (an access request's Share panel lists
 * it too), and a Sidekick row at its conversation, where a run's row is. A
 * run that needs input, and a mention or reply in one of a Sidekick's runs,
 * open that run, where its question is. A mention recorded before it carried
 * its message's sequence opens the Canvas.
 */
export function activityRoute(item: ActivityItem): string {
  const message = item.kind === 'mention' || item.kind === 'new_message';
  if (item.parentKind === 'canvas') {
    if (message && item.substreamId === '0' && item.messageId !== null && item.messageSequence !== null) {
      return canvasTurnRoute(item.parentId, item.messageId, item.messageSequence);
    }
    if (item.kind === 'artifact_updated' && item.artifact) {
      return `${canvasRoute(item.parentId)}?artifact=${encodeURIComponent(item.artifact.resourceId)}`;
    }
    return canvasRoute(item.parentId);
  }
  const sidekick = `/sidekicks/${encodeURIComponent(item.parentId)}`;
  if (item.kind === 'needs_input' && item.runId !== null) return `${sidekick}${sidekickRunSearch(item.runId)}`;
  return message && item.substreamId !== null && item.substreamId !== '0'
    ? `${sidekick}${sidekickRunSearch(item.substreamId)}`
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
  // The highlight follows the route, Back and Forward included, never the row
  // last clicked: a row is open when the route has its conversation open, the
  // run included, so opening one run marks that run's row and not every row
  // about its Sidekick. A finished run's row opens the shared conversation,
  // because reading `"0"` is what clears it and the run's own view reads the
  // run instead; every finished row of one Sidekick shares that address, so
  // none is drawn open rather than all of them at once.
  const location = useLocation();
  const openRun = new URLSearchParams(location.search).get('run');
  const isOpen = (item: ActivityItem): boolean => {
    if (item.kind === 'run_finished') return false;
    const [pathname, search = ''] = activityRoute(item).split('?');
    return pathname === location.pathname && new URLSearchParams(search).get('run') === openRun;
  };
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
      const active = isOpen(item);
      // Approve and Deny sit under a pending request's row, beside the link
      // rather than in it: a link holds no buttons.
      const deciding = item.kind === 'access_request' && item.accessRequest?.state === 'pending' && item.actor.id !== null;
      return <Fragment key={item.id}>
        <Link
          aria-current={active ? 'page' : undefined}
          className={clsx('navigation-row activity-row', item.seen ? 'is-seen' : 'is-unread', active && 'is-active')}
          data-motion-key={`activity:${item.id}`}
          to={activityRoute(item)}
        >
          <RowLayout
            detail={rowDetail(item)}
            tile={<span className={clsx('activity-row-glyph', `is-${item.kind}`)}>{GLYPHS[item.kind]}</span>}
            time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={item.createdAt} />}
            title={<span className="activity-row-text">{rowText(item, who(item), where(item))}</span>}
            unread={!item.seen}
            unreadLabel="Unseen"
          />
        </Link>
        {deciding && <div className="activity-row-actions">
          <AccessDecisionActions canvasId={item.parentId} label={who(item)} userId={item.actor.id!} />
        </div>}
      </Fragment>;
    })}
  </section>;
}
