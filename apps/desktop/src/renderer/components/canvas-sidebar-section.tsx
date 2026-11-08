import type { CanvasSidebarRow } from '@rally/contracts';
import { useMemo, type RefObject } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';

import { canvasRoute, canvasRowDetail, othersPresent, RENAME_CANVAS_STATE, useCanvasList, useCanvasNameSources } from '../lib/canvases';
import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { CanvasMark } from './canvas-mark';
import { ErrorNotice } from './primitives';
import { PinnableRow, PinnedSection, pinnedPosition, SectionHeading, splitPinned, usePinWrite, useRowPinDrop, useSectionMotion } from './navigation-rows';
import { RelativeTime } from './relative-time';
import { SidebarSkeletonRows } from './sidebar-skeleton';

/**
 * The Canvases section: a Pinned group, then every Canvas by recent activity.
 * A row is the Canvas's mark and name, and a second line naming who is in it
 * now beside a green dot, or else who last changed it; an unread row is bold
 * with a red dot. A row dragged into Pinned is pinned (`POST /canvases/:id/pin`);
 * its menu's Rename… opens the Canvas with its title pill being edited.
 */
export function CanvasesSection({ scroll }: { scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const currentUserId = session?.user.id;
  const rows = useCanvasList();
  const { membersById, sidekicksById } = useCanvasNameSources(api);
  const { pinned, rest } = useMemo(() => splitPinned(rows ?? []), [rows]);
  const pinnedIds = useMemo(() => new Set(pinned.map((row) => row.id)), [pinned]);
  const { error: pinError, setPinned } = usePinWrite(api ? (id, next) => api.setCanvasPinned(id, next) : undefined, 'Canvas');
  const { drop, sourceProps, targetProps } = useRowPinDrop(pinnedIds, (id) => setPinned(id, true));
  useSectionMotion(scroll, undefined);
  const navigate = useNavigate();
  const open = matchPath('/canvases/:id', useLocation().pathname)?.params.id;
  const row = (canvas: CanvasSidebarRow, position?: string): React.JSX.Element => {
    const live = othersPresent(canvas, currentUserId).length > 0;
    return <PinnableRow
      active={canvas.id === open}
      className="navigation-canvas-row"
      detail={<>{live && <span aria-label="People are here" className="navigation-row-live-dot" role="img" />}{canvasRowDetail(canvas, membersById, sidekicksById, currentUserId)}</>}
      drag={position === undefined ? sourceProps(canvas.id) : {}}
      key={canvas.id}
      motionKey={`canvas:${canvas.id}`}
      onPin={(next) => { void setPinned(canvas.id, next).catch(() => undefined); }}
      // The title is edited in the Canvas's own pill, so Rename… opens it there.
      onRename={() => { void navigate(canvasRoute(canvas.id), { state: RENAME_CANVAS_STATE }); }}
      pinned={position !== undefined}
      position={position}
      tile={<CanvasMark kind={canvas.artifactKind} />}
      time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={canvas.updatedAt} />}
      title={canvas.title}
      to={canvasRoute(canvas.id)}
      unread={canvas.unread}
    />;
  };
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
