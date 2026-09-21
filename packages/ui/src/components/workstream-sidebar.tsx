import * as ContextMenu from '@radix-ui/react-context-menu';
import { SidekickSection, type SidekickRow, type SidekickSectionFailure } from './sidekick-section';
import { Archive, Copy, GitBranch, Globe2, GripVertical, PanelLeftClose, PanelLeftOpen, Pencil, UserPlus } from 'lucide-react';
import { IconCornerDownRight, IconShare2 } from '@tabler/icons-react';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { SidebarPresentation } from '../lib/types';
import { COLLAPSED_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_EXPAND_DRAG_THRESHOLD } from '../lib/sidebar-geometry';
import { AvatarStack, DragHint, IconButton, Tip, TitleSkeleton } from './primitives';
export const PENDING_SUBSTREAM_DRAFT_ID = 'new';
import { ResourceIcon } from './resource-icon';
import { WorkstreamMark } from './workstream-glyph';

const COLLAPSED_KEY = 'rally.workstream-sidebar-collapsed';
const WIDTH_KEY = 'rally.workstream-sidebar-width';
const clampWidth = (width: number): number => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));

export interface ConversationRowTarget { substreamId: string; title: string }

/**
 * Arranging the Breakouts under a Channel by hand, for whoever is reading.
 *
 * The rail draws the order it is given and reports the gesture; the order
 * itself is the host's, because it is stored per person on the Organization
 * and the same helper arranges the Spaces and the Channels in the sidebar. One
 * object for the list rather than one per row, since every row's handler is
 * the same function of its own id.
 *
 * Absent for a reader who cannot have one — a guest, whose order the
 * Organization refuses to store — and then the rows are not draggable at all,
 * rather than offering a gesture whose write would be turned down.
 */
export interface SubstreamListDrag {
  /** The Breakout under the pointer's own row, which is drawn as lifted. */
  draggingSubstreamId: string | null;
  onDragStart: (substreamId: string) => void;
  /** The Breakout whose slot the pointer is over. */
  onDragOver: (substreamId: string) => void;
  /** `cancelled` is a drag backed out of rather than dropped on the list. */
  onDragEnd: (cancelled: boolean) => void;
  /** Keyboard equivalent of a drag: one step toward the top or the bottom. */
  onMove: (substreamId: string, direction: -1 | 1) => void;
}

/** The one element carrying the keyboard-reorder instruction for the rail. */
const SUBSTREAM_DRAG_HINT_ID = 'breakout-drag-hint';
export interface ConversationRowActions {
  onMakePublic?: (() => void) | undefined;
  publicDisabled?: boolean | undefined;
  onCopyLink?: ((target: ConversationRowTarget) => void) | undefined;
  onRename?: (target: ConversationRowTarget) => void;
  onShare?: (target: ConversationRowTarget) => void;
  onArchive?: (target: ConversationRowTarget) => void;
}

function ConversationRowMenu({ actions, children, target }: {
  actions: ConversationRowActions | undefined; children: React.ReactNode; target: ConversationRowTarget;
}): React.JSX.Element {
  if (!actions) return <>{children}</>;
  const main = target.substreamId === '0';
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
        {actions.onMakePublic && <ContextMenu.Item className="menu-item" disabled={actions.publicDisabled} onSelect={actions.onMakePublic}>
          <Globe2 aria-hidden="true" size={16} /> Make public to organization
        </ContextMenu.Item>}
        {actions.onRename && <ContextMenu.Item className="menu-item" onSelect={() => actions.onRename?.(target)}>
          <Pencil aria-hidden="true" size={16} /> Rename
        </ContextMenu.Item>}
        {actions.onShare && <ContextMenu.Item className="menu-item" onSelect={() => actions.onShare?.(target)}>
          <IconShare2 aria-hidden="true" size={16} stroke={1.8} /> Share
        </ContextMenu.Item>}
        {actions.onCopyLink && <ContextMenu.Item className="menu-item" onSelect={() => actions.onCopyLink?.(target)}>
          <Copy aria-hidden="true" size={16} /> {main ? 'Copy channel link' : 'Copy breakout link'}
        </ContextMenu.Item>}
        {actions.onArchive && <><ContextMenu.Separator className="menu-separator" />
        <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => actions.onArchive?.(target)}>
          <Archive aria-hidden="true" size={16} /> {main ? 'Archive channel' : 'Archive breakout'}
        </ContextMenu.Item></>}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

