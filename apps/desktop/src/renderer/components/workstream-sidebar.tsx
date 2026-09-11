import * as ContextMenu from '@radix-ui/react-context-menu';
import { SidekickSection, type SidekickRow } from './sidekick-section';
import { Archive, GripVertical, PanelLeftClose, PanelLeftOpen, Pencil, UserPlus } from 'lucide-react';
import { IconCornerDownRight, IconPlus } from '@tabler/icons-react';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { WorkstreamDetail } from '../lib/types';
import type { WorkstreamChildDirectory } from '../lib/use-workstream-control-socket';
import { COLLAPSED_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_EXPAND_DRAG_THRESHOLD } from '../lib/ui-store';
import { AvatarStack, DragHint, IconButton, Tip } from './primitives';
import { PENDING_SUBSTREAM_DRAFT_ID } from './substream-launch';
import { ResourceIcon } from './markdown-citations';
import { WorkstreamMark } from './workstream-glyph';

const COLLAPSED_KEY = 'rally.workstream-sidebar-collapsed';
const WIDTH_KEY = 'rally.workstream-sidebar-width';
const clampWidth = (width: number): number => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));

export interface SubstreamRowTarget { substreamId: string; title: string }
export interface SubstreamRowActions {
  onRename: (target: SubstreamRowTarget) => void;
  onArchive: (target: SubstreamRowTarget) => void;
}

function SubstreamRowMenu({ actions, children, target }: {
  actions: SubstreamRowActions; children: React.ReactNode; target: SubstreamRowTarget;
}): React.JSX.Element {
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
        <ContextMenu.Item className="menu-item" onSelect={() => actions.onRename(target)}>
          <Pencil aria-hidden="true" size={16} /> Rename
        </ContextMenu.Item>
        <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => actions.onArchive(target)}>
          <Archive aria-hidden="true" size={16} /> Archive substream
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

