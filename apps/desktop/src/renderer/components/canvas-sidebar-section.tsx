import type { CanvasSidebarRow } from '@rally/contracts';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { IconLink, IconUsers } from '@tabler/icons-react';
import { ArrowDownUp } from 'lucide-react';
import { useMemo, useRef, useState, type RefObject } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';

import { canvasNaming, canvasRoute, RENAME_CANVAS_STATE, SHARE_CANVAS_STATE } from '../lib/canvases';
import { copyLink } from '../lib/copy-link';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { useOtherOrganizationCanvases, type OtherOrganizationCanvas } from '../lib/shared-canvases';
import { useCanvasPinDrag } from './canvas-pin-drag';
import { CanvasMark } from './canvas-mark';
import { CanvasSharingStatus } from './canvas-sharing-status';
import { OtherOrganizationCanvasRow } from './other-organization-canvas';
import { DropdownSelect, ErrorNotice, TitleSkeleton } from './primitives';
import { PinnableRow, PinnedSection, pinnedPosition, SectionHeading, usePinWrite, useSectionMotion } from './navigation-rows';
import { SidebarListDown, usePushedListsDown } from './pushed-list-pending';
import { RelativeTime } from './relative-time';
import { SidebarSkeletonRows } from './sidebar-skeleton';

type CanvasOrder = 'recent' | 'name';

/** design.html §1's "Recent ⇵": the list by recent activity (the server's order) or by name. */
const CANVAS_ORDERS = [{ value: 'recent', label: 'Recent' }, { value: 'name', label: 'Name' }];

/**
 * The Canvases section: a Pinned group, then every Canvas by recent activity.
 * A row is the Canvas's mark and name, and a second line showing its sharing
 * setting with the Share panel's icon; an unread row is bold
 * with a red dot. A row dragged into Pinned is pinned (`POST /canvases/:id/pin`);
 * its menu's Rename… opens the Canvas with its title pill being edited.
 * Canvases shared with this person in their other Organizations sit among the
 * rest, by the same order, with that Organization's mark on their tile.
 */
