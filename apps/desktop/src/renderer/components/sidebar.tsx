import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { IconDots, IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronsLeft,
  Check,
  CirclePause,
  Clock,
  Cog,
  Command,
  Copy,
  EyeOff,
  FileStack,
  Globe2,
  LogOut,
  Menu,
  MessageSquarePlus,
  Mic2,
  NotebookText,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { workstreamCanonicalUrl } from '@rally/contracts/workstream-links';
import type { CreateProjectRequest, ProjectSummary, WorkstreamBatchFilter, WorkstreamBatchUpdate } from '@rally/contracts';
import {
  formatDateTime,
  formatRelative,
  groupActivityItems,
  nextRecencyBoundary,
  recencyGroupBatchFilter,
  workstreamMarkerStatus,
  type RecencyGroup,
} from '../lib/format';
import { automationAttentionNotice } from '../lib/automation-attention';
import { useNamingSkeleton } from '../lib/naming-skeleton';
import { desktopBridge } from '../lib/platform';
import { useWorkstreamSocketHoverWarmup, useWorkstreamSocketOpenContext } from '../lib/workstream-socket-pool';
import {
  markSurfaceEntrypoint,
  markWorkstreamFeedOpenStarted,
  markWorkstreamNavigation,
  reportTelemetryProductIntent,
  telemetryVisibility,
} from '../lib/telemetry';
import type { AutomationSummary, NoteSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { Avatar, Badge, Button, IconButton, InlineError, Modal, StatusDot, TitleSkeleton } from './primitives';
import { ProjectIcon, ProjectSidebarSection } from './project-sidebar-section';
import { ContextNestedMenu } from './nested-menu';

interface SidebarProps {
  workspace: Workspace;
  automations: AutomationSummary[];
  notes?: NoteSummary[];
  projects?: ProjectSummary[];
  inactiveProjects?: ProjectSummary[];
  workstreams: WorkstreamSummary[];
  /** Whether a page of work streams remains beyond the ones listed. */
  hasMoreWorkstreams?: boolean;
  /** A further page is in flight, so the end of the list is not the end. */
  loadingMoreWorkstreams?: boolean;
  /** Ask for the next page. Called when the scroll approaches the bottom. */
  onLoadMoreWorkstreams?: () => void;
  loading?: boolean;
  meetingRecordingAvailable?: boolean;
  onArchiveNote: (note: NoteSummary) => Promise<void>;
  onArchiveWorkstream: (workstream: WorkstreamSummary) => Promise<void>;
  onApplyWorkstreamBatch: (
    operationId: string,
    filter: WorkstreamBatchFilter,
    update: WorkstreamBatchUpdate,
  ) => Promise<number>;
  onChangeNoteScope: (note: NoteSummary, scope: 'personal' | 'workspace') => Promise<void>;
  onChangeWorkstreamScope: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => Promise<void>;
  onDeleteAutomation: (automation: AutomationSummary) => Promise<void>;
  onMarkWorkstreamUnread: (workstream: WorkstreamSummary) => Promise<void>;
  /**
   * Pin or unpin for the signed-in person, on every device they use.
   *
   * Resolves to whether the response was the one applied — `false` when a later
   * pin was issued behind it and took the list instead. Only the action that
   * won gets to move the viewport; see `reveal`.
   */
  onPinWorkstream: (workstream: WorkstreamSummary, pinned: boolean) => Promise<boolean>;
  /** The pinned list's new order, in full, after a drag or a keyboard move. */
  onReorderPinnedWorkstreams: (workstreamIds: string[]) => Promise<void>;
  onRenameWorkstream: (workstream: WorkstreamSummary, title: string) => Promise<void>;
  onRunAutomation: (automation: AutomationSummary) => Promise<void>;
  onOpenMeetingNotes: (noteId?: string) => Promise<void>;
  onPreviewWorkstreamBatch: (filter: WorkstreamBatchFilter) => Promise<number>;
  onCreateProject?: (input: CreateProjectRequest) => Promise<ProjectSummary>;
  onAddWorkstreamToProject?: (projectId: string, workstreamId: string) => Promise<void>;
  onReorderProjects?: (projectIds: string[]) => Promise<void>;
  onRestoreProject?: (projectId: string) => Promise<void>;
  onSignOut: () => void;
}

type RecentSidebarItem =
  | { type: 'note'; note: NoteSummary; id: string; lastActivityAt: string }
  | { type: 'workstream'; workstream: WorkstreamSummary; id: string; lastActivityAt: string };

interface WorkstreamBatchTarget {
  label: RecencyGroup;
  operationId: string;
  filter: WorkstreamBatchFilter;
  update: WorkstreamBatchUpdate;
  matchedCount: number;
}

/** How close the pointer comes to the navigation's edge before its pill shows. */
const EDGE_REVEAL_DISTANCE = 20;

/**
 * How near the bottom the scroll comes before the next page is asked for.
 *
 * Ahead of the end rather than at it, so the rows are usually already there by
 * the time the reader arrives — roughly a screen of sidebar rows, which is what
 * a fast flick covers between two scroll events.
 */
const LOAD_MORE_DISTANCE = 400;

/** The one element carrying the keyboard-reorder instruction for the section. */
const PINNED_DRAG_HINT_ID = 'pinned-drag-hint';

/** The number row gives us nine visible shortcuts without borrowing `0`. */
const COMMAND_SHORTCUT_LIMIT = 9;

/**
 * How long the sidebar will wait for the list to carry a pin before it stops
 * intending to follow the row.
 *
 * The wait is normally one render. It is bounded because the alternative is a
 * reveal that stays armed: socket state can rerender the list, so an intent
 * that is never honoured is re-evaluated forever and fires the moment the state
 * happens to match — scrolling, and moving focus, under somebody who pinned
 * something a minute ago and has long since moved on. Following a row is only
 * worth anything while the action that moved it is still what the reader is
 * thinking about; two seconds is past the round trip and well short of that.
 */
export const REVEAL_DEADLINE_MS = 2_000;

/**
 * One row's worth of placeholder, in the geometry of the row it stands in for.
 *
 * Shaped rather than a single block because the sidebar's three lists arrive
 * together now: the reader sees the layout they are about to get — a marker, a
 * title, sometimes a second line — and the rows fill in where the bars already
 * are, instead of a grey rectangle collapsing into a different shape. Widths
 * vary by position in CSS rather than here, so the set reads as a list of
 * unequal titles and not as a barcode.
 *
 * Decorative: the label for the wait is said once, by the section.
 */
function SidebarSkeletonRow({ hint = false }: { hint?: boolean }): React.JSX.Element {
  return (
    <div aria-hidden="true" className="sidebar-row skeleton-row">
      <span className="skeleton-bar skeleton-row-marker" />
      <span className="sidebar-row-main">
        <span className="skeleton-bar skeleton-row-line" />
        {hint && <span className="skeleton-bar skeleton-row-subline" />}
      </span>
    </div>
  );
}

function SidebarSkeletonRows({ count, hint = false }: { count: number; hint?: boolean }): React.JSX.Element {
  return (
    <div className="sidebar-list">
      {Array.from({ length: count }, (_, index) => <SidebarSkeletonRow hint={hint} key={index} />)}
    </div>
  );
}

/** A dated group of work streams, heading included — what the list resolves into. */
function SidebarSkeletonGroup({ count }: { count: number }): React.JSX.Element {
  return (
    <div className="sidebar-group">
      <span aria-hidden="true" className="skeleton-bar skeleton-group-label" />
      <SidebarSkeletonRows count={count} hint />
    </div>
  );
}

const onboardingItems = [
  {
    id: 'connect-tools',
    title: 'Connect your tools',
    description: 'Bring Linear, GitHub, and Google Workspace into Rally',
  },
  {
    id: 'create-automation',
    title: 'Create your first automation',
    description: 'Schedule a recurring brief, monitor, or follow-up',
  },
  {
    id: 'invite-teammate',
    title: 'Invite a teammate',
    description: 'Work together in a shared work stream',
  },
] as const;

// DISABLED — see the commented-out render call near the bottom of `Sidebar`
// for why this is not mounted. Left in place (rather than deleted) so the
// eventual real version has a starting point; do not delete this function
// without also resolving that comment.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for the reasons above; not currently rendered.
function OnboardingChecklist(): React.JSX.Element {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const completedCount = completed.size;

  return (
    <section className="onboarding-checklist" aria-labelledby="onboarding-checklist-heading">
      <header>
        <h2 id="onboarding-checklist-heading">Get started with Rally</h2>
        <span>{completedCount} / {onboardingItems.length}</span>
      </header>
      <div
        aria-label={`${completedCount} of ${onboardingItems.length} onboarding steps complete`}
        aria-valuemax={onboardingItems.length}
        aria-valuemin={0}
        aria-valuenow={completedCount}
        className="onboarding-progress"
        role="progressbar"
      >
        <span style={{ width: `${(completedCount / onboardingItems.length) * 100}%` }} />
      </div>
      <div className="onboarding-items">
        {onboardingItems.map((item) => {
          const isComplete = completed.has(item.id);
          return (
            <button
              aria-pressed={isComplete}
              className={isComplete ? 'is-complete' : undefined}
              key={item.id}
              onClick={() => {
                setCompleted((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
              type="button"
            >
              <span aria-hidden="true" className="onboarding-check">
                {isComplete && <Check size={12} strokeWidth={2.5} />}
              </span>
              <span className="onboarding-item-copy">
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Application → Developer → Debug enabled reveals this on every resource
 * right-click menu, so a bug report can name the exact row it came from. */
function CopyResourceIdItem({
  contentType,
  id,
  label,
  resourceType,
}: {
  contentType: 'note_id' | 'automation_id';
  id: string;
  label: string;
  resourceType: 'note' | 'automation';
}): React.JSX.Element {
  const copy = async (): Promise<void> => {
    await desktopBridge().copyText(id);
    reportTelemetryProductIntent({ kind: 'content_copied', contentType, resourceType, resourceId: id });
  };
  return (
    <ContextMenu.Item
      className="menu-item"
      onSelect={() => void copy().catch(() => undefined)}
    >
      <Copy aria-hidden="true" size={16} /> {label}
    </ContextMenu.Item>
  );
}

/**
 * The work-stream row's copy action hands out the link rather than the bare id:
 * a row is shared with a person far more often than it is quoted into a bug
 * report, and the id is still one click away in the work stream's own header
 * menu and its right rail. Like every other surface it emits the canonical
 * HTTPS link, never the `rallywithai://` deep link — see `docs/workstream-links.md`.
 */
function CopyWorkstreamLinkItem({ workstreamId }: { workstreamId: string }): React.JSX.Element {
  const copy = async (): Promise<void> => {
    const bridge = desktopBridge();
    const { webBaseUrl } = await bridge.getRuntimeConfig();
    await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, workstreamId));
    reportTelemetryProductIntent({
      kind: 'content_copied', contentType: 'workstream_link', resourceType: 'workstream', resourceId: workstreamId,
    });
  };
  return (
    <ContextMenu.Item className="menu-item" onSelect={() => void copy().catch(() => undefined)}>
      <Copy aria-hidden="true" size={16} /> Copy work stream link
    </ContextMenu.Item>
  );
}

/** The durable automation route currently open, excluding the new route. */
function useOpenDraftId(): string | null {
  const location = useLocation();
  const id = /^\/automations\/([^/]+)$/u.exec(location.pathname)?.[1] ?? null;
  return id === 'new' ? null : id;
}

function AutomationRow({
  automation,
  debugEnabled,
  onDelete,
  onRunNow,
}: {
  automation: AutomationSummary;
  debugEnabled: boolean;
  onDelete: (automation: AutomationSummary) => void;
  onRunNow: (automation: AutomationSummary) => void;
}): React.JSX.Element {
  const isDraft = automation.status === 'draft';
  const draftActive = useOpenDraftId() === automation.id;
  // A row is one line, so it carries the fact and not the reason: the words for
  // why are on the automation's own screen, which is one click away.
  const attention = automation.attention ? automationAttentionNotice(automation.attention) : null;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          {/* AutomationScreen dispatches the same durable route to either the
              draft conversation or accepted home from lifecycle state. */}
          <NavLink
            className={({ isActive }) => clsx('sidebar-row', (isDraft ? draftActive : isActive) && 'is-active', isDraft && 'is-draft')}
            onClick={() => markSurfaceEntrypoint('sidebar_automation')}
            to={`/automations/${automation.id}`}
          >
            <span className={clsx('sidebar-row-icon', attention && 'is-attention')} aria-hidden="true">
              {attention
                ? <AlertTriangle size={13} />
                : automation.status === 'paused'
                  ? <CirclePause size={13} />
                  : <span className={clsx('mini-state', automation.status)} />}
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">{automation.name}</span>
              {/* The attention hint outranks the schedule: an automation that
                  will not run has no next run worth naming, and one that was
                  paused after a failure is not "next Tuesday" either. */}
              {attention
                ? <span className="sidebar-row-hint is-attention">{attention.shortLabel}</span>
                : isDraft
                  ? <span className="sidebar-row-hint">Draft</span>
                  : automation.nextRunAt && <span className="sidebar-row-hint">Next {formatRelative(automation.nextRunAt)}</span>}
            </span>
            <Badge className="scope-badge">{automation.scope === 'you' ? 'You' : 'Workspace'}</Badge>
          </NavLink>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          <ContextMenu.Item
            className="menu-item"
            disabled={isDraft}
            onSelect={() => onRunNow(automation)}
          >
            <Play aria-hidden="true" size={16} /> Run now
          </ContextMenu.Item>
          {/* "Turn into template" is deliberately absent: it had no
              `onSelect`, so it closed the menu and did nothing.
              Publishing a template is offered on the automation's
              own overview, which is where the API for it is
              wired. */}
          {debugEnabled && (
            <CopyResourceIdItem
              contentType="automation_id"
              id={automation.id}
              label="Copy automation id"
              resourceType="automation"
            />
          )}
          <ContextMenu.Separator className="menu-separator" />
          {/* Named and iconed for what the API actually does. It calls
              `deleteAutomation` — a tombstone nothing can undo — so
              labelling it "Archive draft" beside a confirmed "Delete
              automation" offered the irreversible one as the softer
              choice, and fired it straight off the right-click. */}
          <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => onDelete(automation)}>
            <Trash2 aria-hidden="true" size={16} /> {isDraft ? 'Delete draft' : 'Delete automation'}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The drag behaviour a pinned row carries, supplied only in the Pinned section.
 * Absent everywhere else, which is what keeps a row in the recent list — sorted
 * by activity, where a manual order would be overwritten by the next
 * message — from being draggable at all.
 */
interface PinnedRowDrag {
  dragging: boolean;
  /** `cancelled` is a drag backed out of rather than dropped on the list. */
  onDragEnd: (cancelled: boolean) => void;
  onDragOver: (workstream: WorkstreamSummary) => void;
  onDragStart: (workstream: WorkstreamSummary) => void;
  /** Keyboard equivalent of a drag: one step toward the top or the bottom. */
  onMove: (workstream: WorkstreamSummary, direction: -1 | 1) => void;
  position: string;
}

function CommandShortcutHint({
  shortcut,
  visible,
}: {
  shortcut?: number;
  visible?: boolean;
}): React.JSX.Element | null {
  if (!visible || shortcut === undefined) return null;
  return (
    <span aria-hidden="true" className="command-shortcut-scrim">
      {/* Same Badge + scope-badge chrome as an automation's You / Workspace
          pill, so holding Command does not introduce a second, chunkier chip. */}
      <Badge className="scope-badge command-shortcut-pill">
        <Command size={9} strokeWidth={2} />
        <span>{shortcut}</span>
      </Badge>
    </span>
  );
}

function WorkstreamRow({
  commandShortcut,
  commandShortcutsVisible,
  debugEnabled,
  drag,
  workstream,
  pinPending,
  scopePending,
  onArchive,
  onChangeScope,
  onMarkUnread,
  onRename,
  onTogglePin,
  projects,
  onAddToProject,
}: {
  commandShortcut?: number;
  commandShortcutsVisible?: boolean;
  debugEnabled: boolean;
  drag?: PinnedRowDrag;
  workstream: WorkstreamSummary;
  pinPending: boolean;
  scopePending: boolean;
  onArchive: (workstream: WorkstreamSummary) => void;
  onChangeScope: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => void;
  onMarkUnread: (workstream: WorkstreamSummary) => void;
  onRename: (workstream: WorkstreamSummary) => void;
  onTogglePin: (workstream: WorkstreamSummary, pinned: boolean) => void;
  projects: ProjectSummary[];
  onAddToProject: (projectId: string, workstreamId: string) => void;
}): React.JSX.Element {
  const location = useLocation();
  const socketWarmup = useWorkstreamSocketHoverWarmup(workstream.id);
  const socketOpenContext = useWorkstreamSocketOpenContext(workstream.id);
  // The row is a cache entry, not a read: nothing here refetches, so the grace
  // is what ends a skeleton whose rename never arrived. Read
  // `lib/naming-skeleton.ts` before changing when it comes down.
  const naming = useNamingSkeleton(workstream);
  const isPrivate = workstream.scope === 'personal';
  const isPinned = workstream.pinPosition !== null;
  const nextWakeupTime = workstream.nextPendingWakeup
    ? formatDateTime(workstream.nextPendingWakeup.dueAt)
    : null;
  // Both socket paths carry the standing description as `objective`. Keep the
  // direct value first for compatibility with resident cache rows, but never
  // let an empty legacy preview hide an otherwise valid description.
  const description = workstream.preview || workstream.objective || workstream.automationName;
  // Two kinds of row take their audience from something other than this
  // column, so offering the toggle on them would describe a change that does
  // not happen: a subsystem's own work stream is machinery, and one an
  // automation generated is visible to whoever that automation is visible to.
  // The API refuses both; the menu simply does not raise the question.
  const scopeIsThisRowsToDecide = !workstream.systemKind && !workstream.automationSubscriptionId;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={clsx('sidebar-context-target', drag && 'is-draggable', drag?.dragging && 'is-dragging')}
          // How the sidebar finds this row again after pinning has moved it to
          // a different section — see the `reveal` effect.
          data-workstream-id={workstream.id}
          draggable={drag !== undefined || projects.length > 0}
          onDragEnd={drag
            // A drag nothing accepted reports `none`. Treated as cancelled when
            // the browser gives no `dataTransfer` at all, because a drop this
            // list handled always leaves one behind.
            ? (event) => drag.onDragEnd((event.dataTransfer?.dropEffect ?? 'none') === 'none')
            : undefined}
          onDragOver={drag
            ? (event) => {
              // `preventDefault` is what makes this a drop target at all, and
              // the effect is what a release here reports back to `dragend`;
              // without it a finished drag is indistinguishable from an
              // abandoned one. The reorder happens here rather than on `drop`
              // so the list settles under the pointer as it moves instead of
              // jumping once at the end.
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              drag.onDragOver(workstream);
            }
            : undefined}
          onDragStart={(event) => {
              // Chromium refuses to start a drag with an empty payload, and the
              // id is the payload every other surface would want anyway. The
              // order itself is tracked in the sidebar's own state: reading it
              // back out of `dataTransfer` is only possible on `drop`, which is
              // too late to move anything under the pointer.
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', workstream.id);
              event.dataTransfer.setData('application/x-rally-workstream-id', workstream.id);
              drag?.onDragStart(workstream);
            }}
          onDrop={drag ? (event) => event.preventDefault() : undefined}
          onKeyDown={drag
            ? (event) => {
              // Alt rather than a bare arrow: the arrows move focus through the
              // sidebar, and a pinned row must stay reachable by someone who is
              // reading rather than rearranging.
              if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
              event.preventDefault();
              drag.onMove(workstream, event.key === 'ArrowUp' ? -1 : 1);
            }
            : undefined}
          onPointerEnter={socketWarmup.onPointerEnter}
          onPointerLeave={socketWarmup.onPointerLeave}
          onPointerCancel={socketWarmup.onPointerCancel}
        >
          <NavLink
            aria-keyshortcuts={commandShortcut === undefined ? undefined : `Meta+${commandShortcut}`}
            className={({ isActive }) => clsx(
              'sidebar-row workstream-row',
              isActive && 'is-active',
              workstream.hasUnread && 'is-unread',
              // Machinery the reader has opted into seeing. Dimmed rather than
              // badged, so it reads as one level below the work it sits beside
              // without adding another thing to decode.
              workstream.systemKind && 'is-system',
            )}
            // The anchor would otherwise be the drag source and drag its own
            // href, leaving the wrapper's handlers to fire on a link drag that
            // the sidebar has no way to reorder.
            draggable={false}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0
                || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              const destination = `/workstreams/${workstream.id}`;
              if (location.pathname === destination) return;
              const socketContext = socketOpenContext();
              markWorkstreamFeedOpenStarted(
                workstream.id,
                workstream.pinPosition === null ? 'recent' : 'pinned',
                socketContext.state,
                performance.now(),
                socketContext.socketLeaseId,
              );
              markWorkstreamNavigation(
                workstream.id,
                /^\/workstreams\/[^/]+$/u.test(location.pathname),
              );
              markSurfaceEntrypoint(workstream.pinPosition === null ? 'sidebar_recent' : 'sidebar_pinned');
            }}
            to={`/workstreams/${workstream.id}`}
          >
            <span className="sidebar-row-icon">
              <StatusDot compact status={workstreamMarkerStatus(workstream)} tooltip />
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">
                {workstream.systemKind && <Cog aria-label="System work stream" size={11} />}
                {naming ? <TitleSkeleton /> : workstream.title}
              </span>
              {description && (
                <span className="sidebar-row-hint">
                  <span className="sidebar-row-hint-text">
                    {description}
                  </span>
                </span>
              )}
            </span>
            {/* The manual order is the whole point of the section, and a
                pointer-only affordance leaves it unreadable to anyone not
                looking at it. The position — and only the position — rides on
                the row, because it is the part that differs per row; how to
                change it is said once, on the section. */}
            {drag && <span className="sr-only">{drag.position}</span>}
            {workstream.nextPendingWakeup && (
              <Tooltip.Root delayDuration={300}>
                <Tooltip.Trigger asChild>
                  <span
                    aria-label={`Active timer. Next: ${nextWakeupTime}. ${workstream.nextPendingWakeup.promptPreview}`}
                    className="sidebar-workstream-timer"
                    role="img"
                  >
                    <Clock aria-hidden="true" size={15} strokeWidth={1.7} />
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    align="center"
                    className="tooltip workstream-timer-tooltip"
                    side="right"
                    sideOffset={8}
                  >
                    <strong>Next: {nextWakeupTime}</strong>
                    <span>{workstream.nextPendingWakeup.promptPreview}</span>
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            )}
            {workstream.scope === 'personal' && <PrivacyMarker label="Private work stream" />}
            <CommandShortcutHint shortcut={commandShortcut} visible={commandShortcutsVisible} />
          </NavLink>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          {/* Named for the state it moves to, like every other toggle in these
              menus. A pin is this reader's own and follows them to their other
              devices; it changes nothing for anyone else in the work stream. */}
          <ContextMenu.Item
            className="menu-item"
            disabled={pinPending}
            onSelect={() => onTogglePin(workstream, !isPinned)}
          >
            {isPinned
              ? <><PinOff aria-hidden="true" size={16} /> Unpin</>
              : <><Pin aria-hidden="true" size={16} /> Pin</>}
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => onMarkUnread(workstream)}>
            <EyeOff aria-hidden="true" size={16} /> Mark as unread
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => onRename(workstream)}>
            <Pencil aria-hidden="true" size={16} /> Rename
          </ContextMenu.Item>
          {projects.length > 0 && (
            <ContextNestedMenu
              icon={<FileStack aria-hidden="true" size={16} />}
              label="Add to project"
              options={projects.map((project) => {
                const selected = project.workstreamIds.includes(workstream.id);
                return {
                  id: project.id,
                  label: project.name,
                  icon: <ProjectIcon project={project} />,
                  selected,
                  ...(!selected ? { onSelect: () => onAddToProject(project.id, workstream.id) } : {}),
                };
              })}
            />
          )}
          {/* Named for the state it moves to, the way the note item is. Private
              is not ownership: everyone left in the work stream can still read
              it, write to it, and bring somebody else in. */}
          {scopeIsThisRowsToDecide && (
            <ContextMenu.Item
              className="menu-item"
              disabled={scopePending}
              onSelect={() => onChangeScope(workstream, isPrivate ? 'workspace' : 'personal')}
            >
              {isPrivate
                ? <><Globe2 aria-hidden="true" size={16} /> Make public to workspace</>
                : <><IconLock aria-hidden="true" size={16} stroke={1.8} /> Make private</>}
            </ContextMenu.Item>
          )}
          {debugEnabled && <CopyWorkstreamLinkItem workstreamId={workstream.id} />}
          <ContextMenu.Separator className="menu-separator" />
          {/* Names its noun, as every other destructive item in these menus
              does — "Archive note", "Archive draft", "Delete automation". A
              bare "Archive" under Mark as unread and Rename reads as archiving
              the messages rather than removing the work stream from everyone's
              sidebar for good. */}
          <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => onArchive(workstream)}>
            <Archive aria-hidden="true" size={16} /> Archive work stream
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The one "only you can see this" marker in the sidebar. Notes wear it when
 * their scope is personal; a system work stream wears it because nobody but its
 * participant can open it. Same badge either way — a reader should not have to
 * learn two ways of being told the same thing.
 */
function PrivacyMarker({ label }: { label: string }): React.JSX.Element {
  return (
    <span aria-label={label} className="sidebar-note-privacy" role="img">
      <IconLock aria-hidden="true" size={15} stroke={1.8} />
    </span>
  );
}

function NoteRow({
  commandShortcut,
  commandShortcutsVisible,
  debugEnabled,
  note,
  ownedByViewer,
  scopePending,
  onArchive,
  onChangeScope,
}: {
  commandShortcut?: number;
  commandShortcutsVisible?: boolean;
  debugEnabled: boolean;
  note: NoteSummary;
  ownedByViewer: boolean;
  scopePending: boolean;
  onArchive: (note: NoteSummary) => void;
  onChangeScope: (note: NoteSummary, scope: 'personal' | 'workspace') => void;
}): React.JSX.Element {
  const isPrivate = note.scope === 'personal';
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="sidebar-context-target">
          <NavLink
            aria-keyshortcuts={commandShortcut === undefined ? undefined : `Meta+${commandShortcut}`}
            className={({ isActive }) => clsx('sidebar-row note-row', isActive && 'is-active')}
            onClick={() => markSurfaceEntrypoint('sidebar_note')}
            to={`/notes/${note.id}`}
          >
            <span className="sidebar-row-icon">
              <span aria-label="Note" className="sidebar-note-marker" role="img">
                <NotebookText aria-hidden="true" size={15} strokeWidth={1.8} />
              </span>
            </span>
            <span className="sidebar-row-main">
              <span className="sidebar-row-title">{note.title}</span>
            </span>
            {note.scope === 'personal' && <PrivacyMarker label="Private note" />}
            <CommandShortcutHint shortcut={commandShortcut} visible={commandShortcutsVisible} />
          </NavLink>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          {/* A workspace note stays in everyone's sidebar, but only its owner
              can change or archive it, so the row offers both actions without
              pretending either would succeed for a reader. The visibility item
              names the state it moves to rather than the current one. */}
          <ContextMenu.Item
            className="menu-item"
            disabled={!ownedByViewer || scopePending}
            onSelect={() => onChangeScope(note, isPrivate ? 'workspace' : 'personal')}
          >
            {isPrivate
              ? <><Globe2 aria-hidden="true" size={16} /> Make public to workspace</>
              : <><IconLock aria-hidden="true" size={16} stroke={1.8} /> Make private</>}
          </ContextMenu.Item>
          {debugEnabled && (
            <CopyResourceIdItem contentType="note_id" id={note.id} label="Copy note id" resourceType="note" />
          )}
          <ContextMenu.Separator className="menu-separator" />
          {/* Archiving a note the meeting window is still recording into would
              fail that window's next segment save — the recording continues
              with nothing being persisted — so the action waits for the
              recording to end. */}
          <ContextMenu.Item
            className="menu-item menu-item-danger"
            disabled={!ownedByViewer || note.recordingStatus === 'recording'}
            onSelect={() => onArchive(note)}
          >
            <Archive aria-hidden="true" size={16} /> Archive note
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The pinned work streams, in the order to render them.
 *
 * `pinPosition` is the server's answer and the only order that survives a
 * reload. `dragOrder` is the arrangement a drag is currently building, and wins
 * while it exists so rows move under the pointer rather than after the round
 * trip. Ids in `dragOrder` that are no longer pinned — unpinned in another
 * window mid-drag — drop out, and anything pinned that the drag never saw is
 * appended, so the section always shows every pin exactly once.
 */
export function orderPinnedWorkstreams(
  workstreams: WorkstreamSummary[],
  dragOrder: string[] | null,
): WorkstreamSummary[] {
  const pinned = workstreams
    .filter((workstream) => workstream.pinPosition !== null)
    // The id breaks a tie the way both server readers do. Positions are unique
    // today, so this cannot fire — it is here because "readers of this list
    // agree on the order" is stated as an invariant, and a third reader that
    // fell back to arrival order would be the one place it was not true.
    .sort((left, right) =>
      (left.pinPosition ?? 0) - (right.pinPosition ?? 0) || left.id.localeCompare(right.id));
  if (dragOrder === null) return pinned;
  const byId = new Map(pinned.map((workstream) => [workstream.id, workstream]));
  const dragged = dragOrder.flatMap((id) => byId.get(id) ?? []);
  const seen = new Set(dragged.map((workstream) => workstream.id));
  return [...dragged, ...pinned.filter((workstream) => !seen.has(workstream.id))];
}

/** `ids` with `id` lifted out and reinserted at `index`. */
function moveWithin(ids: string[], id: string, index: number): string[] {
  const without = ids.filter((candidate) => candidate !== id);
  const bounded = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, bounded), id, ...without.slice(bounded)];
}

export function Sidebar({
  workspace,
  automations,
  notes = [],
  projects = [],
  inactiveProjects = [],
  workstreams,
  loading,
  meetingRecordingAvailable = false,
  onArchiveNote,
  onArchiveWorkstream,
  onApplyWorkstreamBatch,
  onChangeNoteScope,
  onChangeWorkstreamScope,
  onDeleteAutomation,
  onMarkWorkstreamUnread,
  onPinWorkstream,
  onReorderPinnedWorkstreams,
  onRenameWorkstream,
  onRunAutomation,
  onOpenMeetingNotes,
  onPreviewWorkstreamBatch,
  onCreateProject = async () => {
    throw new Error('Project creation is unavailable.');
  },
  onAddWorkstreamToProject = async () => undefined,
  onReorderProjects = async () => undefined,
  onRestoreProject = async () => undefined,
  onSignOut,
  hasMoreWorkstreams = false,
  loadingMoreWorkstreams = false,
  onLoadMoreWorkstreams,
}: SidebarProps): React.JSX.Element {
  const debugEnabled = useDebugEnabled();
  const openDraftId = useOpenDraftId();
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const [resizing, setResizing] = useState(false);
  // The handle stands in the strip beside the sidebar rather than on its edge,
  // so the pointer's own position is not the sidebar's width. Holding the
  // difference from the moment of the grab keeps the edge from jumping out to
  // meet a pointer that grabbed the far side of the strip.
  const grabOffset = useRef(0);
  const [pointerNearEdge, setPointerNearEdge] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkstreamSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // The note actions and a work stream's visibility apply straight from the
  // menu, so a rejection has nowhere to land unless it is raised here: the row
  // simply stays as it was.
  const [menuError, setMenuError] = useState<{ copy: string; message: string; title: string } | null>(null);
  const [scopePendingNoteId, setScopePendingNoteId] = useState<string | null>(null);
  const [scopePendingWorkstreamId, setScopePendingWorkstreamId] = useState<string | null>(null);
  const [pinPendingWorkstreamId, setPinPendingWorkstreamId] = useState<string | null>(null);
  const [commandShortcutsVisible, setCommandShortcutsVisible] = useState(false);
  const commandHeld = useRef(false);
  // The work stream a pin or unpin has just moved, and which side of the
  // sidebar it was moved to, held until the list re-renders carrying that
  // change. Cleared the moment it is honoured, so a later render for any other
  // reason does not scroll the reader again.
  const [reveal, setReveal] = useState<{ id: string; pinned: boolean } | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  /**
   * Ask for the next page as the scroll approaches the end of the list.
   *
   * Guarded on both flags rather than only on the pointer position: a scroll
   * event fires for every frame of a flick, and the list is one cache entry
   * that a second request would append to twice. `fetchMore` is itself a no-op
   * without a cursor, so this is the cheap half of the same guard.
   */
  const loadMoreWhenNearBottom = useCallback((event: React.UIEvent<HTMLElement>): void => {
    if (!hasMoreWorkstreams || loadingMoreWorkstreams || !onLoadMoreWorkstreams) return;
    const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight > LOAD_MORE_DISTANCE) return;
    onLoadMoreWorkstreams();
  }, [hasMoreWorkstreams, loadingMoreWorkstreams, onLoadMoreWorkstreams]);
  // The arrangement being dragged, held only for as long as the drag lasts.
  // The list renders from it while it exists, so rows move under the pointer
  // before anything is sent; the server's answer replaces it when the drag
  // ends. `null` means the pinned list is showing what the server last said.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const draggingWorkstreamId = useRef<string | null>(null);
  const [archiveNoteTarget, setArchiveNoteTarget] = useState<NoteSummary | null>(null);
  const [archivingNote, setArchivingNote] = useState(false);
  const [archiveWorkstreamTarget, setArchiveWorkstreamTarget] = useState<WorkstreamSummary | null>(null);
  const [archivingWorkstream, setArchivingWorkstream] = useState(false);
  const [batchTarget, setBatchTarget] = useState<WorkstreamBatchTarget | null>(null);
  const [batchPreviewing, setBatchPreviewing] = useState(false);
  const [batchApplying, setBatchApplying] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchPreviewFailed, setBatchPreviewFailed] = useState(false);
  const batchPreviewGeneration = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<AutomationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Drafts are unfinished automations, so they sit under the ones that run
  // rather than interleaving with them by name. Among themselves they lead with
  // the one touched most recently, which is the draft still being worked on.
  const orderedAutomations = [
    ...automations.filter((automation) => automation.status !== 'draft'),
    ...automations
      .filter((automation) => automation.status === 'draft')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  ];
  // A pinned work stream leaves the recent list entirely rather than appearing
  // twice: the section it moves to is the one whose order the reader controls,
  // and a row in both places would take its order from whichever they saw last.
  // Two orders, and the difference between them is what a drop commits: the
  // one the server last confirmed, and the one the pointer is building on top
  // of it. Comparing a finished drag against the second would compare it with
  // itself and conclude nothing moved.
  const storedPinnedWorkstreams = useMemo(
    () => orderPinnedWorkstreams(workstreams, null),
    [workstreams],
  );
  const pinnedWorkstreams = useMemo(
    () => orderPinnedWorkstreams(workstreams, dragOrder),
    [dragOrder, workstreams],
  );
  const unpinnedWorkstreams = useMemo(
    () => workstreams.filter((workstream) => workstream.pinPosition === null),
    [workstreams],
  );
  const [groupedAtMs, setGroupedAtMs] = useState(() => Date.now());
  useEffect(() => {
    const now = new Date();
    const next = nextRecencyBoundary([
      ...unpinnedWorkstreams,
      ...notes,
    ], now);
    const timer = window.setTimeout(
      () => setGroupedAtMs(Date.now()),
      Math.max(1, next - now.getTime() + 1),
    );
    return () => window.clearTimeout(timer);
  }, [groupedAtMs, notes, unpinnedWorkstreams]);
  const groups = useMemo(() => {
    const groupedAt = new Date(groupedAtMs);
    return groupActivityItems<RecentSidebarItem>([
      ...unpinnedWorkstreams.map((workstream) => ({
        type: 'workstream' as const,
        id: `workstream:${workstream.id}`,
        lastActivityAt: workstream.lastActivityAt,
        workstream,
      })),
      ...notes.map((note) => ({
        type: 'note' as const,
        id: `note:${note.id}`,
        lastActivityAt: note.lastActivityAt,
        note,
      })),
    ], groupedAt);
  }, [groupedAtMs, notes, unpinnedWorkstreams]);

  // The visible destination order is one run: the reader's manually arranged
  // pins first, then recent work streams and notes in exactly the order the
  // recency groups render below. Automations and primary actions are outside
  // this run, so changing either section cannot shift a familiar destination.
  const recentItems = useMemo(() => groups.flatMap((group) => group.streams), [groups]);
  const commandShortcutTargets = useMemo(() => [
    ...pinnedWorkstreams.map((workstream) => ({
      id: `workstream:${workstream.id}`,
      path: `/workstreams/${workstream.id}`,
      destinationType: 'pinned_workstream' as const,
    })),
    ...recentItems.map((item) => ({
      id: item.id,
      path: item.type === 'note'
        ? `/notes/${item.note.id}`
        : `/workstreams/${item.workstream.id}`,
      destinationType: item.type === 'note' ? 'recent_note' as const : 'recent_workstream' as const,
    })),
  ].slice(0, COMMAND_SHORTCUT_LIMIT), [pinnedWorkstreams, recentItems]);
  const commandShortcutById = useMemo(
    () => new Map(commandShortcutTargets.map((target, index) => [target.id, index + 1])),
    [commandShortcutTargets],
  );

  // Command is both the reveal and the modifier: its keydown paints the first
  // nine hints, and a number pressed before it is released opens that row in
  // the pinned-then-recent run. Window blur clears the reveal because
  // Command+Tab takes focus away before this window can observe Command being
  // released.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Meta') {
        setCommandShortcutsVisible(true);
        if (!commandHeld.current) {
          commandHeld.current = true;
          reportTelemetryProductIntent({
            kind: 'command_shortcuts_revealed',
            availableCount: commandShortcutTargets.length,
          });
        }
        return;
      }
      const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
      // `code` follows the physical number row even on layouts where `key`
      // is a symbol, which is the row the visible 1–9 mapping describes.
      // A held digit repeats keydown, and reopening the same route on every
      // repeat would strand Back behind duplicate history entries. A modal is
      // likewise a boundary: its focused controls must not navigate the page
      // underneath it.
      if (
        !event.metaKey
        || event.repeat
        || digit === undefined
        || document.querySelector('[role="dialog"]')
      ) return;
      const target = commandShortcutTargets[Number(digit) - 1];
      if (!target) return;
      event.preventDefault();
      reportTelemetryProductIntent({
        kind: 'command_shortcut_used',
        shortcutNumber: Number(digit),
        destinationType: target.destinationType,
      });
      markSurfaceEntrypoint('command_shortcut');
      if (target.destinationType === 'pinned_workstream' || target.destinationType === 'recent_workstream') {
        markWorkstreamNavigation(
          target.id.slice('workstream:'.length),
          /^\/workstreams\/[^/]+$/u.test(location.pathname) && location.pathname !== target.path,
        );
      }
      navigate(target.path);
      setSidebarOpen(false);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Meta') {
        commandHeld.current = false;
        setCommandShortcutsVisible(false);
      }
    };
    const hide = (): void => {
      commandHeld.current = false;
      setCommandShortcutsVisible(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', hide);
    };
  }, [commandShortcutTargets, location.pathname, navigate, setSidebarOpen]);

  const openRename = (workstream: WorkstreamSummary): void => {
    setRenameTarget(workstream);
    setRenameTitle(workstream.title);
    setRenameError(null);
  };

  const closeDelete = (): void => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteError(null);
  };

  const submitDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteAutomation(deleteTarget);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'The automation could not be deleted.');
    } finally {
      setDeleting(false);
    }
  };

  const closeArchiveNote = (): void => {
    if (archivingNote) return;
    setArchiveNoteTarget(null);
  };

  // Archiving is not reversible from any surface yet, so it confirms and names
  // its target the way deleting an automation does, rather than firing straight
  // off a right-click that landed one row away from where it was aimed.
  const submitArchiveNote = async (): Promise<void> => {
    if (!archiveNoteTarget) return;
    setArchivingNote(true);
    try {
      await onArchiveNote(archiveNoteTarget);
      reportTelemetryProductIntent({
        kind: 'note_action_completed',
        noteId: archiveNoteTarget.id,
        action: 'archive',
        visibility: telemetryVisibility(archiveNoteTarget.scope),
        recordingState: archiveNoteTarget.recordingStatus,
      });
      setArchiveNoteTarget(null);
    } catch (error) {
      setArchiveNoteTarget(null);
      setMenuError({
        title: 'Note could not be archived',
        copy: 'The note is still in the sidebar. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The note could not be archived.',
      });
    } finally {
      setArchivingNote(false);
    }
  };

  const closeArchiveWorkstream = (): void => {
    if (archivingWorkstream) return;
    setArchiveWorkstreamTarget(null);
  };

  // Confirmed for the reason the note's archive is, with one more behind it: a
  // work stream is shared, so this takes it out of the sidebar of everybody in
  // it rather than only the reader who right-clicked. The row leaves through
  // the directory tombstone WorkstreamDO pushes, so there is nothing to patch
  // here — a failure means the row simply stayed, which is what the dialog on
  // the way out says.
  const submitArchiveWorkstream = async (): Promise<void> => {
    if (!archiveWorkstreamTarget) return;
    setArchivingWorkstream(true);
    try {
      await onArchiveWorkstream(archiveWorkstreamTarget);
      reportTelemetryProductIntent({
        kind: 'workstream_action_completed',
        workstreamId: archiveWorkstreamTarget.id,
        action: 'archive',
        visibility: telemetryVisibility(archiveWorkstreamTarget.scope),
        origin: archiveWorkstreamTarget.systemKind ? 'system' : archiveWorkstreamTarget.origin,
        pinned: archiveWorkstreamTarget.pinPosition !== null,
      });
      setArchiveWorkstreamTarget(null);
    } catch (error) {
      setArchiveWorkstreamTarget(null);
      setMenuError({
        title: 'Work stream could not be archived',
        copy: 'The work stream is still in the sidebar. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The work stream could not be archived.',
      });
    } finally {
      setArchivingWorkstream(false);
    }
  };

  const openWorkstreamBatch = (
    label: RecencyGroup,
    update: WorkstreamBatchUpdate,
    visibleCount: number,
  ): void => {
    const filter = recencyGroupBatchFilter(label, new Date());
    const generation = batchPreviewGeneration.current + 1;
    batchPreviewGeneration.current = generation;
    setBatchTarget({
      label,
      operationId: crypto.randomUUID(),
      filter,
      update,
      matchedCount: visibleCount,
    });
    setBatchPreviewing(true);
    setBatchError(null);
    setBatchPreviewFailed(false);
    void onPreviewWorkstreamBatch(filter).then((matchedCount) => {
      if (batchPreviewGeneration.current !== generation) return;
      setBatchTarget((current) => current ? { ...current, matchedCount } : null);
    }).catch((error: unknown) => {
      if (batchPreviewGeneration.current !== generation) return;
      setBatchPreviewFailed(true);
      setBatchError(error instanceof Error ? error.message : 'The work streams could not be counted.');
    }).finally(() => {
      if (batchPreviewGeneration.current === generation) setBatchPreviewing(false);
    });
  };

  const closeWorkstreamBatch = (): void => {
    if (batchApplying) return;
    batchPreviewGeneration.current += 1;
    setBatchTarget(null);
    setBatchError(null);
    setBatchPreviewFailed(false);
    setBatchPreviewing(false);
  };

  const submitWorkstreamBatch = async (): Promise<void> => {
    if (!batchTarget || batchPreviewing || batchTarget.matchedCount === 0) return;
    setBatchApplying(true);
    setBatchError(null);
    try {
      await onApplyWorkstreamBatch(
        batchTarget.operationId,
        batchTarget.filter,
        batchTarget.update,
      );
      setBatchTarget(null);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : 'The work streams could not be updated.');
    } finally {
      setBatchApplying(false);
    }
  };

  const changeNoteScope = async (note: NoteSummary, scope: 'personal' | 'workspace'): Promise<void> => {
    setScopePendingNoteId(note.id);
    try {
      await onChangeNoteScope(note, scope);
      reportTelemetryProductIntent({
        kind: 'note_action_completed',
        noteId: note.id,
        action: scope === 'workspace' ? 'make_public' : 'make_private',
        visibility: telemetryVisibility(scope),
        recordingState: note.recordingStatus,
      });
    } catch (error) {
      setMenuError({
        title: 'Note visibility could not be changed',
        copy: scope === 'workspace'
          ? 'The note is still private. Try again in a moment.'
          : 'The note is still public to the workspace. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The note could not be updated.',
      });
    } finally {
      setScopePendingNoteId((current) => current === note.id ? null : current);
    }
  };

  const changeWorkstreamScope = async (
    workstream: WorkstreamSummary,
    scope: 'personal' | 'workspace',
  ): Promise<void> => {
    setScopePendingWorkstreamId(workstream.id);
    try {
      await onChangeWorkstreamScope(workstream, scope);
      reportTelemetryProductIntent({
        kind: 'workstream_action_completed',
        workstreamId: workstream.id,
        action: scope === 'workspace' ? 'make_public' : 'make_private',
        visibility: telemetryVisibility(scope),
        origin: workstream.systemKind ? 'system' : workstream.origin,
        pinned: workstream.pinPosition !== null,
      });
    } catch (error) {
      setMenuError({
        title: 'Work stream visibility could not be changed',
        copy: scope === 'workspace'
          ? 'The work stream is still private. Try again in a moment.'
          : 'The work stream is still visible to the workspace. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The work stream could not be updated.',
      });
    } finally {
      setScopePendingWorkstreamId((current) => current === workstream.id ? null : current);
    }
  };

  const togglePin = async (workstream: WorkstreamSummary, pinned: boolean): Promise<void> => {
    setPinPendingWorkstreamId(workstream.id);
    try {
      // The row has just moved to a different section, which is off screen
      // whenever the reader had scrolled down to reach it — the ordinary case,
      // since being tired of hunting for something is why anyone pins it. Left
      // alone, the action reads as the row vanishing under the cursor.
      //
      // Only when this response is the one that took the list, though. Two pins
      // made close together resolve in either order, and the older one landing
      // last would otherwise drag the viewport back to the row the reader has
      // already finished with.
      if (await onPinWorkstream(workstream, pinned)) {
        setReveal({ id: workstream.id, pinned });
        reportTelemetryProductIntent({
          kind: 'workstream_action_completed',
          workstreamId: workstream.id,
          action: pinned ? 'pin' : 'unpin',
          visibility: telemetryVisibility(workstream.scope),
          origin: workstream.systemKind ? 'system' : workstream.origin,
          pinned,
        });
      }
    } catch (error) {
      setMenuError({
        title: pinned ? 'Work stream could not be pinned' : 'Work stream could not be unpinned',
        copy: pinned
          ? 'The work stream is still in the recent list. Try again in a moment.'
          : 'The work stream is still pinned. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The work stream could not be updated.',
      });
    } finally {
      setPinPendingWorkstreamId((current) => current === workstream.id ? null : current);
    }
  };

  const markWorkstreamUnread = async (workstream: WorkstreamSummary): Promise<void> => {
    await onMarkWorkstreamUnread(workstream);
    reportTelemetryProductIntent({
      kind: 'workstream_action_completed',
      workstreamId: workstream.id,
      action: 'mark_unread',
      visibility: telemetryVisibility(workstream.scope),
      origin: workstream.systemKind ? 'system' : workstream.origin,
      pinned: workstream.pinPosition !== null,
    });
  };

  // A dropped arrangement is sent whole. If the server refuses it, the local
  // order is dropped rather than kept: the section then shows what the server
  // actually holds, which is the order the reader's other devices are showing.
  const commitPinnedOrder = async (order: string[]): Promise<void> => {
    setDragOrder(order);
    try {
      await onReorderPinnedWorkstreams(order);
    } catch (error) {
      setMenuError({
        title: 'Pinned work streams could not be reordered',
        copy: 'The pinned list is back in the order it was in. Try again in a moment.',
        message: error instanceof Error ? error.message : 'The pinned order could not be saved.',
      });
    } finally {
      // Only if this call's arrangement is still the one on screen. Two moves
      // in quick succession overlap, and clearing unconditionally would let the
      // first response snap the list back to an order the second has already
      // moved past — visibly, and for as long as the second request takes.
      setDragOrder((current) => current === order ? null : current);
    }
  };

  const pinnedRowDrag = (workstream: WorkstreamSummary, index: number): PinnedRowDrag => ({
    dragging: draggingWorkstreamId.current === workstream.id && dragOrder !== null,
    position: `Pinned, ${index + 1} of ${pinnedWorkstreams.length}.`,
    onDragStart: (target) => {
      draggingWorkstreamId.current = target.id;
      setDragOrder(pinnedWorkstreams.map((pinned) => pinned.id));
    },
    onDragOver: (target) => {
      const draggingId = draggingWorkstreamId.current;
      if (draggingId === null || draggingId === target.id) return;
      setDragOrder((current) => {
        const order = current ?? pinnedWorkstreams.map((pinned) => pinned.id);
        const targetIndex = order.indexOf(target.id);
        if (targetIndex < 0 || order.indexOf(draggingId) === targetIndex) return order;
        return moveWithin(order, draggingId, targetIndex);
      });
    },
    onDragEnd: (cancelled) => {
      const order = dragOrder;
      draggingWorkstreamId.current = null;
      if (order === null) return;
      // `dragend` fires whatever ended the drag. Escape, or a release outside
      // the pinned list, leaves `dropEffect` at `none` — and the arrangement
      // built while the pointer passed over other rows must be abandoned, not
      // saved, or backing out of a drag becomes the same thing as finishing it.
      // An unchanged arrangement is likewise not worth rewriting every position
      // for.
      if (cancelled || order.join() === storedPinnedWorkstreams.map((pinned) => pinned.id).join()) {
        setDragOrder(null);
        return;
      }
      void commitPinnedOrder(order);
    },
    onMove: (target, direction) => {
      const order = pinnedWorkstreams.map((pinned) => pinned.id);
      const from = order.indexOf(target.id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= order.length) return;
      void commitPinnedOrder(moveWithin(order, target.id, to));
    },
  });

  const closeRename = (): void => {
    if (renaming) return;
    setRenameTarget(null);
    setRenameError(null);
  };

  const submitRename = async (): Promise<void> => {
    const title = renameTitle.trim();
    if (!renameTarget || !title || title === renameTarget.title) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await onRenameWorkstream(renameTarget, title);
      reportTelemetryProductIntent({
        kind: 'workstream_action_completed',
        workstreamId: renameTarget.id,
        action: 'rename',
        visibility: telemetryVisibility(renameTarget.scope),
        origin: renameTarget.systemKind ? 'system' : renameTarget.origin,
        pinned: renameTarget.pinPosition !== null,
      });
      setRenameTarget(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : 'The work stream could not be renamed.');
    } finally {
      setRenaming(false);
    }
  };

  // The pill is revealed by how close the pointer is to the edge, not by
  // hovering the handle: a hit area wide enough to be a 20-pixel proximity
  // sensor would also be a 20-pixel column of the main pane that swallows
  // clicks, the window-drag region, and the left edge of the title. Watching
  // the pointer instead keeps the reveal generous and the hit area honest.
  useEffect(() => {
    const track = (event: PointerEvent): void => {
      const near = Math.abs(event.clientX - sidebarWidth) <= EDGE_REVEAL_DISTANCE;
      setPointerNearEdge((current) => current === near ? current : near);
    };
    window.addEventListener('pointermove', track);
    return () => window.removeEventListener('pointermove', track);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizing) return undefined;

    const move = (event: PointerEvent): void => setSidebarWidth(event.clientX - grabOffset.current);
    const stop = (): void => setResizing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, [resizing, setSidebarWidth]);

  // Waits for the list itself to carry the change before chasing the row.
  //
  // The request resolving is not the row moving: the cache write that follows
  // it reaches this component through React Query's own scheduler, a tick or
  // more after the state set here. Scrolling on the first render after the
  // await therefore finds the row still sitting in the section it is leaving,
  // scrolls to *that*, and is left pointing at empty space the moment the real
  // update lands — which is exactly the failure this whole effect exists to
  // prevent, reintroduced one render earlier. Comparing against the pinned-ness
  // the action asked for is what makes "has the list caught up yet" answerable.
  // Gives up on a reveal the list never honoured. Re-armed with the reveal, so
  // the clock runs from the action rather than from any render after it.
  useEffect(() => {
    if (reveal === null) return undefined;
    const timer = setTimeout(() => setReveal(null), REVEAL_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [reveal]);

  useEffect(() => {
    if (reveal === null) return;
    const row = workstreams.find((workstream) => workstream.id === reveal.id);
    // A row the list does not carry at all is not one that is about to arrive:
    // every path that arms this acts on a row the reader just right-clicked.
    // Waiting for it would leave the reveal armed indefinitely, ready to seize
    // the viewport if that work stream ever reappeared.
    if (row === undefined) {
      setReveal(null);
      return;
    }
    if ((row.pinPosition !== null) !== reveal.pinned) return;
    setReveal(null);
    // Ids are server-generated UUIDs, so they need no escaping in a selector.
    const rendered = scrollRef.current?.querySelector(`[data-workstream-id="${reveal.id}"]`);
    // Unpinning something the recent list does not carry leaves nothing to
    // scroll to, which is a no-op rather than a case to handle.
    rendered?.scrollIntoView?.({
      // `nearest` is what keeps this from being an interruption: a row already
      // on screen — a short sidebar, or a pin made from near the top — is not
      // scrolled at all.
      block: 'nearest',
      // Motion is the point, since it is what lets the reader follow the row to
      // its new section rather than hunt for it, so it is dropped only for
      // someone who has asked for less of it.
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    // Focus is where a keyboard reader *is*, and the two sections are separate
    // subtrees, so the row is unmounted and remounted as it moves and Radix's
    // restore on menu close has nothing left to restore to — focus lands on the
    // body and the next Tab starts again from the top of the window. Scrolling
    // alone therefore follows the row for the pointer half of the audience and
    // abandons the half with the least other way to find it again.
    //
    // Only when focus was lost, which is precisely the case this repairs. Focus
    // resting anywhere real — a composer, a dialog, another list — belongs to
    // whoever put it there, and a pin is not a reason to take it.
    if (document.activeElement === null || document.activeElement === document.body) {
      // The scroll above already put the row where it belongs; letting focus
      // scroll again would fight it, and would undo `nearest` besides.
      rendered?.querySelector('a')?.focus({ preventScroll: true });
    }
  }, [reveal, workstreams]);

  return (
    <>
      <IconButton className="mobile-sidebar-trigger" label="Open navigation" onClick={() => setSidebarOpen(true)}>
        <Menu size={17} />
      </IconButton>
      {sidebarOpen && <button aria-label="Close navigation" className="sidebar-scrim" onClick={() => setSidebarOpen(false)} type="button" />}
      <aside aria-label="Rally navigation" className={clsx('sidebar', sidebarOpen && 'is-mobile-open', resizing && 'is-resizing')}>
        <div className="sidebar-titlebar window-drag">
          <IconButton className="window-no-drag mobile-only" label="Close navigation" onClick={() => setSidebarOpen(false)}>
            <ChevronsLeft size={16} />
          </IconButton>
        </div>

        <nav
          className="sidebar-scroll"
          onClick={() => setSidebarOpen(false)}
          onScroll={loadMoreWhenNearBottom}
          ref={scrollRef}
        >
          <div className="sidebar-primary-actions">
            <NavLink
              className={({ isActive }) => clsx('sidebar-action', isActive && 'is-active')}
              onClick={() => markSurfaceEntrypoint('sidebar_new')}
              to="/workstreams/new"
            >
              <MessageSquarePlus aria-hidden="true" size={15} />
              <span>New work stream</span>
            </NavLink>
            {/* Reopening a draft lands on this same path, where the active row
                is the draft's own. Two entries lit at once would say the screen
                is both a new automation and that one. */}
            <NavLink
              className={({ isActive }) => clsx('sidebar-action', isActive && openDraftId === null && 'is-active')}
              onClick={() => markSurfaceEntrypoint('sidebar_new')}
              to="/automations/new"
            >
              <Plus aria-hidden="true" size={15} />
              <span>New automation</span>
            </NavLink>
            {meetingRecordingAvailable && (
              <button className="sidebar-action" onClick={() => void onOpenMeetingNotes()} type="button">
                <Mic2 aria-hidden="true" size={15} />
                <span>New meeting/notes</span>
              </button>
            )}
          </div>

          <ProjectSidebarSection
            inactiveProjects={inactiveProjects}
            loading={loading === true}
            onAddWorkstream={onAddWorkstreamToProject}
            onCreate={onCreateProject}
            onReorder={onReorderProjects}
            onRestore={onRestoreProject}
            projects={projects}
            workstreams={workstreams}
          />

          <section className="sidebar-section" aria-labelledby="automations-heading">
            <div className="sidebar-section-heading">
              <h2 id="automations-heading">Automations</h2>
            </div>
            {loading && automations.length === 0 ? (
              <SidebarSkeletonRows count={3} />
            ) : automations.length === 0 ? (
              <p className="sidebar-empty">No active automations</p>
            ) : (
              <div className="sidebar-list">
                {orderedAutomations.map((automation) => (
                  <AutomationRow
                    automation={automation}
                    debugEnabled={debugEnabled}
                    key={automation.id}
                    onDelete={setDeleteTarget}
                    onRunNow={(target) => {
                      void onRunAutomation(target)
                        .catch(() => undefined);
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Only when something is pinned. An empty heading would be a
              standing invitation to a feature the reader has not used, sitting
              above the work they came here for. */}
          {pinnedWorkstreams.length > 0 && (
            // The whole section is the drop target, heading included. A release
            // anywhere a reader would call "inside the list they are arranging"
            // has to count as a drop: `dragend` reads a release nothing accepted
            // as a cancellation, so a gap between two rows — or the strip of
            // heading a few pixels above the first one — would silently throw
            // the arrangement away.
            <section
              aria-describedby={PINNED_DRAG_HINT_ID}
              aria-labelledby="pinned-heading"
              className="sidebar-section pinned-section"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => event.preventDefault()}
            >
              <div className="sidebar-section-heading">
                <h2 id="pinned-heading">Pinned</h2>
              </div>
              {/* Said once for the section rather than repeated on every row:
                  as a per-row description it lands inside each link's
                  accessible name, so somebody arrowing through the list hears
                  the whole instruction again before every title. */}
              <p className="sr-only" id={PINNED_DRAG_HINT_ID}>
                Hold Alt and press the up or down arrow to move a pinned work stream.
              </p>
              <div className="sidebar-list">
                {pinnedWorkstreams.map((pinned, index) => (
                  <WorkstreamRow
                    commandShortcut={commandShortcutById.get(`workstream:${pinned.id}`)}
                    commandShortcutsVisible={commandShortcutsVisible}
                    debugEnabled={debugEnabled}
                    drag={pinnedRowDrag(pinned, index)}
                    key={pinned.id}
                    onArchive={setArchiveWorkstreamTarget}
                    onChangeScope={(target, scope) => void changeWorkstreamScope(target, scope)}
                    onMarkUnread={(target) => void markWorkstreamUnread(target).catch(() => undefined)}
                    onAddToProject={(projectId, workstreamId) => void onAddWorkstreamToProject(projectId, workstreamId)}
                    onRename={openRename}
                    onTogglePin={(target, pin) => void togglePin(target, pin)}
                    pinPending={pinPendingWorkstreamId === pinned.id}
                    projects={projects}
                    scopePending={scopePendingWorkstreamId === pinned.id}
                    workstream={pinned}
                  />
                ))}
              </div>
            </section>
          )}

          <section aria-label="Work streams" className="sidebar-section workstreams-section">
            {loading && workstreams.length === 0 && notes.length === 0 ? (
              // The one announcement for the whole wait. The automations above
              // are loading from the same answer and finish with these, so a
              // second live region would say the same thing twice.
              <div role="status">
                <span className="sr-only">Loading your work streams, automations and notes</span>
                <SidebarSkeletonGroup count={4} />
                <SidebarSkeletonGroup count={3} />
              </div>
            ) : groups.length === 0 ? (
              // Pinned work streams are work streams, so the empty line only
              // holds when nothing is pinned either; with everything pinned the
              // section has nothing left to say and says nothing.
              pinnedWorkstreams.length === 0 && <p className="sidebar-empty">No work streams or notes yet</p>
            ) : (
              groups.map((group) => (
                <div className="sidebar-group" key={group.label}>
                  <div className="sidebar-group-heading">
                    <h3>{group.label}</h3>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          aria-label={`${group.label} actions`}
                          className="sidebar-group-menu-trigger window-no-drag"
                          type="button"
                        >
                          <IconDots aria-hidden="true" size={16} stroke={1.8} />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          className="menu-content"
                          side="bottom"
                          sideOffset={4}
                        >
                          <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => openWorkstreamBatch(
                              group.label,
                              { kind: 'mark_read' },
                              group.streams.filter((item) => item.type === 'workstream').length,
                            )}
                          >
                            Mark all as read
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="menu-item menu-item-danger"
                            onSelect={() => openWorkstreamBatch(
                              group.label,
                              { kind: 'archive' },
                              group.streams.filter((item) => item.type === 'workstream').length,
                            )}
                          >
                            Archive all
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                  <div className="sidebar-list">
                    {group.streams.map((item) => item.type === 'note' ? (
                      <NoteRow
                        commandShortcut={commandShortcutById.get(item.id)}
                        commandShortcutsVisible={commandShortcutsVisible}
                        debugEnabled={debugEnabled}
                        key={item.id}
                        note={item.note}
                        onArchive={setArchiveNoteTarget}
                        onChangeScope={(target, scope) => void changeNoteScope(target, scope)}
                        ownedByViewer={item.note.ownerUserId === workspace.currentUser.id}
                        scopePending={scopePendingNoteId === item.note.id}
                      />
                    ) : (
                      <WorkstreamRow
                        commandShortcut={commandShortcutById.get(item.id)}
                        commandShortcutsVisible={commandShortcutsVisible}
                        debugEnabled={debugEnabled}
                        key={item.id}
                        onArchive={setArchiveWorkstreamTarget}
                        onChangeScope={(target, scope) => void changeWorkstreamScope(target, scope)}
                        onMarkUnread={(target) => void markWorkstreamUnread(target).catch(() => undefined)}
                        onAddToProject={(projectId, workstreamId) => void onAddWorkstreamToProject(projectId, workstreamId)}
                        onRename={openRename}
                        onTogglePin={(target, pin) => void togglePin(target, pin)}
                        pinPending={pinPendingWorkstreamId === item.workstream.id}
                        projects={projects}
                        scopePending={scopePendingWorkstreamId === item.workstream.id}
                        workstream={item.workstream}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
            {/* Only while a page is actually in flight. A permanent "scroll for
                more" would claim the list is incomplete every time it happens
                to end exactly on a page boundary. */}
            {loadingMoreWorkstreams && (
              <p aria-live="polite" className="sidebar-empty">Loading more…</p>
            )}
          </section>
        </nav>

        {/*
          OnboardingChecklist is disabled: it was left over from a demo and
          never wired to real product state. `completed` is local-only
          `useState`, seeded empty on every mount and never persisted, so the
          "3 / 3" a user sees is just three checkboxes they clicked themselves
          in the current session — there is no dismiss action because the box
          was never meant to reflect (or need clearing based on) anything
          real. Reported (Aug 2026) as blocking the chat input with no way to
          close it even at "3 / 3"; Morgan Ellis confirmed this is dead demo
          code, not a real feature.

          To bring this back for real: replace `completed` with derived state
          from actual signals (a connected tool/integration exists, an
          automation has been created, a teammate has been invited), and add
          a dismiss mechanism (e.g. a persisted "onboarding dismissed" flag)
          once those signals exist — a checklist that can reach 3/3 has to be
          closeable.
        */}
        {/* <OnboardingChecklist /> */}

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="account-trigger window-no-drag" type="button">
              <Avatar member={workspace.currentUser} size="small" />
              <span className="account-copy">
                <strong>{workspace.currentUser.name}</strong>
                <span>{workspace.name}</span>
              </span>
              <ChevronDown aria-hidden="true" size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" className="menu-content" side="top" sideOffset={8}>
              <DropdownMenu.Label className="menu-label">
                <span>{workspace.currentUser.email}</span>
                <small>{workspace.region === 'eu' ? 'European Union' : 'Global'} workspace</small>
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item asChild className="menu-item">
                <button onClick={() => void desktopBridge().openSettings()} type="button">
                  <Settings size={14} /> Settings…
                </button>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>
                <LogOut size={14} /> Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <div
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className={clsx('sidebar-resizer', pointerNearEdge && 'is-near')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setSidebarWidth(sidebarWidth - 16);
            if (event.key === 'ArrowRight') setSidebarWidth(sidebarWidth + 16);
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            grabOffset.current = event.clientX - sidebarWidth;
            setResizing(true);
          }}
          role="separator"
          tabIndex={0}
        >
          <span />
        </div>
      </aside>
      <Modal
        footer={(
          <>
            <Button disabled={renaming} onClick={closeRename}>Cancel</Button>
            <Button
              className="button-primary"
              disabled={renaming || !renameTitle.trim() || renameTitle.trim() === renameTarget?.title}
              onClick={() => void submitRename()}
            >
              Rename
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
        open={Boolean(renameTarget)}
        title="Rename work stream"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <label className="form-field rename-workstream-field">
            <span>Name</span>
            <input
              aria-label="Work stream name"
              autoFocus
              maxLength={180}
              onChange={(event) => setRenameTitle(event.currentTarget.value)}
              value={renameTitle}
            />
          </label>
        </form>
        {renameError && <InlineError>{renameError}</InlineError>}
      </Modal>
      <Modal
        footer={(
          <>
            <Button disabled={archivingNote} onClick={closeArchiveNote}>Cancel</Button>
            <Button className="button-danger" disabled={archivingNote} onClick={() => void submitArchiveNote()}>
              Archive
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeArchiveNote();
        }}
        open={Boolean(archiveNoteTarget)}
        title="Archive note"
      >
        <p className="modal-copy">
          <strong>{archiveNoteTarget?.title}</strong> leaves the sidebar, stops being offered as a
          resource, and stops reaching the agent. Its transcript is kept, but Rally has no way to
          bring the note back yet.
        </p>
      </Modal>
      <Modal
        footer={(
          <>
            <Button disabled={batchApplying} onClick={closeWorkstreamBatch}>Cancel</Button>
            <Button
              className={batchTarget?.update.kind === 'archive' ? 'button-danger' : 'button-primary'}
              disabled={batchApplying || batchPreviewing || batchPreviewFailed || batchTarget?.matchedCount === 0}
              onClick={() => void submitWorkstreamBatch()}
            >
              Continue
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeWorkstreamBatch();
        }}
        open={Boolean(batchTarget)}
        title={batchTarget?.update.kind === 'archive' ? 'Archive all' : 'Mark all as read'}
      >
        <p className="modal-copy">
          This is a mass change. {batchTarget?.matchedCount ?? 0}{' '}
          {(batchTarget?.matchedCount ?? 0) === 1 ? 'work stream' : 'work streams'} in{' '}
          <strong>{batchTarget?.label}</strong> will be{' '}
          {batchTarget?.update.kind === 'archive' ? 'archived' : 'marked as read'}. Are you sure?
        </p>
        {batchPreviewing && <p aria-live="polite" className="modal-copy">Checking the current total…</p>}
        {batchError && <InlineError>{batchError}</InlineError>}
      </Modal>
      <Modal
        footer={(
          <>
            <Button disabled={archivingWorkstream} onClick={closeArchiveWorkstream}>Cancel</Button>
            <Button
              className="button-danger"
              disabled={archivingWorkstream}
              onClick={() => void submitArchiveWorkstream()}
            >
              Archive
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeArchiveWorkstream();
        }}
        open={Boolean(archiveWorkstreamTarget)}
        title="Archive work stream"
      >
        <p className="modal-copy">
          <strong>{archiveWorkstreamTarget?.title}</strong> leaves the sidebar for everyone who can
          see it, and nobody — you included — will be able to open it again. A run still in flight
          is stopped, scheduled follow-ups stop, and mail to its address is refused. Nothing is
          deleted, but Rally has no way to bring a work stream back.
        </p>
      </Modal>
      <Modal
        footer={<Button onClick={() => setMenuError(null)}>Close</Button>}
        onOpenChange={(open) => {
          if (!open) setMenuError(null);
        }}
        open={Boolean(menuError)}
        title={menuError?.title ?? 'That could not be updated'}
      >
        <p className="modal-copy">{menuError?.copy}</p>
        {menuError && <InlineError>{menuError.message}</InlineError>}
      </Modal>
      <Modal
        footer={(
          <>
            <Button disabled={deleting} onClick={closeDelete}>Cancel</Button>
            <Button className="button-danger" disabled={deleting} onClick={() => void submitDelete()}>
              Delete
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
        open={Boolean(deleteTarget)}
        title={deleteTarget?.status === 'draft' ? 'Delete draft' : 'Delete automation'}
      >
        <p className="modal-copy">
          {deleteTarget?.status === 'draft' ? (
            <>
              <strong>{deleteTarget.name}</strong> and the conversation that was writing it are
              deleted for good. Rally has no way to bring a draft back.
            </>
          ) : (
            <>
              {/* What the API does, rather than the reassurance this
                  said before it: deleting enqueues an archive for
                  every work stream the automation's runs created, so
                  the runs leave with it. */}
              <strong>{deleteTarget?.name}</strong> stops running and leaves the sidebar for good.
              Every past run — and the work stream each one created — is archived with it, and
              Rally has no way to bring them back.
            </>
          )}
        </p>
        {deleteError && <InlineError>{deleteError}</InlineError>}
      </Modal>
    </>
  );
}
