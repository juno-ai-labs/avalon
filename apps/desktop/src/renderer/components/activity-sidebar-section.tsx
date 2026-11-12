import type { ActivityItem } from '@rally/contracts';
import { IconAt, IconBolt, IconBoltOff, IconCircleCheck, IconFilePencil, IconLock, IconLockOpen, IconMessage, IconMessageQuestion, IconUserPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { Fragment, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { CornerBadge } from '@rally/ui/components/identity-tile';

import { canvasArtifactRoute, canvasRoute, canvasTurnRoute, useCanvasList, useCanvasNameSources } from '../lib/canvases';
import { canvasMark } from './canvas-mark';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList, type ActivityList } from '../lib/sidebar-list-store';
import { sidekickRunSearch } from '../lib/sidekick-status';
import { sourceWords } from '../lib/sidekick-sources';
import { AccessDecisionActions } from './canvas-access-request';
import { RowLayout, SectionHeading, useSectionMotion } from './navigation-rows';
import { RelativeTime } from './relative-time';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import { SourceRequestActions } from './sidekick-sources';

/** This viewer's Activity as the workspace socket keeps it; `undefined` until it has said. */
export function useActivityList(): ActivityList | undefined {
  return useSocketOwnedList<ActivityList>(SIDEBAR_LIST_QUERY_KEYS.activity).data;
}

/** A run of the row's sentence: plain words, or a name drawn bold. */
type RowPart = string | { strong: string };

/**
 * Who did what where, in the row's words. A run's own row names the Sidekick
 * and needs no "in"; a reply is only who and where, its message the preview.
 * The same parts draw the row and spell its tooltip, so the full sentence is
 * recoverable when the row's two lines cut it.
 */
function rowParts(item: ActivityItem, who: string, where: string): RowPart[] {
  const actor = { strong: who };
  const place = { strong: where };
  switch (item.kind) {
    case 'mention': return [actor, ' mentioned you in ', place];
    case 'participant_added': return [actor, ' added you to ', place];
    case 'needs_input': return [actor, ' needs your input'];
    case 'run_finished': return [actor, ' finished a run'];
    case 'new_message': return [actor, ' in ', place];
    case 'artifact_updated': return [actor, ' updated ', { strong: item.artifact?.title || 'an artifact' }, ' in ', place];
    case 'access_request': return [actor, ' asked to open ', place];
    case 'access_granted': return [actor, ' let you into ', place];
    // Never the title: the requester was refused the Canvas.
    case 'access_denied': return [actor, ' declined your request to open a Canvas'];
    // A source is one person's events from one of their accounts, so the row
    // says whose account: the reader's own when they are asked, the asked
    // person's when the requester is told how they answered. The Sidekick
    // comes last, as every row's place does, so the two-line cut spares it.
    case 'source_request': return [actor, ` asked for your ${sourceAccount(item)} to start `, place];
    case 'source_approved': return [actor, ` approved their ${sourceAccount(item)} for `, place];
    case 'source_declined': return [actor, ` declined their ${sourceAccount(item)} for `, place];
  }
}

/** The connector a source row is about, in the words the card and the panel use ("Gmail"). */
function sourceAccount(item: ActivityItem): string {
  return item.sourceRequest ? sourceWords(item.sourceRequest).connector : 'account';
}

function rowText(parts: RowPart[]): ReactNode {
  return parts.map((part, index) => typeof part === 'string' ? part : <strong key={index}>{part.strong}</strong>);
}

function rowSentence(parts: RowPart[]): string {
  return parts.map((part) => typeof part === 'string' ? part : part.strong).join('');
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
  access_denied: <IconLock aria-hidden="true" size={18} stroke={1.8} />,
  source_request: <IconBolt aria-hidden="true" size={18} stroke={1.8} />,
  source_approved: <IconBolt aria-hidden="true" size={18} stroke={1.8} />,
  source_declined: <IconBoltOff aria-hidden="true" size={18} stroke={1.8} />,
};

/**
 * Who settled an access request, where its Approve and Deny were: "You
 * approved" to the decider themselves, "Maya denied" to everyone else.
 */
function settledText(request: NonNullable<ActivityItem['accessRequest']>, viewerId: string | undefined): string {
  const decider = request.decidedByUserId && request.decidedByUserId === viewerId ? 'You' : request.decidedByName || 'Someone';
  return `${decider} ${request.state}`;
}

/**
 * How the asked person's own source request ended, where its Approve and
 * Decline were. Only they could answer it, so an answer is always theirs.
 */
function sourceSettledText(state: NonNullable<ActivityItem['sourceRequest']>['state']): string {
  if (state === 'approved') return 'You approved';
  if (state === 'declined') return 'You declined';
  return 'Replaced by a newer request';
}

/**
 * Where a row opens: a Canvas Chat mention or reply at its message, a pinned
 * Canvas's new version at the Canvas with that artifact open (`?artifact=`),
 * any other Canvas row at the Canvas (an access request's Share panel lists
 * it too; a declined request's requester lands on its requestable pane), and a Sidekick row at its conversation, where a run's row is. A
 * run that needs input, and a mention or reply in one of a Sidekick's runs,
 * open that run, where its question is. A mention recorded before it carried
 * its message's sequence opens the Canvas.
 *
 * A source request (`source_request`) is about a Sidekick the person asked
 * may not be able to open until they approve: approving is what makes them a
 * reader. `sidekickListed` says whether their Sidekick list holds it. While
 * it does not, the row opens the Activity home rather than a Sidekick that
 * would refuse them, and its own Approve and Decline are all there is to do.
 * The requester's `source_approved` and `source_declined` rows open the
 * Sidekick, whose Sources section shows the answer, under the same guard: a
 * source row lists for as long as its Sidekick exists, whoever reads it now.
 */
export function activityRoute(item: ActivityItem, sidekickListed = true): string {
  if (item.sourceRequest && !sidekickListed) return '/activity';
  const message = item.kind === 'mention' || item.kind === 'new_message';
  if (item.parentKind === 'canvas') {
    if (message && item.substreamId === '0' && item.messageId !== null && item.messageSequence !== null) {
      return canvasTurnRoute(item.parentId, item.messageId, item.messageSequence);
    }
    if (item.kind === 'artifact_updated' && item.artifact) {
      return canvasArtifactRoute(item.parentId, item.artifact.resourceId);
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
  const { api, session } = useCollaborationSession();
  const activity = useActivityList();
  const { membersById, sidekicksById } = useCanvasNameSources(api);
  const canvases = useCanvasList();
  useSectionMotion(scroll, undefined);
  // A Canvas row's glyph carries the Canvas it is about, in the icon and
  // colour chosen for it (else its default), read from this person's list; a
  // Canvas missing from it (one they cannot open now) wears its default.
  const tile = (item: ActivityItem): ReactNode => {
    const glyph = <span className={clsx('activity-row-glyph', `is-${item.kind}`)}>{GLYPHS[item.kind]}</span>;
    if (item.parentKind !== 'canvas') return glyph;
    const canvas = canvases?.find((row) => row.id === item.parentId);
    const { icon, ink, tint } = canvasMark(item.parentId, canvas?.appearance);
    return <span className="identity-tile activity-row-tile">
      {glyph}
      <CornerBadge badge={{ key: 'canvas', shape: 'sheet', fill: tint, ink, icon }} />
    </span>;
  };
  // The highlight follows the route, Back and Forward included, never the row
  // last clicked: a row is open when the route has its conversation open, the
  // run included, so opening one run marks that run's row and not every row
  // about its Sidekick. A finished run's row opens the shared conversation,
  // because reading `"0"` is what clears it and the run's own view reads the
  // run instead; every finished row of one Sidekick shares that address, so
  // none is drawn open rather than all of them at once.
  const location = useLocation();
  const routeOf = (item: ActivityItem): string => activityRoute(item, item.parentKind !== 'automation' || sidekicksById.has(item.parentId));
  const openRun = new URLSearchParams(location.search).get('run');
  const isOpen = (item: ActivityItem): boolean => {
    if (item.kind === 'run_finished') return false;
    const [pathname, search = ''] = routeOf(item).split('?');
    // A source request with no Sidekick to open leads to the Activity home,
    // which is no row's own page.
    if (pathname === '/activity') return false;
    return pathname === location.pathname && new URLSearchParams(search).get('run') === openRun;
  };
  const who = (item: ActivityItem): string => {
    if (item.kind === 'access_denied' && item.accessRequest?.decidedByName) return item.accessRequest.decidedByName;
    if (item.actor.kind === 'rally') return 'Rally';
    // A source row names a person either way: who asked, or who answered.
    // The request keeps both names, for a person the directory cannot name.
    if (item.kind === 'source_request' || item.kind === 'source_approved' || item.kind === 'source_declined') {
      return (item.actor.id ? membersById.get(item.actor.id)?.name : undefined)
        || (item.kind === 'source_request' ? item.sourceRequest?.requestedByName : item.sourceRequest?.personName)
        || 'Someone';
    }
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
    {activity?.items.length === 0 && <p className="navigation-empty">Nothing yet</p>}
    {activity?.items.map((item) => {
      const active = isOpen(item);
      const parts = rowParts(item, who(item), where(item));
      const request = item.kind === 'access_request' && item.actor.id !== null ? item.accessRequest : null;
      const sourceRequest = item.kind === 'source_request' ? item.sourceRequest : null;
      const grouped = Boolean(request || sourceRequest);
      const row = <Link
        aria-current={active ? 'page' : undefined}
        className={clsx('navigation-row activity-row', item.seen ? 'is-seen' : 'is-unread', active && 'is-active')}
        data-motion-key={grouped ? undefined : `activity:${item.id}`}
        title={rowSentence(parts)}
        to={routeOf(item)}
      >
        <RowLayout
          detail={item.preview ?? ''}
          tile={tile(item)}
          time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={item.createdAt} />}
          title={<span className="activity-row-text">{rowText(parts)}</span>}
          unread={!item.seen}
          unreadLabel="Unseen"
        />
      </Link>;
      if (!grouped) return <Fragment key={item.id}>{row}</Fragment>;
      // A request's Approve and Deny sit under its link rather than in it (a
      // link holds no buttons), inside one group that owns the row's fill. On
      // settling, who decided takes the buttons' place on a line as tall as
      // they were, so the list does not move under the pointer. A source
      // request is the same group with its own pair: only the person asked
      // has the row, so the buttons are always theirs to press.
      return <div
        className={clsx('activity-row-group', item.seen ? 'is-seen' : 'is-unread', active && 'is-active')}
        data-motion-key={`activity:${item.id}`}
        key={item.id}
      >
        {row}
        <div className="activity-row-actions">
          {sourceRequest
            ? sourceRequest.state === 'pending'
              ? <>
                {/* The preview is one line and cuts the condition; nobody approves a filter they cannot read. */}
                {sourceRequest.condition && <p className="activity-row-condition">Only when “{sourceRequest.condition}”</p>}
                <SourceRequestActions
                  request={{ sidekickId: item.parentId, requestId: sourceRequest.requestId, connectorType: sourceRequest.connectorType, eventTypes: sourceRequest.eventTypes }}
                  sidekickName={item.parentTitle ?? undefined}
                />
              </>
              : <p className="activity-row-settled">{sourceSettledText(sourceRequest.state)}</p>
            : request!.state === 'pending'
              ? <AccessDecisionActions canvasId={item.parentId} canvasTitle={item.parentTitle ?? undefined} label={membersById.get(item.actor.id!)?.name || undefined} userId={item.actor.id!} />
              : <p className="activity-row-settled">{settledText(request!, session?.user.id)}</p>}
        </div>
      </div>;
    })}
  </section>;
}
