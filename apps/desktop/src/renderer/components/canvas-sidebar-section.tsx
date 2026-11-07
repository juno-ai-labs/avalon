import * as ContextMenu from '@radix-ui/react-context-menu';
import type { CanvasSidebarRow } from '@rally/contracts';
import { IconPin, IconPinnedOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';

import { canvasRoute, canvasRowDetail, othersPresent, useCanvasList } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import type { AutomationSummary } from '../lib/types';
import { useListMotionPass } from '../lib/use-list-motion';
import { useWorkspaceMembers } from '../lib/workspace-members';
import { CanvasMark } from './canvas-mark';
import { ErrorNotice } from './primitives';
import { PinnedSection, pinnedPosition, RowLayout, SectionHeading, useRowPinDrop } from './navigation-rows';
import { RelativeTime } from './relative-time';
import { SidebarSkeletonRows } from './sidebar-skeleton';

/** Pinned first in the order the viewer pinned them; then the list's own order, most recently active first. */
export function splitPinned<T extends { pinnedPosition?: number | null | undefined }>(rows: readonly T[]): { pinned: T[]; rest: T[] } {
  const pinned = rows.filter((row) => row.pinnedPosition != null)
    .sort((left, right) => (left.pinnedPosition ?? 0) - (right.pinnedPosition ?? 0));
  return { pinned, rest: rows.filter((row) => row.pinnedPosition == null) };
}

/** How many Canvases hold something this viewer has not read: the section's badge. */
export function useUnreadCanvasCount(): number {
  return (useCanvasList() ?? []).filter((row) => row.unread).length;
}

/**
 * The Canvases section: a Pinned group, then every Canvas by recent activity.
 * A row is the Canvas's mark and name, and a second line naming who is in it
 * now beside a green dot, or else who last changed it; an unread row is bold
 * with a red dot. A row dragged into Pinned is pinned (`POST /canvases/:id/pin`).
 */
export function CanvasesSection({ scroll }: { scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const currentUserId = session?.user.id;
  const rows = useCanvasList();
  const members = useWorkspaceMembers(api).data;
  const sidekicks = useSocketOwnedList<AutomationSummary>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
  const membersById = useMemo(() => new Map((members ?? []).map((member) => [member.id, member])), [members]);
  const sidekicksById = useMemo(() => new Map((sidekicks ?? []).map((sidekick) => [sidekick.id, sidekick])), [sidekicks]);
  const { pinned, rest } = useMemo(() => splitPinned(rows ?? []), [rows]);
  const pinnedIds = useMemo(() => new Set(pinned.map((row) => row.id)), [pinned]);
  const [pinError, setPinError] = useState<Error | null>(null);
  const setPinned = useCallback(async (id: string, next: boolean): Promise<void> => {
    if (!api) throw new Error('Rally is not connected yet.');
    setPinError(null);
    try {
      await api.setCanvasPinned(id, next);
    } catch (cause) {
      setPinError(cause instanceof Error ? cause : new Error('The Canvas could not be pinned.'));
      throw cause;
    }
  }, [api]);
  const { drop, sourceProps, targetProps } = useRowPinDrop(pinnedIds, (id) => setPinned(id, true));
  const motion = useListMotionPass(scroll);
  useLayoutEffect(() => motion());
  const open = matchPath('/canvases/:id', useLocation().pathname)?.params.id;
  const row = (canvas: CanvasSidebarRow, position?: string): React.JSX.Element => <CanvasRow
    active={canvas.id === open}
    detail={canvasRowDetail(canvas, membersById, sidekicksById, currentUserId)}
    drag={position === undefined ? sourceProps(canvas.id) : {}}
    key={canvas.id}
    live={othersPresent(canvas, currentUserId).length > 0}
    onPin={(next) => { void setPinned(canvas.id, next).catch(() => undefined); }}
    pinned={position !== undefined}
    position={position}
    row={canvas}
  />;
  return <>
    {pinError && <ErrorNotice occurrence={pinError}>The Canvas could not be pinned. Try again.</ErrorNotice>}
    <PinnedSection
      count={pinned.length}
      drop={drop}
      label="Pinned Canvases"
      loading={rows === undefined}
      noun="Canvas"
      reorderable={false}
      target={targetProps}
    >
      {pinned.map((canvas, index) => row(canvas, pinnedPosition(index, pinned.length)))}
    </PinnedSection>
    <section aria-label="All Canvases" className="navigation-section">
      <SectionHeading motionKey="canvases">All Canvases</SectionHeading>
      {rows === undefined && <SidebarSkeletonRows count={6} hint />}
      {rows !== undefined && rest.length === 0 && pinned.length === 0 && <p className="navigation-empty">No Canvases yet.</p>}
      {rest.map((canvas) => row(canvas))}
    </section>
  </>;
}

function CanvasRow({ active, detail, drag, live, onPin, pinned, position, row }: {
  active: boolean;
  detail: string;
  drag: React.HTMLAttributes<HTMLElement>;
  live: boolean;
  onPin: (pinned: boolean) => void;
  pinned: boolean;
  position: string | undefined;
  row: CanvasSidebarRow;
}): React.JSX.Element {
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <Link
        aria-current={active ? 'page' : undefined}
        className={clsx('navigation-row navigation-canvas-row', active && 'is-active', row.unread && 'is-unread')}
        data-motion-key={`canvas:${row.id}`}
        to={canvasRoute(row.id)}
        {...drag}
      >
        <RowLayout
          detail={<>{live && <span aria-label="People are here" className="navigation-row-live-dot" role="img" />}{detail}</>}
          tile={<CanvasMark kind={row.artifactKind} />}
          time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={row.updatedAt} />}
          title={row.title}
          unread={row.unread}
        />
        {position && <span className="sr-only">{position}</span>}
      </Link>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <ContextMenu.Item className="menu-item" onSelect={() => onPin(!pinned)}>
          {pinned ? <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} /> : <IconPin aria-hidden="true" size={15} stroke={1.8} />}
          {pinned ? 'Unpin' : 'Pin'}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