/** Work-stream navigation only: no second resource query or substream model. */
export function WorkstreamSidebar({ workstream, presentUserIds, selectedSubstreamId = '0', onSelectSubstream, onNewSubstream, onOpenArtifact, onParticipants, onFocusTranscript, sidekicks, sidekicksError, substreamActions }: {
  workstream: Pick<WorkstreamDetail, 'id' | 'title' | 'appearance' | 'resources' | 'participants'> & Pick<WorkstreamChildDirectory, 'privateChildren'>;
  presentUserIds: readonly string[];
  /**
   * This work stream's Sidekicks — the ones it owns and the ones its
   * conversation has loaded — or `undefined` while that answer is still on its
   * way. The section says nothing at all for either, the way the artifact
   * section above it does.
   */
  sidekicks?: SidekickRow[] | undefined;
  sidekicksError?: string | undefined;
  selectedSubstreamId?: string;
  onSelectSubstream?: (substreamId: string) => void;
  onNewSubstream?: () => void;
  onOpenArtifact: (id: string, returnFocus: HTMLElement) => void;
  onParticipants: () => void;
  onFocusTranscript: () => void;
  substreamActions?: SubstreamRowActions | undefined;
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
  return (
    <aside aria-label="Work-stream sidebar" className={clsx('workstream-context-sidebar', compact && 'is-compact', (resizing || keyResizing) && 'is-resizing')} ref={sidebar} style={{ flexBasis: effectiveWidth }}>
      <div className="workstream-context-toolbar window-drag" />
      <div className="workstream-context-scroll">
        <button
          className={clsx('workstream-context-row workstream-conversation-row', selectedSubstreamId === '0' && 'is-current')}
          aria-current={selectedSubstreamId === '0' ? 'page' : undefined}
          aria-label={`Go to conversation: ${workstream.title}`}
          title={workstream.title}
          type="button"
          onClick={() => { onSelectSubstream?.('0'); onFocusTranscript(); }}
        >
          <span className="workstream-context-mark"><WorkstreamMark appearance={workstream.appearance} id={workstream.id} /></span>
          <span className="workstream-context-copy"><span>{workstream.title}</span></span>
        </button>
        <div className="workstream-substream-list">
          {workstream.privateChildren?.map((child) => {
            // Compact hides the title, and a rail of identical arrows says
            // only that these are substreams, not which is which. The first
            // letter is the only part of the title a 36px mark can hold.
            const initial = [...child.title.trim()][0]?.toUpperCase();
            const row = (
              <button
                aria-current={selectedSubstreamId === child.substreamId ? 'page' : undefined}
                aria-label={`Go to substream: ${child.title}`}
                className={clsx('workstream-context-row workstream-conversation-row', selectedSubstreamId === child.substreamId && 'is-current')}
                onClick={() => onSelectSubstream?.(child.substreamId)}
                title={child.title}
                type="button"
              >
                {/* Both marks, stacked in the one slot: the stylesheet
                    cross-fades the arrow into the initial as the rail
                    narrows, rather than this swapping one element for the
                    other, which would cut a frame ahead of the edge. */}
                <span aria-hidden="true" className="workstream-context-mark">
                  <IconCornerDownRight className="workstream-substream-arrow" size={22} stroke={1.5} />
                  {initial && <span className="workstream-substream-initial">{initial}</span>}
                </span>
                <span className="workstream-context-copy"><span>{child.title}</span></span>
              </button>
            );
            return substreamActions
              ? <SubstreamRowMenu actions={substreamActions} key={child.substreamId} target={{ substreamId: child.substreamId, title: child.title }}>{row}</SubstreamRowMenu>
              : <Fragment key={child.substreamId}>{row}</Fragment>;
          })}
          {onNewSubstream && (
            // Current while a substream is being written, because that surface
            // is where the reader is: the row it was opened from is the one
            // thing on screen that still says so.
            <button
              aria-current={selectedSubstreamId === PENDING_SUBSTREAM_DRAFT_ID ? 'page' : undefined}
              aria-label="New substream"
              className={clsx(
                'workstream-context-row workstream-new-substream',
                selectedSubstreamId === PENDING_SUBSTREAM_DRAFT_ID && 'is-current',
              )}
              onClick={onNewSubstream}
              title="New substream"
              type="button"
            >
              <span aria-hidden="true" className="workstream-context-mark"><IconPlus size={22} stroke={1.5} /></span>
              <span className="workstream-context-copy"><span>New substream</span></span>
            </button>
          )}
        </div>
        {/* Absent rather than empty, as the Sidekick strip below is: a heading
            over a placeholder row spends the rail's height saying a work
            stream has produced nothing yet, which is the ordinary state of a
            conversation that has only just started. */}
        {artifacts.length > 0 && (
          <section aria-label="Artifacts" className="workstream-context-section">
            <h2>Artifacts</h2>
            {/* The rail's own tooltip, not the platform's: a title long enough
                to be truncated here — or hidden outright by the compact rail —
                is the whole reason these rows carry one, and `title` draws it
                in the desktop's type after the desktop's delay, and never at
                all for a reader arriving on the row by keyboard. It opens to
                the side, where it covers the feed rather than the next
                artifact. */}
            {artifacts.map((resource) => (
              <Tip key={resource.id} label={resource.title} side="right">
                <button className="workstream-context-row" aria-label={`Open ${resource.title}`} type="button" onClick={(event) => onOpenArtifact(resource.id, event.currentTarget)}>
                  <span className="workstream-context-resource-icon"><ResourceIcon resource={resource} /></span>
                  <span className="workstream-context-copy"><span>{resource.title}</span><small>{resource.resourceType.replaceAll('_', ' ')} · v{resource.currentVersion}</small></span>
                </button>
              </Tip>
            ))}
          </section>
        )}
        <section aria-label="Work-stream participants" className="workstream-context-section">
          <h2>Participants</h2>
          <button className="workstream-context-row" aria-label="Manage work-stream participants" aria-description={workstream.participants.map((person) => person.name).join(', ')} type="button" onClick={onParticipants}>
            {workstream.participants.length ? <AvatarStack members={workstream.participants} limit={compact ? 2 : 4} presentUserIds={presentUserIds} /> : <UserPlus aria-hidden="true" size={18} />}
          </button>
        </section>
        {/* Below the people, because a Sidekick is the other kind of thing
            working in this room. */}
        <SidekickSection items={sidekicks} error={sidekicksError} />
      </div>
      <div className="sidebar-collapse-footer">
        <IconButton
          className="window-no-drag"
          label={compact ? 'Expand work-stream sidebar' : 'Collapse work-stream sidebar'}
          aria-expanded={!compact}
          disabled={narrow}
          title={narrow ? 'Widen the window to expand the work-stream sidebar' : undefined}
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
          aria-label="Resize work-stream sidebar"
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