export function CanvasesSection({ scroll }: { scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const currentUserId = session?.user.id;
  const { rows, pinned, rest, over, dragging, sourceProps, targetProps } = useCanvasPinDrag();
  // A socket that cannot open would leave the placeholders up for ever.
  const down = usePushedListsDown() && rows === undefined;
  const { error: pinError, setPinned } = usePinWrite(api ? (id, next) => api.setCanvasPinned(id, next) : undefined, 'Canvas');
  useSectionMotion(scroll, undefined);
  const [order, setOrder] = useState<CanvasOrder>('recent');
  const elsewhere = useOtherOrganizationCanvases();
  // This Organization's rows keep the server's order; another's go in by date or name.
  const sorted = useMemo<Array<CanvasSidebarRow | OtherOrganizationCanvas>>(() => {
    const merged: Array<CanvasSidebarRow | OtherOrganizationCanvas> = [...rest, ...elsewhere];
    const rowOf = (item: CanvasSidebarRow | OtherOrganizationCanvas): CanvasSidebarRow => 'organization' in item ? item.row : item;
    if (order === 'name') return merged.sort((a, b) => rowOf(a).title.localeCompare(rowOf(b).title));
    return elsewhere.length === 0 ? rest : merged.sort((a, b) => rowOf(b).updatedAt.localeCompare(rowOf(a).updatedAt));
  }, [elsewhere, order, rest]);
  const navigate = useNavigate();
  const workspace = session?.workspace;
  const [linkError, setLinkError] = useState<Error | null>(null);
  const inserted = useInsertedRows(rows);
  const open = matchPath('/canvases/:id', useLocation().pathname)?.params.id;
  const row = (canvas: CanvasSidebarRow, position?: string): React.JSX.Element => {
    return <PinnableRow
      active={canvas.id === open}
      className={`navigation-canvas-row${over === canvas.id ? ' navigation-pin-drop-before' : ''}`}
      detail={<CanvasSharingStatus canvas={canvas} currentUserId={currentUserId} />}
      drag={{ ...sourceProps(canvas.id), ...(position !== undefined ? targetProps(canvas.id) : {}) }}
      key={canvas.id}
      motionKey={`canvas:${canvas.id}`}
      onPin={(next) => { void setPinned(canvas.id, next).catch(() => undefined); }}
      // The title is edited in the Canvas's own pill, so Rename… opens it there.
      onRename={() => { void navigate(canvasRoute(canvas.id), { replace: canvas.id === open, state: RENAME_CANVAS_STATE }); }}
      // The pill's menu, less what only an open Canvas can do: Share… opens
      // it on its panel, and Copy link copies the same link the pill does.
      insert={inserted.has(canvas.id)}
      menu={<>
        <ContextMenu.Item className="menu-item" onSelect={() => { void navigate(canvasRoute(canvas.id), { replace: canvas.id === open, state: SHARE_CANVAS_STATE }); }}>
          <IconUsers aria-hidden="true" size={15} stroke={1.8} />Share…
        </ContextMenu.Item>
        {workspace && <ContextMenu.Item className="menu-item" onSelect={() => {
          setLinkError(null);
          copyLink({ kind: 'canvas', region: workspace.region, workspaceId: workspace.id, canvasId: canvas.id })
            .catch((cause: unknown) => setLinkError(cause instanceof Error ? cause : new Error('The link could not be copied.')));
        }}>
          <IconLink aria-hidden="true" size={15} stroke={1.8} />Copy link
        </ContextMenu.Item>}
      </>}
      pinned={position !== undefined}
      position={position}
      tile={<CanvasMark appearance={canvas.appearance} id={canvas.id} />}
      time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={canvas.updatedAt} />}
      title={canvasNaming(canvas) ? <TitleSkeleton /> : canvas.title}
      to={canvasRoute(canvas.id)}
      unread={canvas.unread}
    />;
  };
  return <>
    {pinError && <ErrorNotice occurrence={pinError}>The Canvas could not be pinned. Try again.</ErrorNotice>}
    {linkError && <ErrorNotice occurrence={linkError}>The link couldn’t be copied.</ErrorNotice>}
    <PinnedSection
      count={pinned.length}
      drop={dragging ? { index: null } : null}
      label="Pinned Canvases"
      loading={rows === undefined && !down}
      noun="Canvas"
      reorderable={pinned.length > 1}
      target={{ ...targetProps(), className: `navigation-section${over === 'end' ? ' navigation-pin-drop-end' : ''}` }}
    >
      {pinned.map((canvas, index) => row(canvas, pinnedPosition(index, pinned.length)))}
    </PinnedSection>
    <section aria-label="All canvases" className="navigation-section">
      <SectionHeading
        motionKey="canvases"
        trailing={<DropdownSelect ariaLabel="Sort Canvases" icon={<ArrowDownUp aria-hidden="true" size={12} strokeWidth={1.8} />} onValueChange={(value) => setOrder(value === 'name' ? 'name' : 'recent')} options={CANVAS_ORDERS} value={order} variant="secondary" />}
      >All canvases</SectionHeading>
      {rows === undefined && (down ? <SidebarListDown noun="Canvases" /> : <SidebarSkeletonRows count={6} hint />)}
      {rows !== undefined && rest.length === 0 && pinned.length === 0 && elsewhere.length === 0 && <p className="navigation-empty">No Canvases yet.</p>}
      {sorted.map((item) => 'organization' in item
        ? <OtherOrganizationCanvasRow currentUserId={currentUserId} item={item} key={`${item.organization.region}:${item.organization.id}:${item.row.id}`} />
        : row(item))}
    </section>
  </>;
}

/**
 * The ids of rows that arrived after the list first did: a Canvas just made,
 * here or by someone else, whose appearance is itself the change and so
 * slides in (list-motion.md) rather than overprinting the row it displaces.
 * The first list, and a row the device cache seeded, play nothing.
 */
function useInsertedRows(rows: readonly CanvasSidebarRow[] | undefined): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const inserted = useRef<Set<string>>(new Set());
  if (rows) {
    if (known.current === null) known.current = new Set(rows.map((row) => row.id));
    else {
      for (const row of rows) {
        if (!known.current.has(row.id)) { known.current.add(row.id); inserted.current.add(row.id); }
      }
    }
  }
  return inserted.current;
}