/** Work-stream navigation only: no second resource query or substream model. */
export function WorkstreamSidebar({ mainVisible = true, onOpenSidekick, onSidekickMenuOpen, onOpenResource, workstream, creatingSubstream = null, presentUserIds, selectedSubstreamId = '0', onSelectSubstream, onNewSubstream, onOpenArtifact, onParticipants, onFocusTranscript, sidekicks, sidekickFailure, addSidekick, substreamActions, substreamDrag, mainActions }: {
  workstream: SidebarPresentation;
  onOpenResource?: (id: string, returnFocus: HTMLElement) => void;
  mainVisible?: boolean; onOpenSidekick?: (id: string) => void; onSidekickMenuOpen?: () => void;
  /**
   * A substream is being created in this work stream: the composer has been
   * submitted and creation is in flight. The rail draws the row it is about to
   * have, so the conversation on screen is one the rail shows — the same
   * promise every other conversation in it keeps.
   *
   * `reservedSubstreamId` is the child preparation reserved, once it has
   * answered with one, and it is how the placeholder gets out of the way: the
   * child is published to this rail from inside the confirmation, so the
   * directory can carry its real row while creation is still in flight, and a
   * placeholder that only watched `launching` would stand beside it. Null until
   * preparation answers, when nothing can be listed yet.
   */
  creatingSubstream?: { reservedSubstreamId: string | null } | null;
  presentUserIds: readonly string[];
  /**
   * This work stream's Sidekicks — the ones it owns and the ones its
   * conversation has loaded — or `undefined` while that answer is still on its
   * way. The section says nothing at all for either, the way the artifact
   * section above it does.
   */
  sidekicks?: SidekickRow[] | undefined;
  sidekickFailure?: SidekickSectionFailure | undefined;
  addSidekick?: React.ReactNode;
  selectedSubstreamId?: string;
  onSelectSubstream?: (substreamId: string) => void;
  onNewSubstream?: () => void;
  onOpenArtifact: (id: string, returnFocus: HTMLElement) => void;
  onParticipants: () => void;
  onFocusTranscript: () => void;
  substreamActions?: ConversationRowActions | undefined;
  /** Reordering the Breakouts by hand; see {@link SubstreamListDrag}. */
  substreamDrag?: SubstreamListDrag | undefined;
  mainActions?: ConversationRowActions | undefined;
}): React.JSX.Element {
  const sidebar = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number.parseFloat(localStorage.getItem(WIDTH_KEY) ?? '');
      return Number.isFinite(stored) ? clampWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
    } catch { return DEFAULT_SIDEBAR_WIDTH; }
  });
  const [paneWidth, setPaneWidth] = useState(Number.POSITIVE_INFINITY);
  const [resizing, setResizing] = useState(false);
  // The keyboard's drag: held arrow keys write the width repeatedly, and
  // animating each step would leave the edge trailing the width the collapse
  // threshold is judged against. Separate from `resizing` so it raises the
  // class without entering the pointer drag's state.
  const [keyResizing, setKeyResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  // Observe the available pane, never this sidebar or the transcript. Its
  // width does not change when this rail collapses, avoiding resize feedback.
  useLayoutEffect(() => {
    const pane = sidebar.current?.parentElement;
    if (!pane) return;
    const update = (): void => setPaneWidth(pane.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  const narrow = paneWidth < width + SIDEBAR_CONTENT_MIN_WIDTH;
  const compact = collapsed || narrow;
  const effectiveWidth = compact ? COLLAPSED_SIDEBAR_WIDTH : width;
  useLayoutEffect(() => {
    const shell = sidebar.current?.closest<HTMLElement>('.workspace-shell');
    shell?.style.setProperty('--workstream-sidebar-width', `${effectiveWidth}px`);
    return () => { shell?.style.removeProperty('--workstream-sidebar-width'); };
  }, [effectiveWidth]);
  const saveCollapsed = (next: boolean): void => {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* Best-effort device preference. */ }
  };
  const resize = (requested: number): void => {
    const available = paneWidth - SIDEBAR_CONTENT_MIN_WIDTH;
    if (compact && (requested < SIDEBAR_EXPAND_DRAG_THRESHOLD || available < MIN_SIDEBAR_WIDTH)) return;
    if (!compact && requested < SIDEBAR_COLLAPSE_DRAG_THRESHOLD) {
      saveCollapsed(true);
      return;
    }
    if (available < MIN_SIDEBAR_WIDTH) return;
    const next = clampWidth(Math.min(requested, available));
    setWidth(next);
    saveCollapsed(false);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* Best-effort device preference. */ }
  };
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');
  /**
   * The substream being created, once it has a row of its own here.
   *
   * A child is published to this rail from inside its confirmation, so the
   * directory can carry its real row while creation is still in flight — and
   * one conversation with two rows is the thing this list must never show. The
   * reserved id is what tells the two apart; without it there is nothing listed
   * to collide with.
   */
  const reserved = creatingSubstream?.reservedSubstreamId ?? null;
  const publishedReserved = reserved !== null
    && (workstream.privateChildren?.some((child) => child.substreamId === reserved) ?? false)
    ? reserved
    : null;
  /** A row is owed to a substream that has none yet. */
  const pendingSubstream = creatingSubstream !== null && publishedReserved === null;
  /**
   * The row the reader is on, which during a creation is the substream being
   * created — the launch surface is already showing that conversation's opening
   * turn, and the route follows a tick later, when the response lands.
   */
  const currentSubstreamId = publishedReserved ?? selectedSubstreamId;
  return (
    <aside aria-label="Channel sidebar" className={clsx('workstream-context-sidebar', compact && 'is-compact', (resizing || keyResizing) && 'is-resizing')} ref={sidebar} style={{ flexBasis: effectiveWidth }}>
      <div className="workstream-context-toolbar window-drag">
        <h2 title={workstream.title}>{workstream.title}</h2>
        <span aria-hidden="true" className="workstream-context-toolbar-mark">
          <WorkstreamMark appearance={workstream.appearance} id={workstream.id} />
        </span>
      </div>
      <div className="workstream-context-scroll">
        {mainVisible && <ConversationRowMenu actions={mainActions}
          target={{ substreamId: '0', title: workstream.title }}>
          <button
            className={clsx('workstream-context-row workstream-conversation-row', currentSubstreamId === '0' && 'is-current')}
            aria-current={currentSubstreamId === '0' ? 'page' : undefined}
            aria-label={`Go to conversation: ${workstream.title}`}
            title={workstream.title}
            type="button"
            onClick={() => { saveCollapsed(true); onSelectSubstream?.('0'); onFocusTranscript(); }}
          >
            <span className="workstream-context-mark"><WorkstreamMark appearance={workstream.appearance} id={workstream.id} /></span>
            <span className="workstream-context-copy"><span>{workstream.title}</span></span>
          </button>
        </ConversationRowMenu>}
        <div
          aria-describedby={substreamDrag ? SUBSTREAM_DRAG_HINT_ID : undefined}
          className="workstream-substream-list"
          // The whole list is the drop target, so a release in the gap between
          // two rows counts as a drop: `dragend` reads a release nothing
          // accepted as a cancellation, and the arrangement would be thrown
          // away rather than saved.
          onDragOver={substreamDrag ? (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          } : undefined}
          onDrop={substreamDrag ? (event) => event.preventDefault() : undefined}
        >
          {/* Said once for the list rather than on every row: as a per-row
              description it lands inside each button's accessible name, so
              somebody arrowing through hears the instruction again before
              every title. */}
          {substreamDrag && <p className="sr-only" id={SUBSTREAM_DRAG_HINT_ID}>
            Hold Alt and press the up or down arrow to move a breakout.
          </p>}
          {workstream.privateChildren?.map((child, index) => {
            // In the row's `aria-label` rather than in an `sr-only` span
            // beside its title, which is how the sidebar's own rows carry it.
            // The difference is forced: compact hides the title with
            // `visibility: hidden`, so this row's accessible name cannot come
            // from its contents, and a label set that way wins over anything
            // inside it. Both say the position as part of the name; only the
            // markup differs.
            const position = `${index + 1} of ${workstream.privateChildren?.length ?? 0}`;
            const row = (
              <button
                aria-current={currentSubstreamId === child.substreamId ? 'page' : undefined}
                aria-label={[`Go to breakout: ${child.title}`, substreamDrag ? position : undefined]
                  .filter(Boolean).join(', ')}
                className={clsx(
                  'workstream-context-row workstream-conversation-row',
                  currentSubstreamId === child.substreamId && 'is-current',
                  substreamDrag && 'is-draggable',
                  substreamDrag?.draggingSubstreamId === child.substreamId && 'is-dragging',
                )}
                draggable={substreamDrag !== undefined}
                onClick={() => { saveCollapsed(true); onSelectSubstream?.(child.substreamId); }}
                onDragStart={substreamDrag ? (event) => {
                  // Chromium refuses to start a drag with an empty payload,
                  // and the id is what any other surface would want anyway.
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', child.substreamId);
                  substreamDrag.onDragStart(child.substreamId);
                } : undefined}
                onDragOver={substreamDrag ? (event) => {
                  // `preventDefault` is what makes this a drop target at all,
                  // and the effect is what a release here reports back to
                  // `dragend`; without it a finished drag is indistinguishable
                  // from an abandoned one. The reorder happens here rather
                  // than on `drop` so the list settles under the pointer as it
                  // moves instead of jumping once at the end. The row the
                  // event reached is the slot: nothing animates these rows, so
                  // the row drawn under the pointer is the row laid out there.
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  substreamDrag.onDragOver(child.substreamId);
                } : undefined}
                onDragEnd={substreamDrag
                  // A drag nothing accepted reports `none`. Treated as
                  // cancelled when the browser gives no `dataTransfer` at all,
                  // because a drop this list handled always leaves one behind.
                  ? (event) => substreamDrag.onDragEnd((event.dataTransfer?.dropEffect ?? 'none') === 'none')
                  : undefined}
                onKeyDown={substreamDrag ? (event) => {
                  // Alt rather than a bare arrow: the arrows move focus
                  // through the rail, and a Breakout must stay reachable by
                  // somebody who is reading rather than rearranging.
                  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                  event.preventDefault();
                  substreamDrag.onMove(child.substreamId, event.key === 'ArrowUp' ? -1 : 1);
                } : undefined}
                title={child.title}
                type="button"
              >
                <span aria-hidden="true" className="workstream-context-mark">
                  <WorkstreamMark appearance={child.appearance} id={child.substreamId} size={20} />
                </span>
                <span className="workstream-context-copy"><span>{child.title}</span></span>
              </button>
            );
            return substreamActions
              ? <ConversationRowMenu actions={substreamActions} key={child.substreamId} target={{ substreamId: child.substreamId, title: child.title }}>{row}</ConversationRowMenu>
              : <Fragment key={child.substreamId}>{row}</Fragment>;
          })}
          {pendingSubstream && (
            /* The substream being created, in the place the directory will
               put it: last, because children are listed oldest first. It is
               not a button — there is nowhere to go, the reader is already on
               the surface this row stands for — and it carries the skeleton
               rather than the first line of the message, because the title is
               the server's to derive and a second answer to what a first line
               is would disagree the moment either changed. It carries the
               same `title` its siblings do, because compact leaves nothing but
               a mark and hovering it is how a reader asks what a row is. */
            <div
              aria-current={currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID ? 'page' : undefined}
              className={clsx(
                'workstream-context-row workstream-conversation-row workstream-pending-substream',
                currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID && 'is-current',
              )}
              title="Rally is creating this breakout"
            >
              <span aria-hidden="true" className="workstream-context-mark">
                <GitBranch className="workstream-breakout-icon" size={20} strokeWidth={1.7} />
              </span>
              {/* The row's name, and outside the copy below on purpose: compact
                  hides that element with `visibility: hidden`, which takes
                  everything inside it out of the accessibility tree as well as
                  off the screen. Every other row survives that because its name
                  is an `aria-label` on the button; this one has no button to
                  carry one, so the text sits on the row itself. */}
              <span className="sr-only">Rally is creating this breakout</span>
              {/* Decorative from here: a pulsing bar standing in for a title
                  nothing has chosen yet, with the skeleton's own label
                  suppressed so the row is not announced twice. */}
              <span aria-hidden="true" className="workstream-context-copy">
                <TitleSkeleton />
              </span>
            </div>
          )}
          {onNewSubstream && (
            // Current while a substream is being written, because that surface
            // is where the reader is: the row it was opened from is the one
            // thing on screen that still says so. Once it has been submitted
            // the row above says it instead — this one is back to being what
            // starts the next substream.
            <button
              aria-current={currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID && !pendingSubstream ? 'page' : undefined}
              aria-label="New breakout"
              className={clsx(
                'workstream-context-row workstream-new-substream',
                currentSubstreamId === PENDING_SUBSTREAM_DRAFT_ID && !pendingSubstream && 'is-current',
              )}
              onClick={() => { saveCollapsed(true); onNewSubstream(); }}
              title="New breakout"
              type="button"
            >
              <span aria-hidden="true" className="workstream-context-mark"><IconCornerDownRight className="workstream-new-breakout-icon" size={21} stroke={1.7} /></span>
              <span className="workstream-context-copy"><span>New breakout</span></span>
            </button>
          )}
        </div>
        {/* Absent rather than empty, as the Sidekick strip below is: a heading
            over a placeholder row spends the rail's height saying a work
            stream has produced nothing yet, which is the ordinary state of a
            conversation that has only just started. */}
        <ResourceSection label="Artifacts" resources={artifacts} onOpen={onOpenArtifact} />
        {onOpenResource && <ResourceSection label="Resources" resources={workstream.resources.filter((item) => item.direction !== 'artifact')} onOpen={onOpenResource} />}
        <section aria-label="Channel participants" className="workstream-context-section">
          <h2>Participants</h2>
          <button className="workstream-context-row" aria-label="Manage channel participants" aria-description={workstream.participants.map((person) => person.name).join(', ')} type="button" onClick={onParticipants}>
            {workstream.participants.length ? <AvatarStack members={workstream.participants} limit={compact ? 2 : 4} presentUserIds={presentUserIds} /> : <UserPlus aria-hidden="true" size={18} />}
          </button>
        </section>
        {/* Below the people, because a Sidekick is the other kind of thing
            working in this room. */}
        <SidekickSection items={sidekicks} failure={sidekickFailure} onOpen={onOpenSidekick} onMenuOpen={onSidekickMenuOpen} />
        {addSidekick}
      </div>
      <div className="sidebar-collapse-footer">
        <IconButton
          className="window-no-drag"
          label={compact ? 'Expand channel sidebar' : 'Collapse channel sidebar'}
          aria-expanded={!compact}
          disabled={narrow}
          title={narrow ? 'Widen the window to expand the channel sidebar' : undefined}
          onClick={() => {
            saveCollapsed(!collapsed);
          }}
        >{compact ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</IconButton>
      </div>
      {resizing && dragWidth !== null && <div aria-hidden="true" className="sidebar-drag-guide" style={{ left: dragWidth }} />}
      {/* Named only while the double-click would do something: a pane too
          narrow for this rail's contents holds it compact, and the toggle
          above is disabled for the same reason. */}
      <DragHint
        action="Drag to resize"
        suppressed={resizing}
        shortcut={narrow ? undefined : compact ? 'Double-click or Enter to expand' : 'Double-click or Enter to collapse'}
      >
        <div
          role="separator"
          aria-label="Resize channel sidebar"
          aria-orientation="vertical"
          aria-valuemin={COLLAPSED_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={effectiveWidth}
          className={clsx('sidebar-resizer workstream-context-resizer', resizing && 'is-near')}
          tabIndex={0}
          onDoubleClick={() => { if (!narrow) saveCollapsed(!collapsed); }}
          onBlur={() => setKeyResizing(false)}
          onKeyDown={(event) => {
            // As in the navigation: the key the ARIA authoring practices give a
            // splitter, performing the toggle the double-click performs, so the
            // hint names something a keyboard can actually do.
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!narrow) saveCollapsed(!collapsed);
              return;
            }
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setKeyResizing(true);
            if (event.key === 'ArrowLeft' && !compact) resize(width > MIN_SIDEBAR_WIDTH ? width - 16 : SIDEBAR_COLLAPSE_DRAG_THRESHOLD - 1);
            if (event.key === 'ArrowRight') resize(compact ? MIN_SIDEBAR_WIDTH : width + 16);
          }}
          onKeyUp={() => setKeyResizing(false)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            const bounds = sidebar.current?.getBoundingClientRect();
            if (!bounds) return;
            drag.current = { pointerId: event.pointerId, offset: event.clientX - bounds.right };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            const bounds = sidebar.current?.getBoundingClientRect();
            if (bounds) {
              const requested = event.clientX - drag.current.offset - bounds.left;
              setDragWidth(Math.max(0, requested));
              resize(requested);
            }
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            drag.current = null;
            setResizing(false); setDragWidth(null);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { drag.current = null; setResizing(false); setDragWidth(null); }}
          onLostPointerCapture={() => { drag.current = null; setResizing(false); setDragWidth(null); }}
        >
          <span aria-hidden="true" className="sidebar-resizer-handle"><GripVertical size={11} strokeWidth={2} /></span>
        </div>
      </DragHint>
    </aside>
  );
}

function ResourceSection({ label, resources, onOpen }: { label: string; resources: SidebarPresentation['resources']; onOpen: (id: string, returnFocus: HTMLElement) => void }): React.JSX.Element | null {
  if (!resources.length) return null;
  return <section aria-label={label} className="workstream-context-section"><h2>{label}</h2>
    {/* The rail owns its tooltip: native title uses a different delay and
        never appears for someone reaching the row with the keyboard. */}
    {resources.map((resource) => <Tip key={resource.id} label={resource.title} side="right">
      <button className="workstream-context-row" aria-label={`Open ${resource.title}`} type="button" onClick={(event) => onOpen(resource.id, event.currentTarget)}>
        <span className="workstream-context-resource-icon"><ResourceIcon resource={resource} /></span>
        <span className="workstream-context-copy"><span>{resource.title}</span><small>{resource.resourceType.replaceAll('_', ' ')} · v{resource.currentVersion}</small></span>
      </button></Tip>)}
  </section>;
}
