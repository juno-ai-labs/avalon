import { FileBox, FolderCog, GripVertical, MessageSquare, PanelLeftClose, PanelLeftOpen, UserPlus } from 'lucide-react';
import { IconBorderCornerPill, IconPlus } from '@tabler/icons-react';
import { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { WorkstreamDetail } from '../lib/types';
import { COLLAPSED_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_EXPAND_DRAG_THRESHOLD } from '../lib/ui-store';
import { Avatar, IconButton } from './primitives';
import { ResourceIcon } from './markdown-citations';

const COLLAPSED_KEY = 'rally.workstream-sidebar-collapsed';
const WIDTH_KEY = 'rally.workstream-sidebar-width';
const clampWidth = (width: number): number => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));

/** Work-stream navigation only: no second resource query or substream model. */
export function WorkstreamSidebar({ workstream, presentUserIds, selectedSubstreamId = '0', onSelectSubstream, onNewSubstream, onOpenArtifact, onResources, onParticipants, onFocusTranscript }: {
  workstream: Pick<WorkstreamDetail, 'id' | 'title' | 'resources' | 'participants' | 'privateChildren'>;
  presentUserIds: readonly string[];
  selectedSubstreamId?: string;
  onSelectSubstream?: (substreamId: string) => void;
  onNewSubstream?: () => void;
  onOpenArtifact: (id: string, returnFocus: HTMLElement) => void;
  onResources?: (returnFocus: HTMLElement) => void;
  onParticipants: () => void;
  onFocusTranscript: () => void;
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
    <aside aria-label="Work-stream sidebar" className={clsx('workstream-context-sidebar', compact && 'is-compact', resizing && 'is-resizing')} ref={sidebar} style={{ flexBasis: effectiveWidth }}>
      <div className="workstream-context-toolbar window-drag">
        <span className="workstream-context-label">Work stream</span>
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
      <div className="workstream-context-scroll">
        <button
          className={clsx('workstream-context-row workstream-conversation-row', selectedSubstreamId === '0' && 'is-current')}
          aria-current={selectedSubstreamId === '0' ? 'page' : undefined}
          aria-label={`Go to conversation: ${workstream.title}`}
          title={workstream.title}
          type="button"
          onClick={() => { onSelectSubstream?.('0'); onFocusTranscript(); }}
        >
          {compact && <MessageSquare aria-hidden="true" size={20} />}
          <span className="workstream-context-copy"><span>Main log</span></span>
        </button>
        <div className="workstream-substream-list">
          {workstream.privateChildren?.map((child) => {
            const creator = workstream.participants.find((person) => person.id === child.createdByUserId);
            return (
              <div className="workstream-substream-branch" key={child.substreamId}>
                <IconBorderCornerPill aria-hidden="true" className="workstream-substream-connector" size={24} stroke={1.5} />
                <button
                  aria-current={selectedSubstreamId === child.substreamId ? 'page' : undefined}
                  aria-label={`Go to substream: ${child.title}`}
                  className={clsx('workstream-context-row workstream-conversation-row', selectedSubstreamId === child.substreamId && 'is-current')}
                  onClick={() => onSelectSubstream?.(child.substreamId)}
                  title={child.title}
                  type="button"
                >
                  <span className="workstream-substream-avatar" aria-hidden="true">{creator ? <Avatar member={creator} title={null} /> : <MessageSquare size={20} />}</span>
                  <span className="workstream-context-copy"><span>{child.title}</span></span>
                </button>
              </div>
            );
          })}
          {onNewSubstream && <div className="workstream-substream-branch">
            <IconBorderCornerPill aria-hidden="true" className="workstream-substream-connector" size={24} stroke={1.5} />
            <button className="workstream-context-row workstream-new-substream" onClick={onNewSubstream} title="New substream" aria-label="New substream" type="button">
              <span className="workstream-substream-avatar"><IconPlus aria-hidden="true" size={20} stroke={1.5} /></span><span className="workstream-context-copy"><span>New substream</span></span>
            </button>
          </div>}
        </div>
        <section aria-label="Generated artifacts" className="workstream-context-section">
          <h2>Generated artifacts</h2>
          {onResources && <button className="workstream-context-row" aria-label="Manage resources" title="Manage resources" type="button" onClick={(event) => onResources(event.currentTarget)}><span className="workstream-context-resource-icon"><FolderCog size={18} /></span><span className="workstream-context-copy">Manage resources</span></button>}
          {artifacts.length === 0 ? (
            <div className="workstream-context-empty" title="No generated artifacts yet"><FileBox size={20} /><span>No generated artifacts yet</span></div>
          ) : artifacts.map((resource) => (
            <button className="workstream-context-row" key={resource.id} aria-label={`Open ${resource.title}`} title={resource.title} type="button" onClick={(event) => onOpenArtifact(resource.id, event.currentTarget)}>
              <span className="workstream-context-resource-icon"><ResourceIcon type={resource.resourceType} /></span>
              <span className="workstream-context-copy"><span>{resource.title}</span><small>{resource.resourceType.replaceAll('_', ' ')} · v{resource.currentVersion}</small></span>
            </button>
          ))}
        </section>
        <section aria-label="Work-stream participants" className="workstream-context-section">
          <h2>Participants</h2>
          {workstream.participants.map((person) => (
            <button className="workstream-context-row" key={person.id} aria-label={`Manage participants: ${person.name}${presentUserIds.includes(person.id) ? ', viewing now' : ''}`} title={person.name} type="button" onClick={onParticipants}>
              <span className="workstream-context-resource-icon"><Avatar member={person} title={null} /></span>
              <span className="workstream-context-copy"><span>{person.name}</span></span>
              {presentUserIds.includes(person.id) && <span className="workstream-context-presence" aria-hidden="true" />}
            </button>
          ))}
          <button className="workstream-context-row" aria-label="Manage work-stream participants" title="Manage participants" type="button" onClick={onParticipants}>
            <span className="workstream-context-resource-icon"><UserPlus size={18} /></span><span className="workstream-context-copy">Manage participants</span>
          </button>
        </section>
      </div>
      <div
        role="separator"
        aria-label="Resize work-stream sidebar"
        aria-orientation="vertical"
        aria-valuemin={COLLAPSED_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={effectiveWidth}
        className={clsx('sidebar-resizer workstream-context-resizer', resizing && 'is-near')}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          if (event.key === 'ArrowLeft' && !compact) resize(width > MIN_SIDEBAR_WIDTH ? width - 16 : SIDEBAR_COLLAPSE_DRAG_THRESHOLD - 1);
          if (event.key === 'ArrowRight') resize(compact ? MIN_SIDEBAR_WIDTH : width + 16);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const bounds = sidebar.current?.getBoundingClientRect();
          if (!bounds) return;
          drag.current = { pointerId: event.pointerId, offset: event.clientX - bounds.right };
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          const bounds = sidebar.current?.getBoundingClientRect();
          if (bounds) resize(event.clientX - drag.current.offset - bounds.left);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          setResizing(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; setResizing(false); }}
        onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
      >
        <span aria-hidden="true" className="sidebar-resizer-handle"><GripVertical size={11} strokeWidth={2} /></span>
      </div>
    </aside>
  );
}
