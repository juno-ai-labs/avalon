import { FileBox, PanelLeftClose, PanelLeftOpen, UserPlus } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { WorkstreamDetail } from '../lib/types';
import { DEFAULT_SIDEBAR_WIDTH, SIDEBAR_CONTENT_MIN_WIDTH } from '../lib/ui-store';
import { Avatar, IconButton } from './primitives';
import { ResourceIcon } from './markdown-citations';
import { WorkstreamGlyph } from './workstream-glyph';

const COLLAPSED_KEY = 'rally.workstream-sidebar-collapsed';

/** Work-stream navigation only: no second resource query or substream model. */
export function WorkstreamSidebar({ workstream, presentUserIds, onOpenArtifact, onParticipants }: {
  workstream: Pick<WorkstreamDetail, 'id' | 'title' | 'resources' | 'participants'>;
  presentUserIds: readonly string[];
  onOpenArtifact: (id: string, returnFocus: HTMLElement) => void;
  onParticipants: () => void;
}): React.JSX.Element {
  const sidebar = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const [narrow, setNarrow] = useState(false);
  // Observe the available pane, never this sidebar or the transcript. Its
  // width does not change when this rail collapses, avoiding resize feedback.
  useLayoutEffect(() => {
    const pane = sidebar.current?.parentElement;
    if (!pane) return;
    const update = (): void => setNarrow(pane.clientWidth < DEFAULT_SIDEBAR_WIDTH + SIDEBAR_CONTENT_MIN_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  const compact = collapsed || narrow;
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');
  return (
    <aside aria-label="Work-stream sidebar" className={clsx('workstream-context-sidebar', compact && 'is-compact')} ref={sidebar}>
      <div className="workstream-context-toolbar window-drag">
        <span className="workstream-context-label">Work stream</span>
        <IconButton
          className="window-no-drag"
          label={compact ? 'Expand work-stream sidebar' : 'Collapse work-stream sidebar'}
          aria-expanded={!compact}
          disabled={narrow}
          title={narrow ? 'Widen the window to expand the work-stream sidebar' : undefined}
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* Device preference is best effort. */ }
          }}
        >{compact ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</IconButton>
      </div>
      <div className="workstream-context-scroll">
        <button
          className="workstream-context-row is-current"
          aria-current="page"
          aria-label={workstream.title}
          title={workstream.title}
          type="button"
          onClick={() => sidebar.current?.parentElement?.querySelector<HTMLElement>('[role="log"]')?.focus({ preventScroll: true })}
        >
          <WorkstreamGlyph id={workstream.id} size={36} />
          <span className="workstream-context-copy"><span>{workstream.title}</span><small>Main conversation</small></span>
        </button>
        <section aria-label="Generated artifacts" className="workstream-context-section">
          <h2>Generated artifacts</h2>
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
            <button className="workstream-context-row" key={person.id} aria-label={`${person.name}${presentUserIds.includes(person.id) ? ', viewing now' : ''}`} title={person.name} type="button" onClick={onParticipants}>
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
    </aside>
  );
}
