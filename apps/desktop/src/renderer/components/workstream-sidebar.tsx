import type { SidekickAttachment, Workspace } from '@rally/contracts';
import { workstreamCanonicalUrl } from '@rally/contracts';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { AttachedSidekicks } from './attached-sidekicks';
import { Archive, Copy, EyeOff, FileBox, GripVertical, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, UserPlus, Users } from 'lucide-react';
import { IconBorderCornerPill, IconPlus } from '@tabler/icons-react';
import { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import type { WorkstreamDetail } from '../lib/types';
import type { WorkstreamChildDirectory } from '../lib/use-workstream-control-socket';
import { COLLAPSED_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_EXPAND_DRAG_THRESHOLD } from '../lib/ui-store';
import { Avatar, AvatarStack, IconButton } from './primitives';
import { ResourceIcon } from './markdown-citations';

const COLLAPSED_KEY = 'rally.workstream-sidebar-collapsed';
const WIDTH_KEY = 'rally.workstream-sidebar-width';
const clampWidth = (width: number): number => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));

/**
 * The right-click menu on one substream row.
 *
 * Right-click rather than a visible button, matching how a work stream's own
 * row is managed in the left sidebar: the row is a navigation target first,
 * and a second control inside it competes with the thing it is on.
 *
 * The items are the work stream's, minus the two that cannot mean anything
 * here — Pin and Add to project both place a row in the workspace directory,
 * which a private child never enters — and minus Make private, because a
 * substream has no other state to be in. Participants is the one addition:
 * the work stream keeps its roster in the sidebar section below, and a
 * substream has no section of its own, so without this there is no way at all
 * to put somebody in one.
 */
function SubstreamRowMenu({ actions, children, target, workstreamId }: {
  actions: SubstreamRowActions;
  children: React.ReactNode;
  target: SubstreamRowTarget;
  workstreamId: string;
}): React.JSX.Element {
  const workspace = actions.workspace;
  const copyLink = async (): Promise<void> => {
    if (!workspace) return;
    const bridge = desktopBridge();
    const { webBaseUrl } = await bridge.getRuntimeConfig();
    // The work stream's link, because that is the only address a canonical
    // link has: the path carries no substream, and inventing one here would
    // hand out a URL nothing on the receiving side knows how to open.
    await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, {
      region: workspace.region,
      workspaceId: workspace.id,
      workstreamId,
    }));
    reportTelemetryProductIntent({
      kind: 'content_copied', contentType: 'workstream_link', resourceType: 'workstream', resourceId: workstreamId,
    });
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          <ContextMenu.Item className="menu-item" onSelect={() => actions.onParticipants(target)}>
            <Users aria-hidden="true" size={16} /> Participants
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => actions.onMarkUnread(target)}>
            <EyeOff aria-hidden="true" size={16} /> Mark as unread
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => actions.onRename(target)}>
            <Pencil aria-hidden="true" size={16} /> Rename
          </ContextMenu.Item>
          {actions.debugEnabled && workspace && (
            <ContextMenu.Item className="menu-item" onSelect={() => void copyLink().catch(() => undefined)}>
              <Copy aria-hidden="true" size={16} /> Copy work stream link
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="menu-separator" />
          {/* Names its noun the way the work stream's item does, so the two
              read as the same action at two scales rather than one ambiguous
              "Archive" that could mean either. */}
          <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => actions.onArchive(target)}>
            <Archive aria-hidden="true" size={16} /> Archive substream
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** One substream row's identity, as its menu items need it. */
export interface SubstreamRowTarget {
  substreamId: string;
  title: string;
}

/**
 * What the right-click menu on a substream row can do.
 *
 * The work stream's own row carries these same items in the left sidebar, less
 * Pin and Add to project — both of those are workspace-directory features, and
 * a private child is not in the workspace directory. Passed in rather than
 * performed here: this component navigates and draws, and the screen above it
 * owns the API, the confirmation and where to go once a substream is gone.
 */
export interface SubstreamRowActions {
  onParticipants: (target: SubstreamRowTarget) => void;
  onMarkUnread: (target: SubstreamRowTarget) => void;
  onRename: (target: SubstreamRowTarget) => void;
  onArchive: (target: SubstreamRowTarget) => void;
  /** Matches the work stream's own copy item, which is debug-only today. */
  debugEnabled?: boolean;
  workspace?: Pick<Workspace, 'id' | 'region'> | undefined;
}

/** Work-stream navigation only: no second resource query or substream model. */
export function WorkstreamSidebar({ workstream, presentUserIds, selectedSubstreamId = '0', onSelectSubstream, onNewSubstream, onOpenArtifact, onParticipants, onFocusTranscript, attachedSidekicks, attachedSidekicksError, onRemoveSidekick, substreamActions }: {
  workstream: Pick<WorkstreamDetail, 'id' | 'title' | 'resources' | 'participants'> & Pick<WorkstreamChildDirectory, 'privateChildren'>;
  presentUserIds: readonly string[];
  attachedSidekicks?: SidekickAttachment[] | undefined;
  attachedSidekicksError?: string | undefined;
  onRemoveSidekick?: ((id: string) => void) | undefined;
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
            const unread = (child.unreadCount ?? 0) > 0;
            // Selecting a substream reads it, so a row the reader is looking
            // at never wears its own marker.
            const marked = unread && selectedSubstreamId !== child.substreamId;
            const row = (
              <button
                aria-current={selectedSubstreamId === child.substreamId ? 'page' : undefined}
                aria-label={`Go to substream: ${child.title}${marked ? child.youAreMentioned ? ', mentions you' : ', unread' : ''}`}
                className={clsx('workstream-context-row workstream-conversation-row', selectedSubstreamId === child.substreamId && 'is-current')}
                onClick={() => onSelectSubstream?.(child.substreamId)}
                title={child.title}
                type="button"
              >
                <span className="workstream-substream-avatar" aria-hidden="true">{creator ? <Avatar member={creator} title={null} /> : <MessageSquare size={20} />}</span>
                <span className="workstream-context-copy"><span className={clsx(marked && 'is-unread')}>{child.title}</span></span>
                {/* Presentational: the accessible name above already carries
                    it, so a second announcement would read the row twice. */}
                {marked && <span aria-hidden="true" className={clsx('workstream-substream-marker', child.youAreMentioned && 'is-mention')} />}
              </button>
            );
            return (
              <div className="workstream-substream-branch" key={child.substreamId}>
                <IconBorderCornerPill aria-hidden="true" className="workstream-substream-connector" size={24} stroke={1.5} />
                {substreamActions
                  ? <SubstreamRowMenu actions={substreamActions} target={{ substreamId: child.substreamId, title: child.title }} workstreamId={workstream.id}>{row}</SubstreamRowMenu>
                  : row}
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
          <button className="workstream-context-row" aria-label="Manage work-stream participants" aria-description={workstream.participants.map((person) => person.name).join(', ')} type="button" onClick={() => onParticipants()}>
            {workstream.participants.length ? <AvatarStack members={workstream.participants} presentUserIds={presentUserIds} /> : <UserPlus aria-hidden="true" size={18} />}
          </button>
        </section>
        <AttachedSidekicks items={attachedSidekicks} error={attachedSidekicksError} onRemove={onRemoveSidekick} />
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
