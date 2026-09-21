import { ShareConversationDialog } from './scope-sharing-panel';
import { useOptionalCollaborationSession } from '../lib/collaboration-session';
import { IconShare2 } from '@tabler/icons-react';
import { NavigationFrame, NavigationRowContent } from '@rally/ui/components/navigation';
import { SpaceIcon } from '@rally/ui/components/space-appearance-picker';
import { NewWorkstreamMenu } from './new-workstream-menu';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ContainerOrder, CreateSpaceRequest, PersonalOrder, SpaceSummary, WorkstreamBatchFilter, WorkstreamBatchUpdate } from '@rally/contracts';
import { IconDots } from '@tabler/icons-react';
import clsx from 'clsx';
import { Archive, ChevronsLeft, Check, CircleHelp, Clock, Cog, Copy, EyeOff, FolderMinus, FolderPlus, Globe2, GripVertical, Info, LogOut, Megaphone, Menu, Pencil, Pin, PinOff, Plus, PanelLeftClose, PanelLeftOpen, Settings, Smartphone } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TransitionEvent } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { NEW_SIDEKICK_TARGET } from '../../common/sidekicks';
import { copyWorkstreamLink } from '../lib/copy-workstream-link';
import { compareWorkstreamRecency, formatDateTime, formatTime, groupActivityItems, nextRecencyBoundary, recencyGroupBatchFilter, workstreamMarkerStatus, type RecencyGroup, workstreamRecencyAt } from '../lib/format';
import { layoutRowAt } from '../lib/list-motion';
import { committedOrder, moveWithin, orderByStoredIds, storedOrderFor } from '../lib/personal-order';
import { useNamingSkeleton } from '../lib/naming-skeleton';
import { desktopBridge } from '../lib/platform';
import { markSurfaceEntrypoint, markWorkstreamFeedOpenStarted, markWorkstreamNavigation, reportTelemetryProductIntent, telemetryVisibility } from '../lib/telemetry';
import { spaceFailureOf, spaceFailureSentence } from '../lib/space-failure-copy';
import type { AutomationSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { COLLAPSED_SIDEBAR_WIDTH, EXPANDED_SPACES_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_EXPAND_DRAG_THRESHOLD, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { useListMotion } from '../lib/use-list-motion';
import { hasUserInputSinceWindowActivation, useWindowDeactivated } from '../lib/window-activation';
import { useWorkstreamSocketHoverWarmup, useWorkstreamSocketOpenContext } from '../lib/workstream-socket-pool';
import { Avatar, Button, DragHint, IconButton, InlineError, Modal, StatusDot, Tip } from './primitives';
import { ManageAccessDialog } from './manage-access-dialog';
import { ContextNestedMenu } from './nested-menu';
import { SpacesSidebar } from './spaces-sidebar';
import { RelativeTime } from './relative-time';
import { SidebarSearch } from './sidebar-search';
import { SidebarSkeletonGroup } from './sidebar-skeleton';
import { AutomationGlyph, HexagonGlyph, SIDEKICK_RUNNING_MARKER, WorkstreamGlyph } from './workstream-glyph';

interface SidebarProps {
  onOpenSearch?: () => void;
  /** GrokBot-style shell: work streams and active standalone Sidekick shortcuts. */
  conversationOnly?: boolean;
  /** The responsive or manually selected GrokBot icon rail. */
  compact?: boolean;
  /**
   * True while the window is too narrow to hold the expanded sidebar, whatever
   * the saved preference says. It cannot be recovered from `compact`, which is
   * `collapsed || constrained` and so reads the same for a sidebar the reader
   * collapsed as for one the window is pinning; somebody who did both is held
   * by the window, and expanding is impossible until it widens.
   */
  constrained?: boolean;
  workspace: Workspace;
  /**
   * Every Sidekick the person can see, or `undefined` while the workspace
   * answer that carries them has not arrived.
   *
   * The distinction is the prop's to carry rather than a caller's to remember:
   * an empty array means an empty workspace, and that is what the strip offers
   * to make the first Sidekick from. Collapsing the two at the call site with
   * `?? []` is what made a separate loading flag necessary, and a flag a caller
   * can forget is a flag that reads "empty workspace" on a cold sidebar.
   */
  automations: AutomationSummary[] | undefined;
  /**
   * The active Space directory, or absent for a host with no Space navigation.
   *
   * Absent is not empty: an empty directory is an Organization whose Spaces
   * have not been made yet, which still has a **Spaces** heading and a **New
   * space**. No directory at all is the guest shell, where Space discovery is
   * deferred — the host decides that, per the PRD's design decision 9, rather
   * than this component inferring it from a refusal.
   */
  spaces?: SpaceSummary[];
  /** Controlled by the shell so responsive geometry reads the rail on screen. */
  spacesCollapsed?: boolean;
  onSpacesCollapsedChange?: (collapsed: boolean) => void;
  inactiveSpaces?: SpaceSummary[];
  /** False while the Organization has not finished its one-time cutover. */
  spacesReady?: boolean;
  /** The Space directory on screen is the last one the socket delivered. */
  spacesOutOfDate?: boolean;
  onRetrySpaces?: () => void;
  workstreams: WorkstreamSummary[];
  /** Whether a page of work streams remains beyond the ones listed. */
  hasMoreWorkstreams?: boolean;
  /** A further page is in flight, so the end of the list is not the end. */
  loadingMoreWorkstreams?: boolean;
  /** Ask for the next page. Called when the scroll approaches the bottom. */
  onLoadMoreWorkstreams?: () => void;
  loading?: boolean;
  accountMenu?: ReactNode;
  onArchiveWorkstream: (workstream: WorkstreamSummary) => Promise<void>;
  onApplyWorkstreamBatch: (
    operationId: string,
    filter: WorkstreamBatchFilter,
    update: WorkstreamBatchUpdate,
  ) => Promise<{ enqueuedCount: number; archivedNoteCount: number }>;
  onChangeWorkstreamScope: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => Promise<void>;
  onMarkWorkstreamUnread: (workstream: WorkstreamSummary) => Promise<void>;
  /**
   * Pin or unpin for the signed-in person, on every device they use.
   *
   * Resolves to whether the response was the one applied — `false` when a later
   * pin was issued behind it and took the list instead. Only the action that
   * won gets to move the viewport; see `reveal`.
   */
  onPinWorkstream: (workstream: WorkstreamSummary, spaceId: string, pinned: boolean) => Promise<boolean>;
  /** The pinned list's new order, in full, after a drag or a keyboard move. */
  onReorderPinnedWorkstreams: (spaceId: string, workstreamIds: string[]) => Promise<void>;
  onRenameWorkstream: (workstream: WorkstreamSummary, title: string) => Promise<void>;
  onRunAutomation: (automation: AutomationSummary) => Promise<void>;
  onPreviewWorkstreamBatch: (
    filter: WorkstreamBatchFilter,
  ) => Promise<{ matchedCount: number; matchedNoteCount: number }>;
  onCreateChannel?: (input: { name: string; spaceId: string }) => Promise<void>;
  onImportChannel?: (input: { clientMessageId: string; name: string; spaceId: string; url: string }) => Promise<void>;
  onCreateSpace?: (input: CreateSpaceRequest) => Promise<SpaceSummary>;
  onAddChannelToSpace?: (spaceId: string, workstreamId: string) => Promise<void>;
  onRemoveChannelFromSpace?: (spaceId: string, workstreamId: string) => Promise<void>;
  /**
   * Every list this person has arranged by hand, and the one way to change one.
   *
   * One prop pair for three containers — the Organization's Spaces, a Space's
   * Channels, a Channel's Breakouts — because they are one mechanism. Channel
   * pins remain a separate per-Space placement property: they select prominence
   * inside a container without changing that container's manual order.
   */
  ordering?: PersonalOrder;
  onReorderContainer?: (order: ContainerOrder) => Promise<void>;
  onRestoreSpace?: (spaceId: string) => Promise<void>;
  onArchiveSpace?: ((spaceId: string) => Promise<void>) | undefined;
  onSignOut: () => void;
}

type RecentSidebarItem =
  | { type: 'workstream'; workstream: WorkstreamSummary; id: string; lastActivityAt: string };

interface WorkstreamBatchTarget {
  label: RecencyGroup;
  operationId: string;
  filter: WorkstreamBatchFilter;
  update: WorkstreamBatchUpdate;
  matchedCount: number;
  /**
   * Counted apart from the work streams because only `archive` reaches notes,
   * and because the dialog has to name both: "everything under this heading" is
   * what the reader means, and two authorities is not something they should
   * have to know to be told what is about to go.
   */
  matchedNoteCount: number;
}

function batchTotal(target: WorkstreamBatchTarget): number {
  return target.matchedCount;
}

/**
 * What the confirmation says is about to change: "3 work streams and 1 note",
 * or whichever half has anything in it.
 *
 * A zero half is dropped rather than written out. The sentence exists to tell
 * somebody what they are about to lose, and "and 0 notes" only invites them to
 * wonder which notes those were. With both halves empty the work-stream half
 * still speaks, because the sentence needs a subject and Continue is refused
 * behind it anyway.
 */
function batchSubject(target: WorkstreamBatchTarget): string {
  const workstreams = target.matchedCount === 1
    ? '1 channel'
    : `${target.matchedCount} channels`;
  return workstreams;
}

const sidebarWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const sidebarMonthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function formatSidebarActivityTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown time';

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const startOfWeekWindow = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();

  if (timestamp >= startOfToday && timestamp < startOfTomorrow) return formatTime(value);
  if (timestamp >= startOfYesterday && timestamp < startOfToday) return 'Yesterday';
  if (timestamp >= startOfWeekWindow && timestamp < startOfYesterday) return sidebarWeekday.format(date);
  return sidebarMonthDay.format(date);
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
const PLACEMENT_DRAG_HINT_ID = 'placement-drag-hint';

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
    description: 'Work together in a shared channel',
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

/**
 * The work-stream row's copy action hands out the link rather than the bare id:
 * a row is shared with a person far more often than it is quoted into a bug
 * report, and the id is still one click away in the work stream's own header
 * menu and its right rail. Like every other surface it emits the canonical
 * HTTPS link, never the `rallywithai://` deep link — see `docs/workstream-links.md`.
 */
function CopyWorkstreamLinkItem({ workstreamId, workspace }: {
  workstreamId: string;
  workspace: Pick<Workspace, 'id' | 'region'>;
}): React.JSX.Element {
  const copy = (): Promise<void> => copyWorkstreamLink({ region: workspace.region, workspaceId: workspace.id }, workstreamId);

  return (
    <ContextMenu.Item className="menu-item" onSelect={() => void copy().catch(() => undefined)}>
      <Copy aria-hidden="true" size={16} /> Copy channel link
    </ContextMenu.Item>
  );
}

/**
 * Neither tile marks a surface entrypoint, and that is deliberate.
 *
 * `markSurfaceEntrypoint` writes a module-local marker that
 * `TelemetryRouteObserver` consumes on the *next route change in this
 * renderer*. Both tiles open the Sidekicks window instead, which is a separate
 * renderer with its own copy of that module — and whose surface in `App.tsx`
 * mounts no observer at all — so a marker set here could never reach the visit
 * it was meant to describe. What it did instead was sit in the main window
 * until its next unmarked navigation consumed it, reporting that navigation as
 * `sidebar_automation`. Attributing the Sidekicks window's own visits needs the
 * entrypoint carried across the window boundary and an observer mounted there;
 * that is a telemetry change, not this one.
 */

/**
 * One tile in the Sidekick strip: a hexagon over a caption, inside the wrapper
 * the strip sizes and the rail shrinks.
 *
 * Shared by the Sidekicks and by the new-Sidekick action below, so the action
 * is the same tile that sheds its caption and shrinks to the rail's 54px square
 * with them rather than a second shape to keep in step with this one.
 *
 * The tile knows nothing about lifecycle. A Sidekick's state reaches the screen
 * as the marker cut into `glyph`, and reaches assistive technology inside
 * `label`; the action tile has neither, and needs no third way to say so. This
 * used to carry an `active` flag as well, which rendered a visually hidden
 * "Active" — dead markup, because `aria-label` on the button replaces its
 * contents in the accessible name, and the label already said it.
 */
/**
 * What the tile's one tooltip says, and where. A tile has one tooltip slot and
 * more than one thing under the pointer, so the slot's whole answer travels as
 * a unit rather than as three props that could disagree.
 */
interface SidekickTileTip {
  label: React.ReactNode;
  /** Away from whatever the pointer is on, which differs per answer. */
  side: 'top' | 'bottom';
}

function SidekickStripTile({ description, glyph, label, name, onClick, tip }: {
  /**
   * What the tooltip would say about the tile that its name does not, for a
   * reader who has no pointer to rest on the thing it is about. The glyph's
   * lifecycle marker is drawn inside `aria-hidden` artwork, so its sentence
   * reaches assistive technology only if the surface carries it — the rule this
   * rail already keeps for the public-scope badge on a work-stream row, which
   * names itself on the row rather than in its own tooltip.
   */
  description?: string | undefined;
  glyph: React.ReactNode;
  /**
   * What the tile is called to a screen reader, which the caption cannot be: it
   * is truncated. The whole name, state included — this is the accessible name,
   * not an addition to one, so anything the contents say is not read.
   */
  label: string;
  name: string;
  onClick: () => void;
  /**
   * What a pointer resting on the tile is told, which is the caption's job
   * everywhere the caption can do it — and it cannot here: the strip ellipsizes
   * a name at 80px and the rail drops it outright.
   *
   * One `Tip` for the whole tile, whichever part of it the pointer is on. A
   * second Radix root nested inside this one's trigger — the obvious way to
   * hang an explanation off the glyph's lifecycle marker — cannot share the
   * slot: a root dispatches a global "close everything else" when it decides to
   * open, so nested roots resolve to whichever decided last rather than to the
   * one being pointed at, and a caller that vetoes the outer root gets nothing
   * at all. One root cannot race itself.
   */
  tip: SidekickTileTip;
}): React.JSX.Element {
  return (
    <div className="sidebar-context-target">
      {/*
        `disableHoverableContent`, like every other tooltip in this rail that
        hangs off something small: there is nothing in a name or a state to
        travel into, and the grace area Radix otherwise keeps between a trigger
        and its content swallows the move onto the tile beside this one.
      */}
      <Tip
        className="sidekick-tile-tooltip"
        collisionPadding={8}
        disableHoverableContent
        label={tip.label}
        side={tip.side}
      >
        <button
          className="sidebar-row automation-row automation-tile"
          aria-description={description}
          aria-label={label}
          onClick={onClick}
          type="button"
        >
          <span className="automation-tile-glyph" aria-hidden="true">{glyph}</span>
          <span className="automation-tile-name">{name}</span>
        </button>
      </Tip>
    </div>
  );
}

function SidekickTile({ sidekick }: { sidekick: AutomationSummary }): React.JSX.Element {
  const scopeDescription = sidekick.scope === 'workspace' ? ' · Organization' : '';
  // Which part of the tile the pointer is on, which only the hexagon can say:
  // the play is drawn in its viewBox so it scales with the tile, rather than
  // positioned by this rail, so there is no element here whose own pointer
  // events would describe it.
  const [markerHovered, setMarkerHovered] = useState(false);
  return (
    <SidekickStripTile
      glyph={<AutomationGlyph {...(sidekick.appearance ? { appearance: sidekick.appearance } : {})} id={sidekick.id} marker={SIDEKICK_RUNNING_MARKER} onMarkerHover={setMarkerHovered} />}
      label={`${sidekick.name}, Active${scopeDescription}`}
      name={sidekick.name}
      onClick={() => void desktopBridge().openSidekicks(sidekick.id)}
      // The tile's line is which Sidekick, not what state it is in: every tile
      // in this strip is active, so naming the state on each of them would spend
      // the one line on the one fact they share. The play in the corner reports
      // it, and pointing at the play is what spells it out — in this same slot,
      // below the tile rather than above it, because that is the corner it is
      // answering for. A screen reader gets the state from `label` either way.
      //
      // Swapped rather than delayed a second time: moving onto the play while
      // the name is up changes the answer at once, and moving back changes it
      // back. That is what one root buys over two — no second delay, no gap,
      // and no ordering to get right.
      tip={markerHovered
        ? { label: SIDEKICK_RUNNING_MARKER.description, side: 'bottom' }
        : { label: `${sidekick.name}${scopeDescription}`, side: 'top' }}
      // The same sentence, for a reader with no pointer to rest on the play.
      // The accessible name above says *which* state; this says what it means,
      // which is the half the mark gets wrong on its own.
      description={SIDEKICK_RUNNING_MARKER.description}
    />
  );
}

/**
 * The strip's action for an empty active-shortcut slot, standing where a
 * Sidekick's tile would: the same hexagon, drawn without a colour or symbol,
 * with a plus in it. A draft or paused Sidekick can exist without occupying
 * this slot.
 *
 * Only while no active standalone Sidekick qualifies. Once one does, the strip
 * is a row of shortcuts that scrolls, and an action tile in it would compete
 * with them for the one place a person looks to reach a Sidekick; the library
 * window carries New Sidekick of its own from then on.
 */
function NewSidekickTile({ target }: { target: string }): React.JSX.Element {
  return (
    <SidekickStripTile
      glyph={<HexagonGlyph className="sidekick-new-glyph" fill="none" ink="var(--av-sys-color-text-muted)" symbol={Plus} />}
      label="New Sidekick"
      name="New Sidekick"
      onClick={() => void desktopBridge().openSidekicks(target)}
      tip={{ label: 'New Sidekick', side: 'top' }}
    />
  );
}

/**
 * The drag behaviour a pinned row carries, supplied only in the Pinned section.
 * Absent everywhere else, which is what keeps a row in the recent list — sorted
 * by activity, where a manual order would be overwritten by the next
 * message — from being draggable at all.
 */
/**
 * A row that can be dragged into a different place in the list it is in.
 *
 * Two lists use it — the pinned Channels and one Space's placements — and they
 * are the same gesture over different rows, so it is one interface and one
 * row. The list itself is marked `data-reorder-list`, which is how the row
 * finds the slots it is being measured against without knowing whose list it
 * is in.
 */
export interface WorkstreamRowDrag {
  dragging: boolean;
  /** `cancelled` is a drag backed out of rather than dropped on the list. */
  onDragEnd: (cancelled: boolean) => void;
  /** The work stream whose slot the pointer is over. */
  onDragOver: (workstreamId: string) => void;
  onDragStart: (workstream: WorkstreamSummary) => void;
  /** Keyboard equivalent of a drag: one step toward the top or the bottom. */
  onMove: (workstream: WorkstreamSummary, direction: -1 | 1) => void;
  /**
   * A release over this list. True when the list took it, which stops the
   * event reaching whatever is above — a Space row, whose meaning for the same
   * drop is "put this Channel here" rather than "put it in this position".
   *
   * Required rather than optional: every list that draws this row sits under
   * something, or will, and the answer is the list's to give rather than a
   * default to fall through to.
   */
  onDrop: () => boolean;
  position: string;
}

/**
 * The name of the `+` in the titlebar and its twin in the rail, read as a
 * tooltip and as the link's own accessible name. It says **work stream** in
 * every shell, the conversation-only one included: the route it opens starts a
 * work stream, and the shell that presents one as a chat elsewhere does not
 * change what the control makes.
 */
const NEW_STREAM_LABEL = 'New channel';

/**
 * What the globe badge means, at the two granularities the two surfaces want.
 *
 * The badge's own tip is a pointer affordance and cannot be anything else: its
 * trigger is a `span` inside the row's link, and making it focusable would put
 * a tab stop on every public row between the link and the next one. So the
 * row's preview — which opens on focus as well as hover — names the scope too,
 * and a reader who never touches a pointer gets the answer by tabbing to the
 * row.
 *
 * They are not the same string, because the pointer path shows both at once:
 * resting on the badge means already resting on the row, so the card is always
 * up behind the tip, and one sentence printed twice a centimetre apart reads as
 * a bug. The card names the state in the words the rest of the app uses for it
 * — the visibility menu offers **Make public to workspace**, and a note's own
 * screen labels itself **Public to workspace** — and the tip, which is what a
 * reader points at the badge to get, spells out what that means.
 *
 * The third register is the badge's own name, which a screen reader reaches
 * through the badge's `aria-label` and the row's `aria-description`. It is
 * named here with the other two because the argument for keeping them distinct
 * is only checkable if they are read together — two of three getting a copy
 * edit is exactly the drift this is meant to prevent.
 */
const PUBLIC_SCOPE_NAME = 'Public channel';
const PUBLIC_SCOPE_LABEL = 'Public to organization';
const PUBLIC_SCOPE_EXPLANATION = 'Public — everyone in the organization can see this channel.';

/**
 * The row itself gets deliberately terse when the sidebar becomes an icon
 * rail. GrokBot keeps the missing context one hover away with the same card in
 * both sidebar forms, so resizing never changes what hovering a person means.
 */
function WorkstreamHoverPreview({
  workstream,
}: {
  workstream: WorkstreamSummary;
}): React.JSX.Element {
  return (
    <div className="sidebar-workstream-preview">
      <div className="sidebar-workstream-preview-header">
        <span className="sidebar-workstream-preview-identity">
          <WorkstreamGlyph appearance={workstream.appearance} id={workstream.id} size={16} />
          <span className="sidebar-workstream-preview-name">{workstream.title}</span>
        </span>
        {workstream.hasUnread && <RelativeTime format={formatSidebarActivityTime} value={workstream.lastActivityAt} />}
      </div>
      {workstream.scope === 'workspace' && (
        <p className="sidebar-workstream-preview-scope">{PUBLIC_SCOPE_LABEL}</p>
      )}
    </div>
  );
}

function WorkstreamRow({
  debugEnabled,
  drag,
  workspace,
  workstream,
  pinPending,
  onArchive,
  onChangeScope,
  onMarkUnread,
  onRename,
  onTogglePin,
  onAddToSpace,
  onRemoveFromSpace,
  onRemoveFromPlacement,
  placementSpaceId,
  onOpen,
  spaces,
  motionMove,
}: {
  debugEnabled: boolean;
  drag?: WorkstreamRowDrag;
  workspace: Pick<Workspace, 'id' | 'region'>;
  workstream: WorkstreamSummary;
  pinPending: boolean;
  onArchive: (workstream: WorkstreamSummary) => void;
  onChangeScope: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => Promise<void>;
  onMarkUnread: (workstream: WorkstreamSummary) => void;
  onRename: (workstream: WorkstreamSummary) => void;
  onTogglePin: (workstream: WorkstreamSummary, pinned: boolean) => void;
  onAddToSpace: (workstream: WorkstreamSummary, spaceId: string) => void;
  onRemoveFromSpace: (workstream: WorkstreamSummary, spaceId: string) => Promise<void>;
  onRemoveFromPlacement: (workstream: WorkstreamSummary, spaceId: string) => void;
  /** The Space whose placement this particular copy of the row represents. */
  placementSpaceId?: string;
  onOpen?: () => void;
  /** The active Space directory: where this Channel could go, and where it is. */
  spaces: SpaceSummary[];
  motionMove?: boolean;
}): React.JSX.Element {
  const location = useLocation();
  const collaboration = useOptionalCollaborationSession();
  const [sharing, setSharing] = useState(false);
  const [managingAccess, setManagingAccess] = useState(false);
  const socketWarmup = useWorkstreamSocketHoverWarmup(workstream.id);
  const socketOpenContext = useWorkstreamSocketOpenContext(workstream.id);
  const markerStatus = workstreamMarkerStatus(workstream);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPreviewTimer = useCallback(() => {
    if (previewOpenTimer.current !== null) {
      clearTimeout(previewOpenTimer.current);
      previewOpenTimer.current = null;
    }
    if (previewCloseTimer.current !== null) {
      clearTimeout(previewCloseTimer.current);
      previewCloseTimer.current = null;
    }
  }, []);
  const schedulePreviewOpen = useCallback(() => {
    cancelPreviewTimer();
    previewOpenTimer.current = setTimeout(() => {
      previewOpenTimer.current = null;
      setPreviewOpen(true);
    }, 300);
  }, [cancelPreviewTimer]);
  const schedulePreviewClose = useCallback(() => {
    cancelPreviewTimer();
    // GrokBot leaves 100ms to cross a small pointer gap without flashing the
    // card. The preview remains non-interactive, so this is grace rather than
    // a second hover target.
    previewCloseTimer.current = setTimeout(() => {
      previewCloseTimer.current = null;
      setPreviewOpen(false);
    }, 100);
  }, [cancelPreviewTimer]);
  const closePreview = useCallback(() => {
    cancelPreviewTimer();
    setPreviewOpen(false);
  }, [cancelPreviewTimer]);
  useEffect(() => () => {
    cancelPreviewTimer();
  }, [cancelPreviewTimer]);
  // A card left up when the person switched away is, on their return, the same
  // unasked-for card as one this switch raised. See `lib/window-activation.ts`.
  useWindowDeactivated(closePreview);
  // Set when the pointer entered this row on the window coming forward rather
  // than by travelling here, which is the one case the guard below turns down
  // and the pointer can still argue its way out of: an entry cannot be replayed
  // once it has happened, so the first real movement over the row is what opens
  // the card that the entry did not.
  const pointerEntryAwaitingIntent = useRef(false);
  const openPreviewFromPointer = useCallback(() => {
    if (!hasUserInputSinceWindowActivation()) {
      pointerEntryAwaitingIntent.current = true;
      return;
    }
    pointerEntryAwaitingIntent.current = false;
    schedulePreviewOpen();
  }, [schedulePreviewOpen]);
  // The row is a cache entry, not a read: nothing here refetches, so the grace
  // is what ends a skeleton whose rename never arrived. Read
  // `lib/naming-skeleton.ts` before changing when it comes down.
  const naming = useNamingSkeleton(workstream);
  const isPinned = workstream.pinPosition !== null;
  // A subsystem's own Channel takes both its audience and its home from the
  // subsystem that writes it, so neither of the two controls that would claim
  // otherwise is raised on one: a system Channel is not a product Channel. The
  // API refuses either change; the menu simply does not ask the question.
  const isProductChannel = !workstream.systemKind;
  // The menu is a picture of the visible directory, not only of the successful
  // mutations left after filtering it. Hiding a read-only Space made a person
  // who could see its row read a stale or incomplete list here. Keep every
  // visible Space and put the existing-placement or access reason on the
  // disabled choice; `addableSpaces` remains the capability used by drag.
  const spaceOptions = isProductChannel
    ? spaces.map((space) => {
        const selected = workstream.spaceIds.includes(space.id);
        const readOnly = space.reach === 'through_channel';
        return {
          id: space.id,
          label: space.name,
          selected,
          disabled: selected || readOnly,
          disabledReason: selected
            ? `This channel is already in ${space.name}.`
            : readOnly
              ? `You can view ${space.name} through a channel, but only ${space.name} participants can add channels.`
              : undefined,
          onSelect: selected || readOnly ? undefined : () => onAddToSpace(workstream, space.id),
        };
      })
    : [];
  const addableSpaces = spaceOptions.filter((space) => !space.disabled);
  const removablePlacement = isProductChannel && placementSpaceId !== undefined
    && spaces.some((space) => space.id === placementSpaceId && space.reach !== 'through_channel');
  const nextWakeupTime = workstream.nextPendingWakeup
    ? formatDateTime(workstream.nextPendingWakeup.dueAt)
    : null;
  return (
    <>
    {collaboration?.api && <ShareConversationDialog api={collaboration.api} workspaceId={workspace.id} parentId={workstream.id} substreamId="0" open={sharing} onOpenChange={setSharing} />}
    {/* Mounted only while it is open. It reads the Channel's access sources,
        and a copy of that query standing behind every row in the sidebar would
        be one request per row for a dialog almost none of them will open. */}
    {managingAccess && <ManageAccessDialog
      onChangeScope={(scope) => onChangeScope(workstream, scope)}
      onOpenChange={setManagingAccess}
      onRemoveFromSpace={(spaceId) => onRemoveFromSpace(workstream, spaceId)}
      open
      spaces={spaces}
      workstreamId={workstream.id}
      workstreamTitle={workstream.title}
    />}
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={clsx('sidebar-context-target', drag && 'is-draggable', drag?.dragging && 'is-dragging')}
          // How the sidebar finds this row again after pinning has moved it to
          // a different section — see the `reveal` effect.
          data-workstream-id={workstream.id}
          // How the sidebar's motion follows this row when it changes place,
          // in a section or between two. A row under the pointer mid-drag is
          // placed rather than moved: it would otherwise leave and re-enter
          // on every row the pointer crosses. See `useListMotion`.
          data-motion-hold={drag?.dragging ? '' : undefined}
          data-motion-move={motionMove ? '' : undefined}
          data-motion-key={`workstream:${workstream.id}`}
          // A drag on this row is either a pinned reorder or a placement, so
          // it is draggable exactly while one of the two is possible. With no
          // Space to drop on — an Organization still opening, a shell without
          // Space navigation, a system Channel — the gesture has nowhere to go
          // and the row does not offer it.
          draggable={drag !== undefined || addableSpaces.length > 0}
          onDragEnd={drag
            // A drag nothing accepted reports `none`. Treated as cancelled when
            // the browser gives no `dataTransfer` at all, because a drop this
            // list handled always leaves one behind.
            ? (event) => drag.onDragEnd((event.dataTransfer?.dropEffect ?? 'none') !== 'move')
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
              // The slot under the pointer is the one laid out there, which
              // mid-motion is not the row drawn there: a row gliding out of
              // the slot the dragged row just took would otherwise be taken
              // for the row that belongs to it, and the reorder would send it
              // straight back. Where rows have no layout — jsdom — the row
              // the event reached is the slot.
              const list = event.currentTarget.closest('[data-reorder-list]');
              const slot = layoutRowAt(
                list?.querySelectorAll<HTMLElement>('[data-workstream-id]') ?? [],
                event.clientY,
              );
              drag.onDragOver(slot?.dataset.workstreamId ?? workstream.id);
            }
            : undefined}
          onDragStart={(event) => {
              closePreview();
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
          onDrop={drag
            ? (event) => {
              event.preventDefault();
              // Only when this list actually took the release. A Channel
              // dragged out of one Space and dropped on another passes over
              // rows that are not in its list, and those must let the drop
              // through to the Space underneath — which is the placement the
              // reader meant.
              if (drag.onDrop()) event.stopPropagation();
            }
            : undefined}
          onContextMenu={closePreview}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) schedulePreviewClose();
          }}
          // An app switch hands focus back to whatever was holding it, which is
          // the row the reader clicked to get here — so without the guard, every
          // return to Rally raises the current work stream's card.
          onFocus={() => {
            if (hasUserInputSinceWindowActivation()) schedulePreviewOpen();
          }}
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
          onPointerEnter={() => {
            socketWarmup.onPointerEnter();
            openPreviewFromPointer();
          }}
          onPointerMove={() => {
            if (pointerEntryAwaitingIntent.current) openPreviewFromPointer();
          }}
          onPointerLeave={() => {
            pointerEntryAwaitingIntent.current = false;
            socketWarmup.onPointerLeave();
            schedulePreviewClose();
          }}
          onPointerCancel={() => {
            pointerEntryAwaitingIntent.current = false;
            socketWarmup.onPointerCancel();
            schedulePreviewClose();
          }}
        >
          <Tooltip.Root open={previewOpen}>
            <Tooltip.Trigger asChild>
              {/* Radix Slot string-merges a child's className. NavLink's
                  className is a callback, so making the link the slotted child
                  turns that callback into text and removes every row class.
                  Keep the positioning trigger on a plain element and leave the
                  navigation element's class resolver untouched. */}
              <div className="sidebar-workstream-preview-anchor">
                <NavLink
            aria-description={workstream.scope === 'workspace' ? PUBLIC_SCOPE_NAME : undefined}
            aria-describedby={previewOpen ? `workstream-preview-${workstream.id}` : undefined}
            aria-label={[naming ? 'Rally is naming this channel' : workstream.title, drag?.position].filter(Boolean).join(', ')}
            className={({ isActive }: { isActive: boolean }) => clsx(
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
            onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
              if (event.defaultPrevented || event.button !== 0
                || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              closePreview();
              const destination = `/workstreams/${workstream.id}`;
              if (location.pathname === destination) return;
              onOpen?.();
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
            <NavigationRowContent id={workstream.id} title={workstream.title} appearance={workstream.appearance} naming={naming}
              marks={<>{workstream.scope === 'workspace' && <PublicMarker />}{markerStatus !== 'completed' &&
                <span className="workstream-row-status"><StatusDot compact status={markerStatus} tooltip /></span>}</>}
              titlePrefix={workstream.systemKind ? <Cog aria-label="System channel" size={11} /> : undefined}
              activity={workstream.hasUnread ? <RelativeTime className="sidebar-row-activity" format={formatSidebarActivityTime} value={workstream.lastActivityAt} /> : undefined} />
            {/* The manual order is the whole point of the section, and a
                pointer-only affordance leaves it unreadable to anyone not
                looking at it. The position — and only the position — rides on
                the row, because it is the part that differs per row; how to
                change it is said once, on the section. */}
            {drag && <span className="sr-only">{drag.position}</span>}
            {workstream.nextPendingWakeup && (
              <Tip
                align="center"
                className="workstream-timer-tooltip"
                delayDuration={300}
                disableHoverableContent
                label={<>
                  <strong>Next: {nextWakeupTime}</strong>
                  <span>{workstream.nextPendingWakeup.promptPreview}</span>
                </>}
                side="right"
                sideOffset={8}
              >
                <span
                  aria-label={`Active timer. Next: ${nextWakeupTime}. ${workstream.nextPendingWakeup.promptPreview}`}
                  className="sidebar-workstream-timer"
                  role="img"
                >
                  <Clock aria-hidden="true" size={15} strokeWidth={1.7} />
                </span>
              </Tip>
            )}
                </NavLink>
              </div>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                align="center"
                className="sidebar-workstream-preview-surface"
                collisionPadding={8}
                id={`workstream-preview-${workstream.id}`}
                side="right"
                sideOffset={8}
              >
                <WorkstreamHoverPreview workstream={workstream} />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          {/* Named for the state it moves to, like every other toggle in these
              menus. A pin is this reader's own and follows them to their other
              devices; it changes nothing for anyone else in the work stream. */}
          {placementSpaceId !== undefined && <ContextMenu.Item
            className="menu-item"
            disabled={pinPending}
            onSelect={() => onTogglePin(workstream, !isPinned)}
          >
            {isPinned
              ? <><PinOff aria-hidden="true" size={16} /> Unpin</>
              : <><Pin aria-hidden="true" size={16} /> Pin</>}
          </ContextMenu.Item>}
          <ContextMenu.Item className="menu-item" onSelect={() => onMarkUnread(workstream)}>
            <EyeOff aria-hidden="true" size={16} /> Mark as unread
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" disabled={!collaboration?.api} onSelect={() => setSharing(true)}><IconShare2 aria-hidden="true" size={16} stroke={1.8} /> Share</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => onRename(workstream)}>
            <Pencil aria-hidden="true" size={16} /> Rename
          </ContextMenu.Item>
          {spaceOptions.length > 0 && (
            <ContextNestedMenu
              icon={<FolderPlus aria-hidden="true" size={16} />}
              label="Add to space"
              options={spaceOptions}
            />
          )}
          {/* Replaces **Make private**, which could only ever describe this
              Channel's own scope. Its readers are now the union of that scope
              and every active Space that holds it, so the row cannot say
              whether it is private without reading those sources — which is
              what the dialog does. */}
          {isProductChannel && (
            <ContextMenu.Item className="menu-item" onSelect={() => setManagingAccess(true)}>
              <Globe2 aria-hidden="true" size={16} /> Manage access
            </ContextMenu.Item>
          )}
          {debugEnabled && <CopyWorkstreamLinkItem workstreamId={workstream.id} workspace={workspace} />}
          <ContextMenu.Separator className="menu-separator" />
          {removablePlacement && (
            <ContextMenu.Item
              className="menu-item"
              onSelect={() => onRemoveFromPlacement(workstream, placementSpaceId)}
            >
              <FolderMinus aria-hidden="true" size={16} /> Remove from space
            </ContextMenu.Item>
          )}
          {/* Names its noun, as every other destructive item in these menus
              does — "Archive note", "Archive draft", "Archive Sidekick". A
              bare "Archive" under Mark as unread and Rename reads as archiving
              the messages rather than removing the work stream from everyone's
              sidebar for good. */}
          <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => onArchive(workstream)}>
            <Archive aria-hidden="true" size={16} /> Archive channel
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root></>
  );
}

/**
 * The globe a work stream wears when its audience is the whole workspace.
 *
 * A 17px badge with no words is the one thing on the row a reader cannot work
 * out by looking, so the explanation is a tip rather than a label only a screen
 * reader reaches. It reads like the status dot beside it — the name, then the
 * sentence — because the two badges sit on the same glyph and answering the
 * same question two different ways is what makes a row need decoding.
 *
 * This tip is the pointer half of the answer; `PUBLIC_SCOPE_EXPLANATION` says
 * where the keyboard half lives and why it is not simply a `tabIndex` here.
 *
 * The row's own preview stays open behind it: the tip is a line above a badge
 * at the sidebar's left edge and the preview is a card off the row's right, so
 * the two never share the space. Radix would close one for the other, but the
 * preview drives its `open` itself and ignores the request.
 */
function PublicMarker(): React.JSX.Element {
  return (
    <Tip
      collisionPadding={8}
      delayDuration={300}
      disableHoverableContent
      label={PUBLIC_SCOPE_EXPLANATION}
      side="top"
      sideOffset={8}
    >
      <span aria-label={PUBLIC_SCOPE_NAME} className="sidebar-workstream-public" role="img">
        <Globe2 aria-hidden="true" size={11} />
      </span>
    </Tip>
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
  // The same arrangement rule every other hand-ordered list in the app is
  // drawn by, with the drag standing in for the stored order: ids it names
  // first, then everything it never saw, and an id that is no longer pinned —
  // unpinned in another window mid-drag — dropped rather than drawn as a gap.
  return orderByStoredIds(pinned, dragOrder ?? [], (workstream) => workstream.id);
}

type SidebarMenuFailure = 'archive' | 'add_to_space' | 'pin' | 'unpin' | 'reorder_pinned';

const sidebarMenuFailureCopy: Record<SidebarMenuFailure, { title: string; copy: string }> = {
  archive: {
    title: 'Channel could not be archived',
    copy: 'The channel is still in the sidebar. Try again in a moment.',
  },
  add_to_space: {
    title: 'Channel could not be added to that space',
    copy: 'The channel is still in the spaces it was in. Try again in a moment.',
  },
  pin: {
    title: 'Channel could not be pinned',
    copy: 'The channel is still in the recent list. Try again in a moment.',
  },
  unpin: {
    title: 'Channel could not be unpinned',
    copy: 'The channel is still pinned. Try again in a moment.',
  },
  reorder_pinned: {
    title: 'Pinned channels could not be reordered',
    copy: 'The pinned list is back in the order it was in. Try again in a moment.',
  },
};

export function Sidebar({
  onOpenSearch,
  conversationOnly = false,
  compact = false,
  constrained = false,
  workspace,
  automations,
  spaces,
  spacesCollapsed: controlledSpacesCollapsed,
  onSpacesCollapsedChange,
  inactiveSpaces = [],
  spacesReady = true,
  spacesOutOfDate = false,
  onRetrySpaces = () => undefined,
  workstreams,
  loading,
  accountMenu,
  onArchiveWorkstream,
  onApplyWorkstreamBatch,
  onChangeWorkstreamScope,
  onMarkWorkstreamUnread,
  onPinWorkstream,
  onReorderPinnedWorkstreams,
  onRenameWorkstream,
  onPreviewWorkstreamBatch,
  onCreateChannel = async () => { throw new Error('Channel creation is unavailable.'); },
  onImportChannel = async () => { throw new Error('Channel import is unavailable.'); },
  onCreateSpace = async () => {
    throw new Error('Space creation is unavailable.');
  },
  onAddChannelToSpace = async () => undefined,
  onRemoveChannelFromSpace = async () => undefined,
  ordering = [],
  onReorderContainer = async () => undefined,
  onRestoreSpace = async () => undefined,
  onArchiveSpace,
  onSignOut,
  hasMoreWorkstreams = false,
  loadingMoreWorkstreams = false,
  onLoadMoreWorkstreams,
}: SidebarProps): React.JSX.Element {
  const debugEnabled = useDebugEnabled();
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  // The window's own answer, not one inferred from `compact`. Inferred as
  // `compact && !sidebarCollapsed`, this read false for a reader who collapsed
  // navigation and then narrowed the window: the footer toggle came back to
  // life, the hint offered an expansion that could not happen, and taking
  // either rewrote the saved preference to expanded for a widening that might
  // never come.
  const forcedCompact = constrained;
  const effectiveSidebarWidth = compact ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth;
  const [uncontrolledSpacesCollapsed, setUncontrolledSpacesCollapsed] = useState(false);
  const spacesCollapsed = controlledSpacesCollapsed ?? uncontrolledSpacesCollapsed;
  const setSpacesCollapsed = useCallback((collapsed: boolean): void => {
    if (controlledSpacesCollapsed === undefined) setUncontrolledSpacesCollapsed(collapsed);
    onSpacesCollapsedChange?.(collapsed);
  }, [controlledSpacesCollapsed, onSpacesCollapsedChange]);
  const routeSpaceId = /^\/spaces\/([^/]+)/u.exec(location.pathname)?.[1] ?? null;
  const routeWorkstreamId = /^\/workstreams\/([^/]+)/u.exec(location.pathname)?.[1] ?? null;
  const routeWorkstream = routeWorkstreamId
    ? workstreams.find((workstream) => workstream.id === routeWorkstreamId)
    : undefined;
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(() =>
    routeSpaceId ?? routeWorkstream?.spaceIds[0] ?? spaces?.[0]?.id ?? null);
  const previousRouteWorkstreamId = useRef<string | null>(null);
  useEffect(() => {
    if (previousRouteWorkstreamId.current === routeWorkstreamId) return;
    previousRouteWorkstreamId.current = routeWorkstreamId;
    if (routeWorkstreamId === null) return;
    setSpacesCollapsed(true);
    setSidebarCollapsed(true);
  }, [routeWorkstreamId, setSidebarCollapsed]);
  useEffect(() => {
    if (routeSpaceId) {
      if (spaces?.some((space) => space.id === routeSpaceId)) setSelectedSpaceId(routeSpaceId);
      return;
    }
    if (routeWorkstream?.spaceIds.includes(selectedSpaceId ?? '')) return;
    if (routeWorkstream?.spaceIds[0]) setSelectedSpaceId(routeWorkstream.spaceIds[0]);
  }, [routeSpaceId, routeWorkstream, selectedSpaceId, spaces]);
  useEffect(() => {
    if (selectedSpaceId && spaces?.some((space) => space.id === selectedSpaceId)) return;
    setSelectedSpaceId(spaces?.[0]?.id ?? null);
  }, [selectedSpaceId, spaces]);
  useLayoutEffect(() => {
    const shell = panel.current?.closest<HTMLElement>('.workspace-shell');
    if (!shell) return;
    shell.style.setProperty('--spaces-sidebar-width', spaces === undefined ? '0px' : spacesCollapsed ? `${COLLAPSED_SIDEBAR_WIDTH}px` : `${EXPANDED_SPACES_SIDEBAR_WIDTH}px`);
    return () => { shell.style.removeProperty('--spaces-sidebar-width'); };
  }, [spaces, spacesCollapsed]);
  const openPublicPage = useCallback(async (path: string): Promise<void> => {
    const bridge = desktopBridge();
    const { webBaseUrl } = await bridge.getRuntimeConfig();
    await bridge.openExternal(new URL(path, `${webBaseUrl.replace(/\/$/u, '')}/`).toString());
  }, []);
  const [resizing, setResizing] = useState(false);
  // Held arrow keys are the keyboard's drag: they write the width repeatedly,
  // and animating each 16px step leaves the edge trailing the width the
  // threshold is judged against, so the sidebar collapses at a width the
  // reader cannot see. Not `resizing`, which also arms the window pointer
  // listeners — a mouse moved during a keyboard resize would grab the edge.
  const [keyResizing, setKeyResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const panel = useRef<HTMLElement>(null);
  // The handle stands in the strip beside the sidebar rather than on its edge,
  // so the pointer's own position is not the sidebar's width. Holding the
  // difference from the moment of the grab keeps the edge from jumping out to
  // meet a pointer that grabbed the far side of the strip.
  const grabOffset = useRef(0);
  const [pointerNearEdge, setPointerNearEdge] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkstreamSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameFailed, setRenameFailed] = useState(false);
  // The note actions and a work stream's visibility apply straight from the
  // menu, so a rejection has nowhere to land unless it is raised here: the row
  // simply stays as it was.
  const [menuFailure, setMenuFailure] = useState<SidebarMenuFailure | null>(null);
  const [removeFromSpaceFailure, setRemoveFromSpaceFailure] = useState<string | null>(null);
  const [pinPendingWorkstreamId, setPinPendingWorkstreamId] = useState<string | null>(null);
  // The work stream a pin or unpin has just moved, and which side of the
  // sidebar it was moved to, held until the list re-renders carrying that
  // change. Cleared the moment it is honoured, so a later render for any other
  // reason does not scroll the reader again.
  const [reveal, setReveal] = useState<{ id: string; pinned: boolean } | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  // The search row — and, in the rail, the New work stream row under it — sit
  // above the scroll box rather than in it, so search is at the top of the
  // sidebar however far the list has been scrolled. The bar has a list motion of
  // its own: that row is inserted by the compact toggle and removed by the
  // expand, and is seen arriving and leaving.
  const commandRef = useRef<HTMLDivElement | null>(null);
  // Whether the sidebar's contents are still travelling between its two
  // layouts. The box's width is a CSS transition and so is everything inside
  // it that changes shape with it; `--sidebar-compact` is the sidebar's own
  // channel on that same interval, and the platform's events on it are the one
  // honest answer to "has the layout settled" — a timer would have to know the
  // duration, and would still be wrong under a drag, which turns the
  // transition off, and under a reader who has asked for less motion. Only the
  // aside's own events count: the rows' transitions bubble through here too.
  const [layoutSettling, setLayoutSettling] = useState(false);
  // How many transitions of the channel are running: a count rather than the
  // last event seen, because a toggle reversed mid-flight cancels the running
  // transition and starts another in one style change, and nothing pins the
  // order those two events arrive in. Counted, cancel-then-run and
  // run-then-cancel both leave one running. Clamped at zero for a component
  // that mounts partway through a transition and sees its end alone.
  const layoutRuns = useRef(0);
  const trackLayoutTransition = useCallback((event: TransitionEvent<HTMLElement>): void => {
    // From the platform's event rather than React's: React fills in
    // `propertyName` for `transitionend` alone, and leaves it undefined on
    // `transitionrun` and `transitioncancel`.
    if (event.target !== event.currentTarget || event.nativeEvent.propertyName !== '--sidebar-compact') return;
    layoutRuns.current = Math.max(0, layoutRuns.current + (event.type === 'transitionrun' ? 1 : -1));
    setLayoutSettling(layoutRuns.current > 0);
  }, []);
  // The toggle raises the hold itself, ahead of the platform: `transitionrun`
  // is dispatched with the first frame after the change, and a render landing
  // before it — a socket update, the reveal clearing itself — would otherwise
  // plan against rows a frame into their travel. A frame later, once the
  // platform has had its say, the hold is released if nothing started — a
  // drag has turned the transitions off, or the layout did not change shape.
  const lastCompact = useRef(compact);
  useLayoutEffect(() => {
    if (lastCompact.current === compact) return undefined;
    lastCompact.current = compact;
    setLayoutSettling(true);
    const frame = requestAnimationFrame(() => {
      if (layoutRuns.current === 0) setLayoutSettling(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [compact]);
  /**
   * Ask for the next page as the scroll approaches the end of the list.
   *
   * Guarded on both flags rather than only on the pointer position: a scroll
   * event fires for every frame of a flick, and the list is one cache entry
   * that a second request would append to twice. `fetchMore` is itself a no-op
   * without a cursor, so this is the cheap half of the same guard.
   */
  const loadMoreWhenNearBottom = useCallback((event: React.UIEvent<HTMLElement>): void => {
    const wantsWorkstreams = hasMoreWorkstreams && !loadingMoreWorkstreams && onLoadMoreWorkstreams;
    if (!wantsWorkstreams) return;
    const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight > LOAD_MORE_DISTANCE) return;
    // Both, not whichever is nearer the bottom. The two lists are interleaved
    // by recency under one set of headings, so the row at the end belongs to
    // one of them and the *other* is what the next heading down needs. Asking
    // only for the kind at the bottom would stall the list at the point where
    // one of them runs out.
    onLoadMoreWorkstreams();
  }, [
    hasMoreWorkstreams,
    loadingMoreWorkstreams,
    onLoadMoreWorkstreams,
  ]);
  // The arrangement being dragged, held only for as long as the drag lasts.
  // The list renders from it while it exists, so rows move under the pointer
  // before anything is sent; the server's answer replaces it when the drag
  // ends. Its Space identity keeps an in-flight request from becoming another
  // Space's preview after navigation. `null` means the pinned list is showing
  // what the server last said.
  const [dragOrder, setDragOrder] = useState<{ spaceId: string; itemIds: string[] } | null>(null);
  // SpacesSidebar owns the gesture, but every destination picker owns the
  // promise's optimistic result with it so no sibling surface lags the rail.
  const [spaceOrderPreview, setSpaceOrderPreview] = useState<string[] | null>(null);
  const draggingWorkstreamId = useRef<string | null>(null);
  const motionMoveIntent = useRef<{ id: string; pinned: boolean } | null>(null);
  const [placementOrder, setPlacementOrder] = useState<{ spaceId: string; itemIds: string[] } | null>(null);
  const placementDrag = useRef<{ workstreamId: string; dropped: boolean; spaceId: string } | null>(null);
  const [placementFailure, setPlacementFailure] = useState<string | null>(null);
  const [archiveWorkstreamTarget, setArchiveWorkstreamTarget] = useState<WorkstreamSummary | null>(null);
  const [archivingWorkstream, setArchivingWorkstream] = useState(false);
  const [batchTarget, setBatchTarget] = useState<WorkstreamBatchTarget | null>(null);
  const [batchPreviewing, setBatchPreviewing] = useState(false);
  const [batchApplying, setBatchApplying] = useState(false);
  const [batchFailure, setBatchFailure] = useState<'preview' | 'apply' | null>(null);
  const [batchPreviewFailed, setBatchPreviewFailed] = useState(false);
  const [accountSlot, setAccountSlot] = useState<HTMLDivElement | null>(null);
  const [sidekickSlot, setSidekickSlot] = useState<HTMLDivElement | null>(null);
  const batchPreviewGeneration = useRef(0);
  const visibleWorkstreams = useMemo(() => (
    (spaces === undefined || !spacesReady || selectedSpaceId === null
      ? workstreams
      : workstreams.filter((workstream) => workstream.spaceIds.includes(selectedSpaceId)))
      .map((workstream) => ({
        ...workstream,
        pinPosition: selectedSpaceId === null
          ? null
          : workstream.spaceIds.includes(selectedSpaceId)
            ? workstream.spacePins?.find((pin) => pin.spaceId === selectedSpaceId)?.position ?? null
            : null,
      }))
  ), [selectedSpaceId, spaces, spacesReady, workstreams]);
  const selectedSpace = spaces?.find((space) => space.id === selectedSpaceId);
  const lastAutomaticSpacePage = useRef<string | null>(null);
  useEffect(() => {
    if (!spacesReady
      || !selectedSpace
      || visibleWorkstreams.length >= selectedSpace.channelCount
      || !hasMoreWorkstreams
      || loadingMoreWorkstreams
      || !onLoadMoreWorkstreams) return;
    const pageKey = `${selectedSpace.id}:${workstreams.length}`;
    if (lastAutomaticSpacePage.current === pageKey) return;
    lastAutomaticSpacePage.current = pageKey;
    onLoadMoreWorkstreams();
  }, [
    hasMoreWorkstreams,
    loadingMoreWorkstreams,
    onLoadMoreWorkstreams,
    selectedSpace,
    spacesReady,
    visibleWorkstreams.length,
    workstreams.length,
  ]);
  // Resolved here rather than through `NavLink`'s function form, because both
  // of these links are tooltip triggers: Radix clones the child and merges its
  // `className`, and a function arrives at the DOM as its own source text with
  // the link unstyled. It is the same comparison the `returnTo` state below
  // makes, so the two cannot disagree about which route this is.
  const onNewStreamRoute = location.pathname === '/workstreams/new';
  const standaloneSidekicks = useMemo(() => (automations ?? []).filter((sidekick) => sidekick.scope !== 'workstream' && sidekick.status === 'active'), [automations]);
  const sidekickShortcutsLoaded = automations !== undefined;
  const resumablePersonalDraft = useMemo(() => (automations ?? [])
    .filter((sidekick) => sidekick.scope === 'you' && sidekick.status === 'draft')
    .reduce<AutomationSummary | undefined>((latest, sidekick) => {
      if (!latest) return sidekick;
      const recency = sidekick.updatedAt.localeCompare(latest.updatedAt);
      return recency > 0 || (recency === 0 && sidekick.id.localeCompare(latest.id) > 0)
        ? sidekick
        : latest;
    }, undefined), [automations]);
  // A pinned work stream leaves the recent list entirely rather than appearing
  // twice: the section it moves to is the one whose order the reader controls,
  // and a row in both places would take its order from whichever they saw last.
  // Two orders, and the difference between them is what a drop commits: the
  // one the server last confirmed, and the one the pointer is building on top
  // of it. Comparing a finished drag against the second would compare it with
  // itself and conclude nothing moved.
  const storedPinnedWorkstreams = useMemo(
    () => orderPinnedWorkstreams(visibleWorkstreams, null),
    [visibleWorkstreams],
  );
  const activeDragOrder = dragOrder?.spaceId === selectedSpaceId ? dragOrder.itemIds : null;
  const pinnedWorkstreams = useMemo(
    () => orderPinnedWorkstreams(visibleWorkstreams, activeDragOrder),
    [activeDragOrder, visibleWorkstreams],
  );
  const storedUnpinnedWorkstreams = useMemo(() => orderByStoredIds(
    visibleWorkstreams
      .filter((workstream) => workstream.pinPosition === null)
      .sort(compareWorkstreamRecency),
    selectedSpaceId === null ? [] : storedOrderFor(ordering, { kind: 'space', id: selectedSpaceId }),
    (workstream) => workstream.id,
  ), [ordering, selectedSpaceId, visibleWorkstreams]);
  const storedUnpinnedIds = storedUnpinnedWorkstreams.map((workstream) => workstream.id);
  const activePlacementOrder = placementOrder?.spaceId === selectedSpaceId
    ? placementOrder.itemIds
    : null;
  const unpinnedWorkstreams = activePlacementOrder === null
    ? storedUnpinnedWorkstreams
    : orderByStoredIds(storedUnpinnedWorkstreams, activePlacementOrder, (workstream) => workstream.id);
  // Whether this session has the hierarchy at all. A host that hands over no
  // directory is the guest shell, where Space discovery is deferred — see
  // `spaces` above — and that shell keeps the flat, time-grouped list this
  // section has always drawn. Every other session reads its Channels under the
  // Space each one lives in.
  const spacesEnabled = spaces !== undefined;
  /**
   * The Spaces this sidebar is drawing as Spaces — the one answer every section
   * that reasons about the hierarchy asks for.
   *
   * None in a shell with no Space navigation, and none while the Organization
   * is still opening: the Spaces section draws its opening card *instead of*
   * the rows until `spacesReady`, and a Channel placed in a Space that is not
   * on screen is a Channel the reader cannot reach through the hierarchy. It is
   * also where a Channel may be placed *from* a row, because the server refuses
   * the membership with `space_bootstrap_pending` and a menu that could only
   * fail is worse than one that is not there.
   *
   * One value rather than one per section, and this is why: the fallback list
   * below decides what to draw by asking whether a Channel's Spaces are among
   * these, so a section that disagreed with the hierarchy about which Spaces
   * exist would leave every placed Channel in neither list.
   * Keep this collection in the Organization's saved order too, so every
   * placement chooser presents the same sequence as the Space rail.
   */
  const placementSpaces = useMemo(() => orderByStoredIds(
    spaces !== undefined && spacesReady ? spaces : [],
    spaceOrderPreview ?? storedOrderFor(ordering, { kind: 'organization' }),
    (space) => space.id,
  ), [ordering, spaceOrderPreview, spaces, spacesReady]);
  /**
   * Channels this reader can open that none of their visible Spaces holds.
   *
   * Two states produce one now, and both are transient. **While the
   * Organization is still opening** this is *every* Channel, which is the
   * point: the Spaces above are showing an opening card rather than rows, and
   * a member with the desktop open through their Organization's cutover would
   * otherwise watch each page of Channels leave the sidebar as the walk placed
   * it in General. And a Channel whose every Space is **archived** has no row
   * to sit under either, because the Spaces section draws active Spaces only.
   *
   * What used to be the ordinary case is not one any more: a Channel placed
   * only in somebody else's personal Space is now drawn under that Space, whose
   * mark and name this reader is told precisely so it has somewhere to go. The
   * section stays because those two states are real, and because it is absent
   * when empty — which is almost always.
   *
   * Pinned Channels are left out, exactly as the list this replaces left them
   * out: the section above already has them, and a row in both would take its
   * order from whichever the reader saw last.
   */
  const [groupedAtMs, setGroupedAtMs] = useState(() => Date.now());
  useEffect(() => {
    // Only the guest shell groups by time, so only the guest shell needs a
    // timer that fires when a row crosses a boundary.
    if (spacesEnabled) return;
    const now = new Date();
    const next = nextRecencyBoundary([
      ...unpinnedWorkstreams.map((workstream) => ({
        lastActivityAt: workstreamRecencyAt(workstream),
      })),
    ], now);
    const timer = window.setTimeout(
      () => setGroupedAtMs(Date.now()),
      Math.max(1, next - now.getTime() + 1),
    );
    return () => window.clearTimeout(timer);
  }, [groupedAtMs, spacesEnabled, unpinnedWorkstreams]);
  const groups = useMemo(() => {
    if (spacesEnabled) return [];
    const groupedAt = new Date(groupedAtMs);
    return groupActivityItems<RecentSidebarItem>([
      ...unpinnedWorkstreams.map((workstream) => ({
        type: 'workstream' as const,
        id: `workstream:${workstream.id}`,
        lastActivityAt: workstreamRecencyAt(workstream),
        workstream,
      })),
    ], groupedAt);
  }, [groupedAtMs, spacesEnabled, unpinnedWorkstreams]);

  const openRename = (workstream: WorkstreamSummary): void => {
    setRenameTarget(workstream);
    setRenameTitle(workstream.title);
    setRenameFailed(false);
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
        origin: archiveWorkstreamTarget.systemKind ? 'system' : 'ad_hoc',
        pinned: archiveWorkstreamTarget.pinPosition !== null,
      });
      setArchiveWorkstreamTarget(null);
    } catch {
      setArchiveWorkstreamTarget(null);
      setMenuFailure('archive');
    } finally {
      setArchivingWorkstream(false);
    }
  };

  const openWorkstreamBatch = (
    label: RecencyGroup,
    update: WorkstreamBatchUpdate,
    visible: readonly RecentSidebarItem[],
  ): void => {
    const filter = { ...recencyGroupBatchFilter(label, new Date(), selectedSpaceId ?? undefined),
      ...(visibleWorkstreams.some((workstream) => workstream.lastAccessedAt !== undefined)
        ? { recency: 'access' as const } : {}),
    };
    const generation = batchPreviewGeneration.current + 1;
    batchPreviewGeneration.current = generation;
    const seeded = { workstreams: visible.length, notes: 0 };
    setBatchTarget({
      label,
      operationId: crypto.randomUUID(),
      filter,
      update,
      matchedCount: seeded.workstreams,
      matchedNoteCount: seeded.notes,
    });
    setBatchPreviewing(true);
    setBatchFailure(null);
    setBatchPreviewFailed(false);
    void onPreviewWorkstreamBatch(filter).then(({ matchedCount, matchedNoteCount }) => {
      if (batchPreviewGeneration.current !== generation) return;
      setBatchTarget((current) => current ? { ...current, matchedCount, matchedNoteCount } : null);
    }).catch(() => {
      if (batchPreviewGeneration.current !== generation) return;
      setBatchPreviewFailed(true);
      setBatchFailure('preview');
    }).finally(() => {
      if (batchPreviewGeneration.current === generation) setBatchPreviewing(false);
    });
  };

  const closeWorkstreamBatch = (): void => {
    if (batchApplying) return;
    batchPreviewGeneration.current += 1;
    setBatchTarget(null);
    setBatchFailure(null);
    setBatchPreviewFailed(false);
    setBatchPreviewing(false);
  };

  const submitWorkstreamBatch = async (): Promise<void> => {
    if (!batchTarget || batchPreviewing || batchTotal(batchTarget) === 0) return;
    setBatchApplying(true);
    setBatchFailure(null);
    try {
      await onApplyWorkstreamBatch(
        batchTarget.operationId,
        batchTarget.filter,
        batchTarget.update,
      );
      setBatchTarget(null);
    } catch {
      setBatchFailure('apply');
    } finally {
      setBatchApplying(false);
    }
  };

  // Rejects rather than raising the sidebar's own failure dialog: an audience
  // change is made from **Manage access**, which knows which source was refused
  // and holds the exhaustive copy that says what to change first.
  const changeWorkstreamScope = async (
    workstream: WorkstreamSummary,
    scope: 'personal' | 'workspace',
  ): Promise<void> => {
    await onChangeWorkstreamScope(workstream, scope);
    reportTelemetryProductIntent({
      kind: 'workstream_action_completed',
      workstreamId: workstream.id,
      action: scope === 'workspace' ? 'make_public' : 'make_private',
      visibility: telemetryVisibility(scope),
      origin: workstream.systemKind ? 'system' : 'ad_hoc',
      pinned: workstream.pinPosition !== null,
    });
  };

  const togglePin = async (workstream: WorkstreamSummary, pinned: boolean): Promise<void> => {
    if (selectedSpaceId === null) return;
    const motionIntent = { id: workstream.id, pinned };
    motionMoveIntent.current = motionIntent;
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
      if (await onPinWorkstream(workstream, selectedSpaceId, pinned)) {
        setReveal({ id: workstream.id, pinned });
        setTimeout(() => {
          if (motionMoveIntent.current === motionIntent) motionMoveIntent.current = null;
        }, 0);
        reportTelemetryProductIntent({
          kind: 'workstream_action_completed',
          workstreamId: workstream.id,
          action: pinned ? 'pin' : 'unpin',
          visibility: telemetryVisibility(workstream.scope),
          origin: workstream.systemKind ? 'system' : 'ad_hoc',
          pinned,
        });
      } else if (motionMoveIntent.current === motionIntent) {
        motionMoveIntent.current = null;
      }
    } catch {
      if (motionMoveIntent.current === motionIntent) motionMoveIntent.current = null;
      setMenuFailure(pinned ? 'pin' : 'unpin');
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
      origin: workstream.systemKind ? 'system' : 'ad_hoc',
      pinned: workstream.pinPosition !== null,
    });
  };

  // A dropped arrangement is sent whole. If the server refuses it, the local
  // order is dropped rather than kept: the section then shows what the server
  // actually holds, which is the order the reader's other devices are showing.
  const commitPinnedOrder = async (order: string[]): Promise<void> => {
    if (selectedSpaceId === null) return;
    const spaceId = selectedSpaceId;
    const preview = { spaceId, itemIds: order };
    setDragOrder(preview);
    try {
      // Search only reorders the visible slots; hidden pins keep their place.
      const visibleIds = new Set(order);
      let nextVisible = 0;
      const completeOrder = orderPinnedWorkstreams(visibleWorkstreams, null).map((pinned) => (
        visibleIds.has(pinned.id) ? order[nextVisible++]! : pinned.id
      ));
      await onReorderPinnedWorkstreams(spaceId, completeOrder);
    } catch {
      setMenuFailure('reorder_pinned');
    } finally {
      // Only if this call's arrangement is still the one on screen. Two moves
      // in quick succession overlap, and clearing unconditionally would let the
      // first response snap the list back to an order the second has already
      // moved past — visibly, and for as long as the second request takes.
      setDragOrder((current) => current === preview ? null : current);
    }
  };

  const pinnedRowDrag = (workstream: WorkstreamSummary, index: number): WorkstreamRowDrag => ({
    dragging: draggingWorkstreamId.current === workstream.id && activeDragOrder !== null,
    position: `Pinned, ${index + 1} of ${pinnedWorkstreams.length}.`,
    onDragStart: (target) => {
      if (selectedSpaceId === null) return;
      draggingWorkstreamId.current = target.id;
      setDragOrder({
        spaceId: selectedSpaceId,
        itemIds: pinnedWorkstreams.map((pinned) => pinned.id),
      });
    },
    onDragOver: (targetId) => {
      const draggingId = draggingWorkstreamId.current;
      if (draggingId === null || draggingId === targetId) return;
      setDragOrder((current) => {
        if (selectedSpaceId === null) return current;
        const order = current?.spaceId === selectedSpaceId
          ? current.itemIds
          : pinnedWorkstreams.map((pinned) => pinned.id);
        const targetIndex = order.indexOf(targetId);
        if (targetIndex < 0 || order.indexOf(draggingId) === targetIndex) return current;
        return { spaceId: selectedSpaceId, itemIds: moveWithin(order, draggingId, targetIndex) };
      });
    },
    onDragEnd: (cancelled) => {
      const order = activeDragOrder;
      draggingWorkstreamId.current = null;
      if (order === null) return;
      // `dragend` fires whatever ended the drag, and `committedOrder` holds the
      // three questions every list here asks at that moment: was it backed out
      // of, did anything actually move, and — the one that is easy to get
      // wrong — moved *relative to what the server last confirmed*, which is
      // `storedPinnedWorkstreams` rather than the list on screen.
      const committed = committedOrder(
        order, storedPinnedWorkstreams.map((pinned) => pinned.id), cancelled,
      );
      if (committed === null) {
        setDragOrder(null);
        return;
      }
      void commitPinnedOrder(committed);
    },
    onMove: (target, direction) => {
      const order = pinnedWorkstreams.map((pinned) => pinned.id);
      const from = order.indexOf(target.id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= order.length) return;
      void commitPinnedOrder(moveWithin(order, target.id, to));
    },
    // Nothing above this list wants a release inside it; saying so is what
    // keeps that true if something ever sits above it.
    onDrop: () => true,
  });

  const addToSpace = (workstream: WorkstreamSummary, spaceId: string): void => {
    setMenuFailure(null);
    void onAddChannelToSpace(spaceId, workstream.id).catch(() => setMenuFailure('add_to_space'));
  };

  const removeFromPlacement = (workstream: WorkstreamSummary, spaceId: string): void => {
    setRemoveFromSpaceFailure(null);
    void onRemoveChannelFromSpace(spaceId, workstream.id).catch((cause: unknown) => {
      setRemoveFromSpaceFailure(spaceFailureOf(cause) === 'space_membership_final'
        ? 'A channel must be in at least one space.'
        : spaceFailureSentence(
          cause,
          'The channel is still in that space. Try again in a moment.',
        ));
    });
  };

  const workstreamRowActions = {
    onAddToSpace: addToSpace,
    onArchive: setArchiveWorkstreamTarget,
    onChangeScope: changeWorkstreamScope,
    onMarkUnread: (target: WorkstreamSummary) => void markWorkstreamUnread(target).catch(() => undefined),
    onRemoveFromSpace: (target: WorkstreamSummary, spaceId: string) =>
      onRemoveChannelFromSpace(spaceId, target.id),
    onRemoveFromPlacement: removeFromPlacement,
    onRename: openRename,
    onTogglePin: (target: WorkstreamSummary, pin: boolean) => void togglePin(target, pin),
  };

  /**
   * One Channel row, wherever the sidebar draws it.
   *
   * `drag` is the list's, not the row's: the same Channel is a fixed row in the
   * recent list, a draggable one under the Space that holds it, and a
   * draggable one in the pinned section, and which it is depends on the
   * section asking for it.
   */
  const renderWorkstream = (
    workstream: WorkstreamSummary,
    drag?: WorkstreamRowDrag,
    placementSpaceId?: string,
  ): React.JSX.Element => (
    <WorkstreamRow
      {...workstreamRowActions}
      debugEnabled={debugEnabled}
      {...(drag ? { drag } : {})}
      pinPending={pinPendingWorkstreamId === workstream.id}
      motionMove={motionMoveIntent.current?.id === workstream.id
        && motionMoveIntent.current.pinned === (workstream.pinPosition !== null)}
      {...(placementSpaceId !== undefined ? { placementSpaceId } : {})}
      spaces={placementSpaces}
      workspace={workspace}
      workstream={workstream}
      onOpen={() => {
        setSpacesCollapsed(true);
        setSidebarCollapsed(true);
      }}
    />
  );

  const commitPlacementOrder = async (spaceId: string, ids: string[]): Promise<void> => {
    setPlacementOrder({ spaceId, itemIds: ids });
    setPlacementFailure(null);
    try {
      await onReorderContainer({ container: { kind: 'space', id: spaceId }, itemIds: ids });
    } catch {
      setPlacementFailure(spaceId);
    } finally {
      setPlacementOrder((current) => current?.spaceId === spaceId && current.itemIds === ids ? null : current);
    }
  };

  const placementRowDrag = (workstream: WorkstreamSummary, index: number): WorkstreamRowDrag => ({
    dragging: placementDrag.current?.workstreamId === workstream.id && activePlacementOrder !== null,
    position: selectedSpace ? `In ${selectedSpace.name}, ${index + 1} of ${unpinnedWorkstreams.length}.` : '',
    onDragStart: (target) => {
      if (selectedSpaceId === null) return;
      placementDrag.current = { workstreamId: target.id, dropped: false, spaceId: selectedSpaceId };
      setPlacementOrder({ spaceId: selectedSpaceId, itemIds: unpinnedWorkstreams.map((item) => item.id) });
    },
    onDragOver: (targetId) => {
      const current = placementDrag.current;
      if (!current || current.spaceId !== selectedSpaceId || current.workstreamId === targetId) return;
      setPlacementOrder((held) => {
        const ids = held?.spaceId === current.spaceId
          ? held.itemIds
          : unpinnedWorkstreams.map((item) => item.id);
        const targetIndex = ids.indexOf(targetId);
        return targetIndex < 0
          ? held
          : { spaceId: current.spaceId, itemIds: moveWithin(ids, current.workstreamId, targetIndex) };
      });
    },
    onDrop: () => {
      if (!placementDrag.current) return false;
      placementDrag.current = { ...placementDrag.current, dropped: true };
      return true;
    },
    onDragEnd: (cancelled) => {
      const current = placementDrag.current;
      const held = current && placementOrder?.spaceId === current.spaceId
        ? placementOrder.itemIds
        : null;
      placementDrag.current = null;
      const next = committedOrder(held, storedUnpinnedIds, cancelled || current?.dropped !== true);
      if (next && current) void commitPlacementOrder(current.spaceId, next);
      else setPlacementOrder(null);
    },
    onMove: (target, direction) => {
      const from = unpinnedWorkstreams.findIndex((item) => item.id === target.id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= unpinnedWorkstreams.length) return;
      if (selectedSpaceId === null) return;
      void commitPlacementOrder(selectedSpaceId, moveWithin(unpinnedWorkstreams.map((item) => item.id), target.id, to));
    },
  });

  const closeRename = (): void => {
    if (renaming) return;
    setRenameTarget(null);
    setRenameFailed(false);
  };

  const submitRename = async (): Promise<void> => {
    const title = renameTitle.trim();
    if (!renameTarget || !title || title === renameTarget.title) return;
    setRenaming(true);
    setRenameFailed(false);
    try {
      await onRenameWorkstream(renameTarget, title);
      reportTelemetryProductIntent({
        kind: 'workstream_action_completed',
        workstreamId: renameTarget.id,
        action: 'rename',
        visibility: telemetryVisibility(renameTarget.scope),
        origin: renameTarget.systemKind ? 'system' : 'ad_hoc',
        pinned: renameTarget.pinPosition !== null,
      });
      setRenameTarget(null);
    } catch {
      setRenameFailed(true);
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
      const measuredEdge = panel.current?.getBoundingClientRect().right ?? 0;
      const edge = measuredEdge > 0 ? measuredEdge : effectiveSidebarWidth;
      const near = Math.abs(event.clientX - edge) <= EDGE_REVEAL_DISTANCE;
      setPointerNearEdge((current) => current === near ? current : near);
    };
    window.addEventListener('pointermove', track);
    return () => window.removeEventListener('pointermove', track);
  }, [effectiveSidebarWidth]);

  const resizeSidebar = useCallback((requestedWidth: number): void => {
    const availableWidth = window.innerWidth - SIDEBAR_CONTENT_MIN_WIDTH;
    if (compact) {
      if (requestedWidth < SIDEBAR_EXPAND_DRAG_THRESHOLD || availableWidth < MIN_SIDEBAR_WIDTH) return;
      setSidebarCollapsed(false);
      setSidebarWidth(Math.min(requestedWidth, availableWidth));
      return;
    }
    if (requestedWidth < SIDEBAR_COLLAPSE_DRAG_THRESHOLD) {
      setSidebarCollapsed(true);
      return;
    }
    if (availableWidth < MIN_SIDEBAR_WIDTH) return;
    setSidebarWidth(Math.min(requestedWidth, availableWidth));
  }, [compact, setSidebarCollapsed, setSidebarWidth]);

  useEffect(() => {
    if (!resizing) return undefined;

    const move = (event: PointerEvent): void => {
      const left = panel.current?.getBoundingClientRect().left ?? 0;
      const requested = event.clientX - left - grabOffset.current;
      setDragWidth(Math.max(0, requested));
      resizeSidebar(requested);
    };
    const stop = (): void => { setResizing(false); setDragWidth(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [resizeSidebar, resizing]);

  useEffect(() => {
    const toggleCompact = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      setSidebarCollapsed(!sidebarCollapsed);
    };
    window.addEventListener('keydown', toggleCompact, true);
    return () => window.removeEventListener('keydown', toggleCompact, true);
  }, [setSidebarCollapsed, sidebarCollapsed]);

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

  // A layout effect, declared before `useListMotion` below, so that the scroll
  // happens before the motion starts: the motion's first frame translates the
  // row back to the slot it left, `scrollIntoView` scrolls to the box as
  // transformed, and `nearest` would then find the row still on screen where
  // it used to be and scroll to nothing.
  useLayoutEffect(() => {
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
    const pinnedInSelectedSpace = selectedSpaceId !== null
      && row.spaceIds.includes(selectedSpaceId)
      && row.spacePins?.some((pin) => pin.spaceId === selectedSpaceId);
    if (pinnedInSelectedSpace !== reveal.pinned) return;
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
  }, [reveal, selectedSpaceId, workstreams]);

  // A row that changes place — a message moving it up its group, a pin moving
  // it between sections, a drag or an Alt+Arrow in the pinned list — travels
  // there rather than reappearing: out to the left, the rows between closing
  // the gap, then in from the left at its new slot. After the reveal above,
  // and for the reason given there. The compact toggle relays out every row
  // for a reason that is not a move, so it names the layout, and says for how
  // long the rows are still travelling to it. The command bar above the scroll
  // box is a list of its own, whose New work stream row arrives and leaves with
  // the same toggle.
  useListMotion(scrollRef, compact, layoutSettling);
  useListMotion(commandRef, compact, layoutSettling);

  const createChannelFromSidebar = useCallback(async (input: { name: string; spaceId: string }): Promise<void> => {
    markSurfaceEntrypoint('sidebar_new');
    try {
      await onCreateChannel(input);
    } catch (cause) {
      markSurfaceEntrypoint('direct');
      throw cause;
    }
  }, [onCreateChannel]);
  const createSpaceFromSidebar = useCallback(async (name: string): Promise<void> => {
    const created = await onCreateSpace({ name, colorKey: 'blue', iconKey: 'briefcase', scope: 'personal' });
    void navigate(`/spaces/${created.id}`);
  }, [navigate, onCreateSpace]);

  // Active standalone Sidekicks occupy the strip. Until one exists, its empty
  // slot remains the dashed New Sidekick action; the whole section stays absent
  // only while the workspace answer is still loading.
  const sidekickShortcuts = sidekickShortcutsLoaded && (
    <section
      aria-label={standaloneSidekicks.length > 0 ? 'Sidekick shortcuts' : 'Sidekicks'}
      className="sidebar-automation-strip"
      onClick={() => setSidebarOpen(false)}
    >
      {standaloneSidekicks.length > 0
        ? standaloneSidekicks.map((sidekick) => <SidekickTile key={sidekick.id} sidekick={sidekick} />)
        : <NewSidekickTile target={resumablePersonalDraft?.id ?? NEW_SIDEKICK_TARGET} />}
    </section>
  );

  return (
    <>
      {spaces !== undefined && <SpacesSidebar
        accountSlotRef={setAccountSlot}
        sidekickSlotRef={setSidekickSlot}
        collapsed={spacesCollapsed}
        currentPath={location.pathname}
        inactiveSpaces={inactiveSpaces}
        loading={loading}
        onArchive={onArchiveSpace}
        onCollapsedChange={setSpacesCollapsed}
        onCreateChannel={createChannelFromSidebar}
        onCreateSpace={createSpaceFromSidebar}
        onImportChannel={onImportChannel}
        onOpenSearch={onOpenSearch}
        onOrderPreviewChange={setSpaceOrderPreview}
        onAddChannel={onAddChannelToSpace}
        onReorder={onReorderContainer}
        onRetry={onRetrySpaces}
        onRestore={onRestoreSpace}
        onSelect={(spaceId) => {
          setSelectedSpaceId(spaceId);
          setSpacesCollapsed(true);
          setSidebarCollapsed(false);
        }}
        ordering={ordering}
        ready={spacesReady}
        outOfDate={spacesOutOfDate}
        selectedSpaceId={selectedSpaceId}
        spaces={placementSpaces}
        workstreams={workstreams}
      />}
      <IconButton className="mobile-sidebar-trigger" label="Open navigation" onClick={() => setSidebarOpen(true)}>
        <Menu size={17} />
      </IconButton>
      {sidebarOpen && <button aria-label="Close navigation" className="sidebar-scrim" onClick={() => setSidebarOpen(false)} type="button" />}
      <NavigationFrame
        aria-label="Rally navigation"
        className={clsx('sidebar', spaces !== undefined && 'channels-sidebar', compact && 'is-compact', sidebarOpen && 'is-mobile-open', (resizing || keyResizing) && 'is-resizing')}
        data-sidebar-collapsed={compact ? '' : undefined}
        onTransitionCancel={trackLayoutTransition}
        onTransitionEnd={trackLayoutTransition}
        onTransitionRun={trackLayoutTransition}
        ref={panel}
      >
        <div className={clsx('sidebar-titlebar window-drag', spaces !== undefined && 'channels-sidebar-titlebar')}>
          {selectedSpace && <>
            <h2 className="channels-sidebar-title">{selectedSpace.name}</h2>
            <span aria-hidden="true" className="channels-sidebar-toolbar-mark">
              <SpaceIcon size={22} space={selectedSpace} />
            </span>
          </>}
          <IconButton className="window-no-drag mobile-only" label="Close navigation" onClick={() => setSidebarOpen(false)}>
            <ChevronsLeft size={16} />
          </IconButton>
          {/* Hidden rather than unmounted in the rail, so it can fade out with
              the layout instead of vanishing a frame ahead of it; the row that
              takes its place is the one above the search row below. The
              fade holds `display` for its length, so the button leaves the
              accessibility tree and the tab order by attribute at once
              rather than when the fade ends, or the rail would offer two New
              work stream buttons for a quarter of a second. */}
          {spaces === undefined && <NewWorkstreamMenu
            canCreateSpace={spaces !== undefined && spacesReady}
            spaces={placementSpaces}
            onCreateChannel={createChannelFromSidebar}
            onCreateSpace={createSpaceFromSidebar}
            onImportChannel={onImportChannel}
          >
            <button
              aria-hidden={compact}
              aria-label={NEW_STREAM_LABEL}
              className={clsx('sidebar-new-button window-no-drag', onNewStreamRoute && 'is-active')}
              hidden={compact}
              tabIndex={compact ? -1 : undefined}
              type="button"
            >
              <Plus aria-hidden="true" size={16} />
            </button>
          </NewWorkstreamMenu>}
        </div>

        {spaces === undefined && <div className="sidebar-commandbar window-no-drag" onClick={() => setSidebarOpen(false)} ref={commandRef}>
          {/* The rail's New work stream row. Inserted by the compact toggle and
              removed by the expand, and marked so that it is seen arriving and
              leaving rather than appearing in place: it slides in above the
              search row as the bar opens the slot for it, and out to the left
              as the slot closes. See `useListMotion`. */}
          {compact && (
            // `Tip` renders no element of its own, which is what lets this link
            // stay the command bar's own grid item: the bar is two tracks, and a
            // wrapper between them would take the slot this row is sized by and
            // leave the link inside a track meant for it. The planner is not the
            // reason — it finds a keyed row at any depth. The tip hangs off the
            // rail's right rather than below, where the row under it would be
            // covered.
            <NewWorkstreamMenu
              tooltipSide="right"
              canCreateSpace={spaces !== undefined && spacesReady}
              spaces={placementSpaces}
              onCreateChannel={createChannelFromSidebar}
              onCreateSpace={createSpaceFromSidebar}
              onImportChannel={onImportChannel}
            >
              <button type="button"
                aria-label={NEW_STREAM_LABEL}
                className={clsx('sidebar-new-button sidebar-rail-new-button window-no-drag', onNewStreamRoute && 'is-active')}
                data-motion-insert=""
                data-motion-key="action:new"
                onClick={(event) => event.stopPropagation()}
              >
                <Plus aria-hidden="true" size={19} strokeWidth={1.6} />
              </button>
            </NewWorkstreamMenu>
          )}
          <SidebarSearch mode="button" onClick={onOpenSearch} disabled={!onOpenSearch} aria-label="Search organization" />
        </div>
        }

        <nav
          className="sidebar-scroll"
          onClick={() => setSidebarOpen(false)}
          onScroll={loadMoreWhenNearBottom}
          ref={scrollRef}
        >
          {spaces === undefined && !conversationOnly && <div className="sidebar-primary-actions sidebar-secondary-actions">
            <NewWorkstreamMenu
              canCreateSpace={spaces !== undefined && spacesReady}
              spaces={placementSpaces}
              onCreateChannel={createChannelFromSidebar}
              onCreateSpace={createSpaceFromSidebar}
              onImportChannel={onImportChannel}
            >
              <button type="button"
                className={clsx('sidebar-action', onNewStreamRoute && 'is-active')}
                onClick={(event) => event.stopPropagation()}
              >
                <Plus aria-hidden="true" size={15} />
                <span>{NEW_STREAM_LABEL}</span>
              </button>
            </NewWorkstreamMenu>
          </div>}
          {/*
            A member with no Channels at all, told so.

            The line the time-grouped list used to carry, in the one state that
            list existed to describe: a brand-new Organization shows **Spaces →
            General → No channels** and then, without this, nothing — a sidebar
            that has stopped talking rather than one that is empty. It sits
            under the hierarchy because that is where the reader has just been
            told where Channels live, and it is one line rather than a section
            because there is no list to head.

            Nothing pinned and nothing unplaced are both implied by the test:
            all three sections draw from the same rows.
          */}
          {spacesEnabled && !loading && visibleWorkstreams.length === 0 && (
            // In a section of its own, for the gap every other section carries:
            // hung directly off the nav it lands against the last Space's own
            // "No channels" and reads as a second line of that Space's rather
            // than as the sidebar's.
            <div className="sidebar-section">
              <p className="sidebar-empty">No channels yet</p>
            </div>
          )}

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
              data-motion-scope={selectedSpaceId ? `space:${selectedSpaceId}` : undefined}
              // The rows inside are the slots this list's drag is measured
              // against; the placements under a Space carry the same mark.
              data-reorder-list=""
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => event.preventDefault()}
            >
              {/* Held: a heading travels with the rows under it and is never
                  the thing seen to leave. See `useListMotion`. */}
              <div className="sidebar-section-heading" data-motion-hold="" data-motion-key="heading:pinned">
                <h2 id="pinned-heading">Pinned</h2>
              </div>
              {/* Said once for the section rather than repeated on every row:
                  as a per-row description it lands inside each link's
                  accessible name, so somebody arrowing through the list hears
                  the whole instruction again before every title. */}
              <p className="sr-only" id={PINNED_DRAG_HINT_ID}>
                Hold Alt and press the up or down arrow to move a pinned channel.
              </p>
              <div className="sidebar-list">
                {pinnedWorkstreams.map((pinned, index) => (
                  <WorkstreamRow
                    {...workstreamRowActions}
                    debugEnabled={debugEnabled}
                    drag={pinnedRowDrag(pinned, index)}
                    key={pinned.id}
                    {...(selectedSpaceId !== null ? { placementSpaceId: selectedSpaceId } : {})}
                    pinPending={pinPendingWorkstreamId === pinned.id}
                    motionMove={motionMoveIntent.current?.id === pinned.id
                      && motionMoveIntent.current.pinned}
                    spaces={placementSpaces}
                    workspace={workspace}
                    workstream={pinned}
                  />
                ))}
              </div>
            </section>
          )}

          {pinnedWorkstreams.length > 0 && unpinnedWorkstreams.length > 0 && (
            <hr
              aria-label="Pinned and unpinned channels"
              className="sidebar-section-divider"
            />
          )}

          {/*
            Below the Spaces, and the whole of what is left of the flat list.

            For a member this is **Other channels**: the Channels whose only
            placements are Spaces this reader cannot see. The time-grouped
            recency list is gone for them — every Channel is in a Space, so the
            hierarchy above says where everything lives, and a second list of
            the same rows ordered by time was the same sidebar twice. The guest
            shell has no hierarchy to say it with and keeps that list exactly as
            it was.

            Absent, rather than an empty heading, when a member has nothing
            unplaced — which is the ordinary state, and the state the product
            is trying to be in.
          */}
          {(
          <section
            aria-describedby={spacesEnabled && unpinnedWorkstreams.length > 1 ? PLACEMENT_DRAG_HINT_ID : undefined}
            aria-label="Channels"
            className="sidebar-section workstreams-section"
          >
            {/* The one announcement for the whole wait, and the only one: the
                spaces and automations above load from the same answer, so a
                live region in either of those sections would say the same thing
                twice. It is tied to the wait rather than to this section's own
                placeholder because cached channels may already be visible
                while the sections above are still filling in. */}
            {loading && (
              <div role="status">
                <span className="sr-only">Loading your spaces and channels</span>
              </div>
            )}
            {spacesEnabled && unpinnedWorkstreams.length > 1 && (
              <p className="sr-only" id={PLACEMENT_DRAG_HINT_ID}>
                Hold Alt and press the up or down arrow to move a channel in this space.
              </p>
            )}
            {loading && visibleWorkstreams.length === 0 ? (
              <>
                <SidebarSkeletonGroup count={4} />
                <SidebarSkeletonGroup count={3} />
              </>
            ) : spacesEnabled ? (
              unpinnedWorkstreams.length > 0 && (
                /* The selected Space above is the heading for this rail. A
                   second "Channels" label only restates the level the rail
                   already represents and pushes its rows down. */
                <div className="sidebar-list" data-motion-scope={selectedSpaceId ? `space:${selectedSpaceId}` : undefined} data-reorder-list="">
                  {placementFailure === selectedSpaceId && <InlineError>The channels in that space couldn’t be reordered.</InlineError>}
                  {unpinnedWorkstreams.map((workstream, index) => (
                    <Fragment key={workstream.id}>{renderWorkstream(
                      workstream,
                      spacesReady && selectedSpace ? placementRowDrag(workstream, index) : undefined,
                      selectedSpaceId ?? undefined,
                    )}</Fragment>
                  ))}
                </div>
              )
            ) : groups.length === 0 ? (
              // Pinned work streams are work streams, so the empty line only
              // holds when nothing is pinned either; with everything pinned the
              // section has nothing left to say and says nothing.
              pinnedWorkstreams.length === 0 && (
                <p className="sidebar-empty">No channels yet</p>
              )
            ) : (
              groups.map((group) => (
                <div className="sidebar-group" key={group.label}>
                  <div className="sidebar-group-heading" data-motion-hold="" data-motion-key={`heading:${group.label}`}>
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
                              group.streams,
                            )}
                          >
                            Mark all as read
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="menu-item menu-item-danger"
                            onSelect={() => openWorkstreamBatch(
                              group.label,
                              { kind: 'archive' },
                              group.streams,
                            )}
                          >
                            Archive all
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                  <div className="sidebar-list">
                    {group.streams.map((item) => (
                      <WorkstreamRow
                        {...workstreamRowActions}
                        debugEnabled={debugEnabled}
                        key={item.id}
                        pinPending={pinPendingWorkstreamId === item.workstream.id}
                        spaces={placementSpaces}
                        workspace={workspace}
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
            {(loadingMoreWorkstreams) && (
              <p aria-live="polite" className="sidebar-empty">Loading more…</p>
            )}

          </section>
          )}
        </nav>

        {/*
          OnboardingChecklist is disabled: it was left over from a demo and
          never wired to real product state. `completed` is local-only
          `useState`, seeded empty on every mount and never persisted, so the
          "3 / 3" a user sees is just three checkboxes they clicked themselves
          in the current session — there is no dismiss action because the box
          was never meant to reflect (or need clearing based on) anything
          real. Reported (Aug 2026) as blocking the chat input with no way to
          close it even at "3 / 3"; Adam Juhasz confirmed this is dead demo
          code, not a real feature.

          To bring this back for real: replace `completed` with derived state
          from actual signals (a connected tool/integration exists, an
          automation has been created, a teammate has been invited), and add
          a dismiss mechanism (e.g. a persisted "onboarding dismissed" flag)
          once those signals exist — a checklist that can reach 3/3 has to be
          closeable.
        */}
        {/* <OnboardingChecklist /> */}

        {/* Below the scroll box in both layouts: a horizontal strip in the
            rail as in the full sidebar, one tile wide with the next peeking. */}
        {spaces === undefined && <div ref={setSidekickSlot} />}
        {sidekickSlot && sidekickShortcuts && createPortal(sidekickShortcuts, sidekickSlot)}

        <div className="sidebar-collapse-footer">
        {spaces === undefined && <div className="sidebar-account-slot" ref={setAccountSlot} />}
        {accountSlot && createPortal(accountMenu ?? <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button aria-label="Open account menu" className="account-trigger window-no-drag" type="button">
              <Avatar member={workspace.currentUser} size="small" />
              <span className="account-copy">
                <strong>{workspace.currentUser.name}</strong>
              </span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" className="menu-content" side="top" sideOffset={8}>
              <DropdownMenu.Label className="menu-label">
                <span>{workspace.currentUser.email}</span>
                <small>{workspace.region} workspace</small>
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item asChild className="menu-item">
                <button onClick={() => void desktopBridge().openSettings()} type="button">
                  <Settings size={14} /> Settings…
                </button>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="menu-item account-menu-item"
                onSelect={() => void openPublicPage('/').catch(() => undefined)}
              >
                <Smartphone aria-hidden="true" />
                <span>Get Rally for iOS</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="menu-item account-menu-item"
                onSelect={() => void desktopBridge().openSettings()}
              >
                <Settings aria-hidden="true" />
                <span>Settings</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="menu-item account-menu-item"
                onSelect={() => void openPublicPage('/').catch(() => undefined)}
              >
                <Info aria-hidden="true" />
                <span>About</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="menu-item account-menu-item"
                onSelect={() => void openPublicPage('/support/').catch(() => undefined)}
              >
                <CircleHelp aria-hidden="true" />
                <span>Help Center</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="menu-item account-menu-item"
                onSelect={() => void openPublicPage('/support/').catch(() => undefined)}
              >
                <Megaphone aria-hidden="true" />
                <span>Send Feedback</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu-separator account-menu-separator" />
              <DropdownMenu.Item className="menu-item account-menu-item" onSelect={onSignOut}>
                <LogOut aria-hidden="true" />
                <span>Log out</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>, accountSlot)}
          <IconButton className="window-no-drag" label={compact ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!compact} disabled={forcedCompact} title={forcedCompact ? 'Widen the window to expand navigation' : undefined} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
            {compact ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
        </div>
        {resizing && dragWidth !== null && <div aria-hidden="true" className="sidebar-drag-guide" style={{ left: dragWidth }} />}
        {/* The hint names the double-click only while it would do something:
            a window too narrow to hold the expanded sidebar pins it compact,
            and the toggle in the footer is disabled for the same reason. */}
        <DragHint
          action="Drag to resize"
          suppressed={resizing}
          shortcut={forcedCompact ? undefined : compact ? 'Double-click or Enter to expand' : 'Double-click or Enter to collapse'}
        >
          <div
            aria-label="Resize navigation"
            aria-orientation="vertical"
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuemin={COLLAPSED_SIDEBAR_WIDTH}
            aria-valuenow={effectiveSidebarWidth}
            className={clsx('sidebar-resizer', pointerNearEdge && 'is-near')}
            onDoubleClick={() => { if (!forcedCompact) setSidebarCollapsed(!sidebarCollapsed); }}
            onBlur={() => setKeyResizing(false)}
            onKeyDown={(event) => {
              // The same toggle the double-click performs, on the key the ARIA
              // authoring practices give a splitter. The arrows reach the
              // collapsed width too, by crossing its threshold, but the hint
              // names a gesture a keyboard cannot make, so it has to name a key
              // as well.
              if (event.key === 'Enter') {
                event.preventDefault();
                if (!forcedCompact) setSidebarCollapsed(!sidebarCollapsed);
                return;
              }
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              setKeyResizing(true);
              if (event.key === 'ArrowLeft' && !compact) {
                resizeSidebar(sidebarWidth > MIN_SIDEBAR_WIDTH
                  ? sidebarWidth - 16
                  : SIDEBAR_COLLAPSE_DRAG_THRESHOLD - 1);
              }
              if (event.key === 'ArrowRight') resizeSidebar(compact ? MIN_SIDEBAR_WIDTH : sidebarWidth + 16);
            }}
            onKeyUp={() => setKeyResizing(false)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              // Measure the panel rather than reading the width state. The handle
              // is drawn at the sidebar's trailing edge, and while a collapse or
              // expand is still travelling that edge is not yet the width the
              // state holds — an offset taken from the state would be wrong by
              // however far the animation had left to go, and stay wrong for the
              // whole drag. The work-stream sidebar's handle already measures.
              const edge = panel.current?.getBoundingClientRect().right;
              grabOffset.current = event.clientX - (edge ?? effectiveSidebarWidth);
              setResizing(true);
            }}
            role="separator"
            tabIndex={0}
          >
            <span aria-hidden="true" className="sidebar-resizer-handle">
              <GripVertical size={11} strokeWidth={2} />
            </span>
          </div>
        </DragHint>
      </NavigationFrame>
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
        title="Rename channel"
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
              aria-label="Channel name"
              autoFocus
              maxLength={180}
              onChange={(event) => setRenameTitle(event.currentTarget.value)}
              value={renameTitle}
            />
          </label>
        </form>
        {renameFailed && <InlineError>The channel couldn’t be renamed.</InlineError>}
      </Modal>

      <Modal
        footer={(
          <>
            <Button disabled={batchApplying} onClick={closeWorkstreamBatch}>Cancel</Button>
            <Button
              className={batchTarget?.update.kind === 'archive' ? 'button-danger' : 'button-primary'}
              disabled={batchApplying || batchPreviewing || batchPreviewFailed
                || (batchTarget !== null && batchTotal(batchTarget) === 0)}
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
          This is a mass change. {batchTarget ? batchSubject(batchTarget) : '0 channels'} in{' '}
          <strong>{batchTarget?.label}</strong> will be{' '}
          {batchTarget?.update.kind === 'archive' ? 'archived' : 'marked as read'}. Are you sure?
        </p>
        {batchPreviewing && <p aria-live="polite" className="modal-copy">Checking the current total…</p>}
        {batchFailure && <InlineError>{batchFailure === 'preview'
          ? 'The channels couldn’t be counted. Try again.'
          : 'The channels couldn’t be updated. Try again.'}</InlineError>}
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
        title="Archive channel"
      >
        <p className="modal-copy">
          <strong>{archiveWorkstreamTarget?.title}</strong> leaves the sidebar for everyone who can
          see it, and nobody — you included — will be able to open it again. A run still in flight
          is stopped, scheduled follow-ups stop, and mail to its address is refused. Nothing is
          deleted, but Rally has no way to bring a channel back.
        </p>
      </Modal>
      <Modal
        footer={<Button onClick={() => setMenuFailure(null)}>Close</Button>}
        onOpenChange={(open) => {
          if (!open) setMenuFailure(null);
        }}
        open={Boolean(menuFailure)}
        title={menuFailure ? sidebarMenuFailureCopy[menuFailure].title : 'That could not be updated'}
      >
        {menuFailure && <p className="modal-copy">{sidebarMenuFailureCopy[menuFailure].copy}</p>}
      </Modal>
      <Modal
        footer={<Button onClick={() => setRemoveFromSpaceFailure(null)}>Close</Button>}
        onOpenChange={(open) => {
          if (!open) setRemoveFromSpaceFailure(null);
        }}
        open={removeFromSpaceFailure !== null}
        title="Channel could not be removed from that space"
      >
        {removeFromSpaceFailure && <p className="modal-copy">{removeFromSpaceFailure}</p>}
      </Modal>
    </>
  );
}
