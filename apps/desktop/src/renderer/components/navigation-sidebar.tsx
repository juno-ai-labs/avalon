import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ActivityFilter, ActivityItem, ActivityPage, ConversationAccessRequestItem, PinKind, SpaceSummary, WorkstreamAppearance } from '@rally/contracts';
import { IdentityTile, ShapeOutline, type TileBadge } from '@rally/ui/components/identity-tile';
import { resolveWorkstreamAppearance, WORKSTREAM_ICON_COMPONENTS } from '@rally/ui/components/workstream-glyph';
import { markColors } from '@rally/ui/lib/project-palette';
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsSort,
  IconCancel,
  IconCheck,
  IconChecks,
  IconClock,
  IconCloudDownload,
  IconCornerDownRight,
  IconDeviceDesktopDown,
  IconLock,
  IconMenu2,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { notifyManager, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Sparkle } from 'lucide-react';
import clsx from 'clsx';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom';

import type { AttentionItem } from '../lib/attention-items';
import { useAppSession } from '../lib/app-session';
import { consumeDeepLinkWorkstreamNavigation, useDeepLinkWorkstreamNavigation } from '../lib/deep-link-navigation';
import { desktopBridge } from '../lib/platform';
import { formatDateTime, formatSidebarActivityTime, formatTime, readerMarkerStatus } from '../lib/format';
import { layoutInsertIndex, layoutRowAt } from '../lib/list-motion';
import { channelRoute, homeChannelId, threadRoute } from '../lib/navigation-routes';
import { moveWithin } from '../lib/personal-order';
import { compareChannels } from '../lib/sidebar-channel-order';
import { ACTIVITY_QUERY_KEY, CHANNEL_STATS_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, MY_THREADS_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import { useNamingSkeleton } from '../lib/naming-skeleton';
import { latestPinWrite, reportThreadPin, usePinAction, usePinFailure, usePins, usePinWrite, type PinnedThread } from '../lib/pins';
import { markSurfaceEntrypoint, markWorkstreamFeedOpenStarted, markWorkstreamNavigation } from '../lib/telemetry';
import type { SpaceConversationSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { useUiStore, type SidebarChannelSort, type SidebarSection } from '../lib/ui-store';
import { useListMotion } from '../lib/use-list-motion';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { openWorkstreamId } from '../lib/workstream-landing';
import { useWorkstreamSocketHoverWarmup, useWorkstreamSocketOpenContext } from '../lib/workstream-socket-pool';
import { Button, IconButton, InlineError, Modal, TitleSkeleton, Tip } from './primitives';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import { RelativeTime } from './relative-time';
import { ResizableSidebar, SidebarFooterItems, SidebarScroll } from '@rally/ui/components/resizable-sidebar';
import type { ChannelStats, SpaceDirectory } from '@rally/contracts';

const NAVIGATION_SHEET_ID = 'rally-navigation-sheet';
/** The stylesheet's phone breakpoint: at or under it the sidebar is a sheet. */
const PHONE_LAYOUT_MAX_WIDTH = 640;
/**
 * How long a pin's scroll-to-row waits for the list to carry the pin before
 * giving up. Carried over from the sidebar this one replaced.
 */
const REVEAL_DEADLINE_MS = 2_000;

/**
 * Each section's button is the outline of what its list holds: a Channel is a
 * squircle and a Thread a circle, as their rows draw them. Activity holds
 * neither, so it takes the triangle no object uses.
 */
const SECTIONS: ReadonlyArray<{ id: SidebarSection; label: string; icon: ReactNode }> = [
  { id: 'channels', label: 'Channels', icon: <ShapeOutline shape="squircle" /> },
  { id: 'threads', label: 'Threads', icon: <ShapeOutline shape="circle" /> },
  { id: 'activity', label: 'Activity', icon: <ShapeOutline shape="triangle" /> },
];

const THREAD_SORTS: ReadonlyArray<{ sort: SidebarChannelSort; label: string }> = [
  { sort: 'recent', label: 'Recent' },
  { sort: 'alphabetical', label: 'A–Z' },
  { sort: 'needs_you', label: 'Needs attention' },
];

/** The Channels tab's cycle: A–Z first, because a Channel list is looked up by name. */
const CHANNEL_SORTS: ReadonlyArray<{ sort: SidebarChannelSort; label: string }> = [
  { sort: 'alphabetical', label: 'A–Z' },
  { sort: 'recent', label: 'Recent' },
  { sort: 'needs_you', label: 'Needs attention' },
];

function compareChannelNames(left: SpaceSummary, right: SpaceSummary): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

/**
 * The comparator for the Channels nobody pinned. Recent is the Channel's last
 * activity, newest first, a Channel with none last. Needs attention puts an
 * unread Channel first, then one holding a thread that needs this person, each
 * group in Recent order. `heldId` is the open Channel: opening one reads it,
 * and without the hold it would drop out from under the pointer, as the
 * Threads tab's Needs attention does.
 */
export function compareChannelRows(
  sort: SidebarChannelSort,
  statsById: ReadonlyMap<string, ChannelStats>,
  heldId: string | null = null,
): (left: SpaceSummary, right: SpaceSummary) => number {
  if (sort === 'alphabetical') return compareChannelNames;
  const recent = (left: SpaceSummary, right: SpaceSummary): number => {
    const leftAt = statsById.get(left.id)?.lastActivityAt ?? null;
    const rightAt = statsById.get(right.id)?.lastActivityAt ?? null;
    if (leftAt !== rightAt) {
      if (leftAt === null) return 1;
      if (rightAt === null) return -1;
      const delta = Date.parse(rightAt) - Date.parse(leftAt);
      if (delta !== 0) return delta;
    }
    return compareChannelNames(left, right);
  };
  if (sort === 'recent') return recent;
  const rank = (space: SpaceSummary): number => space.id === heldId || statsById.get(space.id)?.hasUnread === true
    ? 2
    : (space.attentionCount ?? 0) > 0 ? 1 : 0;
  return (left, right) => rank(right) - rank(left) || recent(left, right);
}

export type AccessDecision = 'approve' | 'decline';

/**
 * The sidebar: a section switcher (Channels, Threads, Activity) beside one
 * list. One list column with a tab switcher, never stacked hierarchy rails —
 * the reason the 2026-10-01 change removed three of them still holds
 * (`docs/desktop-shell.md`). Shared by the Mac app and the browser.
 */
export function NavigationSidebar({
  accessDecisionFailed,
  accessRequests,
  accountMenu,
  attentionComplete,
  attentionItems,
  downloadedUpdate,
  footerItems,
  onDecideAccessRequest,
  onOpenAccessRequest,
  onOpenImport,
  onOpenSearch,
  workspace,
}: {
  accessDecisionFailed: boolean;
  accessRequests: readonly ConversationAccessRequestItem[];
  accountMenu: ReactNode;
  attentionComplete: boolean;
  attentionItems: readonly AttentionItem[];
  downloadedUpdate: string | null;
  footerItems?: ReactNode;
  onDecideAccessRequest: (request: ConversationAccessRequestItem, decision: AccessDecision) => void;
  onOpenAccessRequest: (request: ConversationAccessRequestItem) => void;
  onOpenImport?: (() => void) | undefined;
  onOpenSearch?: (() => void) | undefined;
  workspace: Workspace;
}): React.JSX.Element {
  const chosenSection = useUiStore((state) => state.sidebarSection);
  const setSection = useUiStore((state) => state.setSidebarSection);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  // The phone sheet. Escape closes it as it would any menu and hands focus
  // back to the button; widening past the phone layout closes it, so an open
  // sheet never leaves the conversation behind it inert at a width that draws
  // no sheet. Both carried over from the sidebar this one replaced.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent): void => {
      // A menu or dialog open over the sheet takes this Escape for itself.
      if (event.key !== 'Escape' || document.querySelector('[role="menu"], [role="dialog"]')) return;
      setSidebarOpen(false);
      menuToggle.current?.focus();
    };
    const closeWhenWide = (): void => {
      if (window.innerWidth > PHONE_LAYOUT_MAX_WIDTH) setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('resize', closeWhenWide);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('resize', closeWhenWide);
    };
  }, [setSidebarOpen, sidebarOpen]);
  // Opening anything closes the sheet, whoever navigated: a row, a search
  // result, a new Channel. Switching sections does not navigate, so the
  // sheet stays open on the list just picked.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname, setSidebarOpen]);
  const [accountSlot, setAccountSlot] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLElement | null>(null);
  const guest = workspace.currentUser.accessClass === 'guest';
  // A guest has no Channels section: they reach a Channel only through the
  // threads shared with them (the navigation PRD's privacy rules).
  const sections = guest ? SECTIONS.filter((candidate) => candidate.id !== 'channels') : SECTIONS;
  const section = guest && chosenSection === 'channels' ? 'threads' : chosenSection;
  const pinFailure = usePinFailure();
  // The same number as the dock badge and the menu bar: every conversation
  // waiting on this reader, and every access request waiting on them.
  const waiting = attentionItems.length + accessRequests.length;
  const title = SECTIONS.find((candidate) => candidate.id === section)?.label ?? 'Threads';
  const [creatingChannel, setCreatingChannel] = useState(false);
  const markActivityRead = useMarkActivityRead();
  return <ResizableSidebar
    aria-label="Rally navigation"
    className={clsx('sidebar single-sidebar navigation-sidebar', sidebarOpen && 'is-mobile-open')}
    collapsible={false}
    compact={false}
    id={NAVIGATION_SHEET_ID}
    onResize={setSidebarWidth}
    resizeLabel="Resize navigation"
    sidebarRef={panel}
    width={sidebarWidth}
  >
    <div className="navigation-body">
      <nav aria-label="Sections" className="navigation-rail">
        <div className="navigation-rail-top window-drag" />
        {sections.map((candidate) => <button
          aria-current={candidate.id === section ? 'page' : undefined}
          className={clsx('navigation-rail-button window-no-drag', candidate.id === section && 'is-active')}
          key={candidate.id}
          onClick={() => setSection(candidate.id)}
          type="button"
        >
          <span className="navigation-rail-icon">
            {candidate.icon}
            {candidate.id === 'threads' && waiting > 0 && <span
              aria-label={`${waiting} waiting`}
              className={waiting > 99 ? 'navigation-rail-badge is-capped' : 'navigation-rail-badge'}
              role="img"
            >{waiting > 99 ? '99+' : waiting}</span>}
          </span>
          <span className="navigation-rail-label">{candidate.label}</span>
        </button>)}
        <div className="navigation-rail-spacer" />
        <div className="sidebar-account-slot navigation-rail-account" ref={setAccountSlot} />
      </nav>
      <div className="navigation-panel">
        <header className="navigation-panel-header window-drag">
          <IconButton
            aria-controls={NAVIGATION_SHEET_ID}
            aria-expanded={sidebarOpen}
            className="sidebar-menu-toggle window-no-drag"
            label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            ref={menuToggle}
            showTooltip={false}
          >
            {sidebarOpen
              ? <IconX aria-hidden="true" size={18} stroke={1.8} />
              : <IconMenu2 aria-hidden="true" size={18} stroke={1.8} />}
          </IconButton>
          <h1 className="navigation-panel-title">{title}</h1>
          <div className="navigation-panel-actions window-no-drag">
            {downloadedUpdate !== null && <IconButton label={`Restart to update to Rally ${downloadedUpdate}`} onClick={() => void desktopBridge().installDownloadedUpdate()}>
              <IconDeviceDesktopDown aria-hidden="true" size={17} stroke={1.8} />
            </IconButton>}
            {!guest && onOpenImport && <IconButton label="Import a conversation" onClick={onOpenImport}>
              <IconCloudDownload aria-hidden="true" size={17} stroke={1.8} />
            </IconButton>}
            <IconButton disabled={!onOpenSearch} label="Search organization" onClick={onOpenSearch}>
              <IconSearch aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>
            {section === 'channels' && <IconButton label="New channel" onClick={() => setCreatingChannel(true)}>
              <IconPlus aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>}
            {section === 'activity' && <IconButton label="Mark all read" onClick={markActivityRead}>
              <IconChecks aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>}
          </div>
        </header>
        <SidebarScroll className="navigation-panel-scroll" scrollRef={scroll}>
          {pinFailure && <InlineError>{pinFailure}</InlineError>}
          {section === 'threads' && <ThreadsSection scroll={scroll} />}
          {section === 'channels' && <ChannelsSection scroll={scroll} />}
          {section === 'activity' && <ActivitySection
            accessDecisionFailed={accessDecisionFailed}
            accessRequests={accessRequests}
            attentionComplete={attentionComplete}
            guest={guest}
            onDecideAccessRequest={onDecideAccessRequest}
            onOpenAccessRequest={onOpenAccessRequest}
            scroll={scroll}
          />}
        </SidebarScroll>
        {footerItems && <SidebarFooterItems>{footerItems}</SidebarFooterItems>}
      </div>
    </div>
    {accountSlot && createPortal(accountMenu, accountSlot)}
    {creatingChannel && <NewChannelDialog onClose={() => setCreatingChannel(false)} />}
  </ResizableSidebar>;
}

/** The Channel the open route sits under, so a thread opened from a list stays under it. */
function useOpenChannelId(): string | null {
  const location = useLocation();
  return matchPath('/channels/:channelId/*', location.pathname)?.params.channelId
    ?? matchPath('/channels/:channelId', location.pathname)?.params.channelId
    ?? null;
}

function useOpenThreadId(): string | null {
  const location = useLocation();
  return matchPath('/channels/:channelId/threads/:id', location.pathname)?.params.id
    ?? matchPath('/workstreams/:id', location.pathname)?.params.id
    ?? null;
}

/**
 * A Pinned list arranged by dragging, saved on drop. The target slot is the
 * row laid out under the pointer, not the one drawn there mid-motion, or rows
 * in motion would trade places (`docs/list-motion.md`).
 */
function usePinnedDrag(kind: PinKind, ids: readonly string[]): {
  order: readonly string[];
  rowProps: (id: string, index: number) => PinnedRowProps;
  moves: (id: string, index: number) => PinMoves;
} {
  const { api } = useAppSession();
  const write = usePinWrite();
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const order = drag?.order ?? ids;
  // Dragging has a keyboard and a menu path too: Option/Alt with an arrow on
  // a focused row, or Move up / Move down in its menu.
  const moveTo = (id: string, target: number): (() => void) | null => (
    api && target >= 0 && target < ids.length
      ? () => write(api.reorderPins(kind, moveWithin([...ids], id, target)))
      : null
  );
  return {
    order,
    moves: (id, index) => ({ up: moveTo(id, index - 1), down: moveTo(id, index + 1) }),
    rowProps: (id, index) => ({
      'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
      'data-motion-hold': drag?.id === id ? '' : undefined,
      'data-pin-id': id,
      'data-pin-kind': kind,
      onKeyDown: (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        const move = moveTo(id, index + (event.key === 'ArrowUp' ? -1 : 1));
        if (!move) return;
        event.preventDefault();
        move();
      },
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move';
        setDrag({ id, order: [...ids] });
      },
      onDragOver: (event) => {
        if (!drag) return;
        event.preventDefault();
        // Where rows have no layout (jsdom), the row the event reached is the slot.
        const slot = layoutRowAt(
          event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(`[data-pin-kind="${kind}"]`) ?? [],
          event.clientY,
        );
        const target = slot ? drag.order.indexOf(slot.dataset.pinId ?? '') : index;
        if (target >= 0 && drag.order[target] !== drag.id) setDrag({ id: drag.id, order: moveWithin(drag.order, drag.id, target) });
      },
      onDrop: (event) => {
        event.preventDefault();
        if (!drag || !api) { setDrag(null); return; }
        const next = drag.order;
        setDrag(null);
        if (next.join() === ids.join()) return;
        write(api.reorderPins(kind, next));
      },
      onDragEnd: () => setDrag(null),
    }),
  };
}

/** What a row takes from a drag: reordering Pinned, or carrying a row into it. */
type PinnedRowProps = React.HTMLAttributes<HTMLElement> & {
  draggable: boolean;
  'data-motion-hold'?: string | undefined;
  'data-pin-id'?: string;
  'data-pin-kind'?: PinKind;
};

/** An unpinned row being dragged toward Pinned: the slot it would take, and whether it was let go there. */
interface PinDrop {
  id: string;
  kind: PinKind;
  parentId: string | undefined;
  thread: PinnedThread | undefined;
  index: number | null;
  landed: boolean;
}

/**
 * Pinning by dragging an unpinned row into Pinned, at the slot it is dropped
 * in (`docs/workstream-pinning.md`). A landed row stays in Pinned until the
 * pin list holds it.
 */
function usePinDrop(pinnedIds: ReadonlySet<string>, orderOf: (kind: PinKind) => readonly string[]): {
  drop: PinDrop | null;
  sourceProps: (kind: PinKind, id: string, parentId?: string, thread?: PinnedThread) => PinnedRowProps;
  targetProps: React.HTMLAttributes<HTMLElement>;
} {
  const { api } = useAppSession();
  const write = usePinWrite();
  const [state, setState] = useState<PinDrop | null>(null);
  const drop = state && !pinnedIds.has(state.id) ? state : null;
  // A landed row is done once the pin list holds it. Cleared then rather than
  // when the write resolves, which lands a render before the list does; left
  // in place, it would come back the moment the row is unpinned.
  const settled = state?.landed === true && pinnedIds.has(state.id);
  useEffect(() => {
    if (settled) setState(null);
  }, [settled]);
  return {
    drop,
    sourceProps: (kind, id, parentId, thread) => ({
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move';
        // Chromium will not start a drag with an empty payload.
        event.dataTransfer.setData('text/plain', id);
        setState({ id, kind, parentId, thread, index: null, landed: false });
      },
      onDragEnd: () => setState((current) => (current?.landed ? current : null)),
    }),
    targetProps: {
      onDragOver: (event) => {
        if (!drop || drop.landed) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        // The placeholder carries no `data-pin-kind`, so it is not counted.
        const index = layoutInsertIndex(event.currentTarget.querySelectorAll(`[data-pin-kind="${drop.kind}"]`), event.clientY);
        if (index !== drop.index) setState({ ...drop, index });
      },
      onDragLeave: (event) => {
        // Crossing from the section into one of its own rows is not leaving it.
        if (!drop || drop.landed || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setState({ ...drop, index: null });
      },
      onDrop: (event) => {
        if (!drop || drop.landed || !api) return;
        event.preventDefault();
        const index = drop.index ?? orderOf(drop.kind).length;
        setState({ ...drop, index, landed: true });
        let issued = 0;
        const pinned = api.setPinned(drop.kind, drop.id, true, drop.parentId).then((list) => {
          if (drop.kind === 'thread' && drop.thread) reportThreadPin(drop.thread, true);
          const order = list.filter((item) => item.kind === drop.kind).map((item) => item.id);
          // A newer pin write owns the order now.
          return !order.includes(drop.id) || order.indexOf(drop.id) === index || issued !== latestPinWrite()
            ? list
            : api.reorderPins(drop.kind, moveWithin(order, drop.id, index));
        });
        // A failure is reported by the write; the row goes back to its list.
        write(pinned);
        issued = latestPinWrite();
        pinned.catch(() => setState((current) => (current?.id === drop.id && current.landed ? null : current)));
      },
    },
  };
}

/**
 * The Pinned section of a tab. It is always there, because it is where a row
 * is dragged to pin it: with nothing pinned it says so, and it wakes in the
 * accent while a row is being dragged. The whole section, heading included,
 * is the drop target, so a release in a gap between rows still counts.
 */
function PinnedSection({ children, count, drop, label, noun, reorderable, target }: {
  children: ReactNode;
  count: number;
  drop: PinDrop | null;
  label: string;
  noun: string;
  /** Whether any one kind holds two or more pins; each kind reorders on its own. */
  reorderable: boolean;
  target: React.HTMLAttributes<HTMLElement>;
}): React.JSX.Element {
  const hint = useId();
  // How to reorder is said once, for the section; each row says only its
  // place (`pinnedPosition`). As a per-row description it would be repeated
  // before every title.
  return <section aria-describedby={reorderable ? hint : undefined} aria-label={label} className="navigation-section" {...target}>
    <SectionHeading motionKey="pinned" trailing={<PinnedMark reorderable={reorderable} />}>Pinned</SectionHeading>
    {reorderable && <p className="sr-only" id={hint}>Hold Alt and press the up or down arrow to move a pinned {noun}.</p>}
    {count === 0 && drop?.index == null && <div className={clsx('pinned-empty-drop-surface', drop && 'is-armed')}>
      <IconPin aria-hidden="true" size={15} stroke={1.7} />
      <span>Move a {noun} here to pin it</span>
    </div>}
    {children}
  </section>;
}

/** A pinned row's place, read after its title. */
function pinnedPosition(index: number, count: number): string {
  return `Pinned, ${index + 1} of ${count}.`;
}

/**
 * Scrolls to a row a pin or unpin moved, once the list shows the move, and
 * focuses it if the move left focus nowhere. Call before `useListMotion`,
 * whose first frame draws the row back at its old slot.
 */
function usePinReveal(
  scroll: RefObject<HTMLElement | null>,
  motionKeyOf: (id: string) => string,
  pinnedIds: ReadonlySet<string>,
): (id: string, pinned: boolean) => void {
  const [reveal, setReveal] = useState<{ id: string; pinned: boolean } | null>(null);
  useEffect(() => {
    if (reveal === null) return undefined;
    const timer = setTimeout(() => setReveal(null), REVEAL_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [reveal]);
  useLayoutEffect(() => {
    if (reveal === null || pinnedIds.has(reveal.id) !== reveal.pinned) return;
    setReveal(null);
    const row = scroll.current?.querySelector<HTMLElement>(`[data-motion-key="${motionKeyOf(reveal.id)}"]`);
    row?.scrollIntoView?.({
      block: 'nearest',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    if (document.activeElement === null || document.activeElement === document.body) row?.focus({ preventScroll: true });
  });
  return useCallback((id, pinned) => setReveal({ id, pinned }), []);
}

/**
 * Where a link's own click should be left to the browser: a modifier or a
 * button other than the main one opens it somewhere else (a new tab, in the
 * web app), so it is not this window opening the row.
 */
function opensElsewhere(event: React.MouseEvent): boolean {
  return event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/** The open route, as a link's `to` would name it. */
function useCurrentRoute(): string {
  const location = useLocation();
  return `${location.pathname}${location.search}`;
}

/** A placeholder row: a picture of where a dragged row would land, out of reach of focus and assistive technology. */
function ghostProps(ghost: boolean): React.HTMLAttributes<HTMLElement> {
  return ghost ? { 'aria-hidden': true, tabIndex: -1 } : {};
}

/**
 * A kind's pinned order as drawn: the dragged row is spliced in at the slot
 * it is held over, as a placeholder until it lands and as itself after.
 */
function withPinDrop(kind: PinKind, order: readonly string[], drop: PinDrop | null): string[] {
  if (!drop || drop.kind !== kind || drop.index === null) return [...order];
  return moveWithin(order, drop.id, drop.index);
}

/**
 * A list's sort, which cycles on each click. The label is the current sort;
 * the tooltip and the accessible name say it is a sort and what a click
 * changes it to, which the bare label does not.
 */
function SortButton({ onChange, sort, sorts }: {
  onChange: (sort: SidebarChannelSort) => void;
  sort: SidebarChannelSort;
  sorts: ReadonlyArray<{ sort: SidebarChannelSort; label: string }>;
}): React.JSX.Element {
  const index = Math.max(0, sorts.findIndex((candidate) => candidate.sort === sort));
  const current = sorts[index]!;
  const next = sorts[(index + 1) % sorts.length]!;
  return <Tip label={`Sort by ${next.label}`}>
    <button
      aria-label={`Sorted by ${current.label}. Sort by ${next.label}`}
      className="navigation-sort"
      onClick={() => onChange(next.sort)}
      type="button"
    >
      {current.label}
      <IconArrowsSort aria-hidden="true" size={13} stroke={1.8} />
    </button>
  </Tip>;
}

/** Moving one pinned row a step; null where it is already at that end. */
interface PinMoves {
  up: (() => void) | null;
  down: (() => void) | null;
}

/** Move up / Move down, for a pinned row's menu. */
function PinMoveItems({ moves }: { moves: PinMoves | undefined }): React.JSX.Element | null {
  if (!moves || (!moves.up && !moves.down)) return null;
  return <>
    {moves.up && <ContextMenu.Item className="menu-item" onSelect={moves.up}>
      <IconArrowUp aria-hidden="true" size={15} stroke={1.8} />
      Move up
    </ContextMenu.Item>}
    {moves.down && <ContextMenu.Item className="menu-item" onSelect={moves.down}>
      <IconArrowDown aria-hidden="true" size={15} stroke={1.8} />
      Move down
    </ContextMenu.Item>}
  </>;
}

/**
 * A section's heading. It is a held row of the list motion, so it travels with
 * the rows under it when a section above appears or goes, rather than being
 * the thing seen to leave.
 */
function SectionHeading({ children, motionKey, trailing }: {
  children: ReactNode;
  motionKey: string;
  trailing?: ReactNode;
}): React.JSX.Element {
  return <div className="navigation-section-heading" data-motion-hold="" data-motion-key={`heading:${motionKey}`}>
    <span>{children}</span>
    {trailing && <span className="navigation-section-trailing">{trailing}</span>}
  </div>;
}

/** The Pinned heading's pin; how to arrange the list is its tooltip once there is something to arrange. */
function PinnedMark({ reorderable }: { reorderable: boolean }): React.JSX.Element {
  const mark = <span aria-hidden="true" className="navigation-section-mark">
    <IconPin size={14} stroke={1.8} />
  </span>;
  return reorderable ? <Tip label="Drag to reorder">{mark}</Tip> : mark;
}

/** A Channel's identity as a tile: its glyph on its hue's pastel pair. */
function channelLook(space: SpaceSummary): { Icon: typeof Sparkle; tint: string; ink: string } {
  return { Icon: WORKSTREAM_ICON_COMPONENTS[space.iconKey], ...markColors(space.colorKey) };
}

function ChannelTile({ badges, size, space }: { badges?: readonly TileBadge[]; size?: number; space: SpaceSummary }): React.JSX.Element {
  const { Icon, ink, tint } = channelLook(space);
  return <IdentityTile badges={badges} icon={Icon} ink={ink} shape="squircle" size={size} tint={tint} />;
}

/**
 * A Channel as a badge on another tile. The pair is inverted, the hue's ink
 * under its tint, so the badge stays a solid mark of the Channel's colour
 * against the tile it sits on in either appearance.
 */
function channelBadge(space: SpaceSummary): TileBadge {
  const { Icon, ink, tint } = channelLook(space);
  return { key: space.id, shape: 'squircle', fill: ink, ink: tint, icon: Icon };
}

/** A thread as a badge, inverted the same way, with its Channel on its corner. */
function threadBadge(threadId: string, saved: WorkstreamAppearance | undefined, channel: SpaceSummary | undefined): TileBadge {
  const { Icon, ink, tint } = resolveWorkstreamAppearance(threadId, saved);
  return { key: threadId, shape: 'circle', fill: ink, ink: tint, icon: Icon, badge: channel && channelBadge(channel) };
}

/**
 * One row of any of the three lists: a tile, a name with its time, and a
 * second line with an optional unread dot at its end.
 */
function RowLayout({ detail, tile, time, title, titleExtra, unread }: {
  detail: ReactNode;
  tile: ReactNode;
  time?: ReactNode;
  title: ReactNode;
  titleExtra?: ReactNode;
  unread: boolean;
}): React.JSX.Element {
  return <>
    {tile}
    <span className="navigation-row-copy">
      <span className="navigation-row-line">
        <span className="navigation-row-title">{title}</span>
        {titleExtra}
        {time}
      </span>
      <span className="navigation-row-line">
        <span className="navigation-row-detail">{detail}</span>
        {unread && <span aria-label="Unread" className="navigation-row-unread-dot" role="img" />}
      </span>
    </span>
  </>;
}

/**
 * Whether a thread row reads as unread: new messages, a mention, or never
 * opened, the same three the Threads button counts. A row says no more than
 * that; what the run is doing is the thread's own header's to show.
 */
function threadUnread(row: SpaceConversationSummary): boolean {
  return readerMarkerStatus(row) !== null;
}

function useSpaceMap(): Map<string, SpaceSummary> {
  const { active } = useSpaceDirectories();
  return useMemo(() => new Map((active.data?.items ?? []).map((space) => [space.id as string, space])), [active.data]);
}

/**
 * A listed row with what the socket holds fresher: a thread takes its live
 * copy, and a breakout its thread's live appearance for the badge on its tile.
 */
function withLiveThread(
  row: SpaceConversationSummary,
  liveById: ReadonlyMap<string, WorkstreamSummary>,
): SpaceConversationSummary {
  if (!row.breakoutOf) return { ...row, ...liveById.get(row.id), kind: row.kind, breakoutOf: row.breakoutOf };
  const appearance = liveById.get(row.breakoutOf.workstreamId)?.appearance ?? row.breakoutOf.appearance;
  return { ...row, breakoutOf: { ...row.breakoutOf, appearance } };
}

/**
 * The Threads tab: what this person pinned, then every thread and breakout
 * they take part in. The list is the server's (`GET /navigation/threads`); a
 * thread the socket holds is drawn from the socket, so its dot moves live.
 */
function ThreadsSection({ scroll }: { scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const { api } = useAppSession();
  const sort = useUiStore((state) => state.threadSort);
  const setSort = useUiStore((state) => state.setThreadSort);
  const live = useWorkstreamsQuery();
  const spaces = useSpaceMap();
  const pins = usePins();
  const pin = usePinAction(api);
  const openChannelId = useOpenChannelId();
  const openThreadId = useOpenThreadId();
  const list = useInfiniteQuery({
    queryKey: MY_THREADS_QUERY_KEY,
    queryFn: ({ pageParam, signal }) => api!.getMyThreads(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api),
  });
  const liveById = useMemo(() => new Map((live.data ?? []).map((row) => [row.id, row])), [live.data]);
  const rows = useMemo(() => {
    const fetched = (list.data?.pages ?? []).flatMap((page) => page.items);
    const known = new Set(fetched.map((row) => row.id));
    // A thread this person started a moment ago is theirs before the list is
    // read again.
    const started = (live.data ?? []).filter((row) => row.pending && !known.has(row.id))
      .map((row): SpaceConversationSummary => ({ ...row, kind: 'channel', breakoutOf: null }));
    return [...started, ...fetched.map((row) => withLiveThread(row, liveById))];
  }, [list.data, live.data, liveById]);
  // Pinned rows come whole with the first page, so a pin whose activity is
  // pages back is still drawn; a row on a loaded page is the fresher copy.
  const byId = useMemo(() => new Map([
    ...(list.data?.pages[0]?.pinned ?? []).map((row): [string, SpaceConversationSummary] => [row.id, withLiveThread(row, liveById)]),
    ...rows.map((row): [string, SpaceConversationSummary] => [row.id, row]),
  ]), [list.data, liveById, rows]);
  const threadPins = pins.filter((item) => item.kind === 'thread').map((item) => item.id);
  const breakoutPins = pins.filter((item) => item.kind === 'breakout').map((item) => item.id);
  const threadDrag = usePinnedDrag('thread', threadPins);
  const breakoutDrag = usePinnedDrag('breakout', breakoutPins);
  const pinned = new Set([...threadPins, ...breakoutPins]);
  const pinDrop = usePinDrop(pinned, (kind) => (kind === 'breakout' ? breakoutPins : threadPins));
  const { drop } = pinDrop;
  const unpinned = rows.filter((row) => !pinned.has(row.id) && !(drop?.landed && drop.id === row.id))
    .sort(compareChannels(sort, openThreadId));
  const pinKind = (row: SpaceConversationSummary): PinKind => (row.kind === 'breakout' ? 'breakout' : 'thread');
  const revealPin = usePinReveal(scroll, (id) => `thread:${id}`, pinned);
  // A thread opened from a desktop link is scrolled to, loading further pages
  // until its row is there or the list runs out. The link is marked before
  // the route changes, so a route still on another thread is waited out.
  const deepLink = useDeepLinkWorkstreamNavigation();
  // The link reached its thread once; leaving it after that ends the link.
  const deepLinkArrived = useRef<number | null>(null);
  // Each page is asked for once, so a render landing before the fetch shows
  // as in flight does not restart it.
  const deepLinkPage = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (deepLink === null) return;
    if (deepLink.workstreamId !== openThreadId) {
      if (deepLinkArrived.current === deepLink.revision) consumeDeepLinkWorkstreamNavigation(deepLink.revision);
      return;
    }
    deepLinkArrived.current = deepLink.revision;
    const row = scroll.current?.querySelector<HTMLElement>(`[data-motion-key="thread:${deepLink.workstreamId}"]`);
    if (row) {
      row.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      consumeDeepLinkWorkstreamNavigation(deepLink.revision);
      return;
    }
    if (!list.isSuccess || list.isFetchingNextPage) return;
    if (!list.hasNextPage) {
      consumeDeepLinkWorkstreamNavigation(deepLink.revision);
      return;
    }
    const page = `${deepLink.revision}:${list.data.pages.length}`;
    if (deepLinkPage.current === page) return;
    deepLinkPage.current = page;
    void list.fetchNextPage();
  });
  // A row that changes place, a pin or a re-sort, travels there. A row keeps
  // its motion key between Pinned and the list, so a pin is one row moving.
  useListMotion(scroll);
  const href = (row: SpaceConversationSummary): string => {
    if (row.kind === 'breakout' && row.breakoutOf) {
      const parent = live.data?.find((candidate) => candidate.id === row.breakoutOf!.workstreamId);
      return threadRoute(row.breakoutOf.workstreamId, homeChannelId(parent?.spaceIds ?? row.spaceIds, openChannelId), row.id);
    }
    return threadRoute(row.id, homeChannelId(row.spaceIds, openChannelId));
  };
  const renderRow = (
    row: SpaceConversationSummary,
    drag?: PinnedRowProps,
    moves?: PinMoves,
    ghost = false,
    position?: string,
  ): ReactNode => <ThreadRow
    active={row.id === openThreadId}
    drag={drag}
    ghost={ghost}
    href={href(row)}
    moves={moves}
    key={ghost ? `ghost:${row.id}` : row.id}
    onPin={(next) => {
      revealPin(row.id, next);
      pin(pinKind(row), row.id, next, row.breakoutOf?.workstreamId, row);
    }}
    pinned={pinned.has(row.id)}
    position={position}
    row={row}
    spaces={spaces}
  />;
  // Threads are drawn above breakouts, so a breakout's place counts past them.
  const pinnedCount = threadDrag.order.length + breakoutDrag.order.length;
  const pinnedRows = (kind: PinKind, drag: ReturnType<typeof usePinnedDrag>, offset: number): ReactNode[] => withPinDrop(kind, drag.order, drop)
    .map((id) => {
      const row = byId.get(id);
      if (!row) return null;
      if (id === drop?.id) return renderRow(row, undefined, undefined, !drop.landed);
      const index = drag.order.indexOf(id);
      return renderRow(row, drag.rowProps(id, index), drag.moves(id, index), false, pinnedPosition(offset + index, pinnedCount));
    });
  return <>
    <PinnedSection
      count={pinned.size}
      drop={drop}
      label="Pinned threads"
      noun="thread"
      reorderable={threadPins.length > 1 || breakoutPins.length > 1}
      target={pinDrop.targetProps}
    >
      {pinnedRows('thread', threadDrag, 0)}
      {pinnedRows('breakout', breakoutDrag, threadDrag.order.length)}
    </PinnedSection>
    <section aria-busy={list.isPending || undefined} aria-label="All Threads" className="navigation-section">
      <SectionHeading motionKey="threads" trailing={<SortButton onChange={setSort} sort={sort} sorts={THREAD_SORTS} />}>All Threads</SectionHeading>
      {list.isPending && rows.length === 0 && <SidebarSkeletonRows count={6} hint />}
      {unpinned.map((row) => renderRow(
        row,
        row.pending ? undefined : pinDrop.sourceProps(pinKind(row), row.id, row.breakoutOf?.workstreamId, row),
      ))}
      {list.isSuccess && rows.length === 0 && <p className="navigation-empty">Threads you start or are added to appear here.</p>}
      {list.hasNextPage && <button className="navigation-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} type="button">Show more</button>}
      {list.isError && <InlineError>Your threads couldn’t be loaded.</InlineError>}
    </section>
  </>;
}

/**
 * A thread or breakout row: a link, so a modified click opens it elsewhere.
 * Hovering it warms the thread's socket so the open is fast, and a plain
 * click starts the open-latency measurement the thread screen finishes
 * (`docs/realtime-sockets.md`). A breakout opens beside its thread, so both
 * act on the thread.
 */
function ThreadRow({ active, drag, ghost, href, moves, onPin, pinned, position, row, spaces }: {
  active: boolean;
  drag?: PinnedRowProps | undefined;
  ghost: boolean;
  href: string;
  moves?: PinMoves | undefined;
  onPin: (pinned: boolean) => void;
  pinned: boolean;
  position?: string | undefined;
  row: SpaceConversationSummary;
  spaces: ReadonlyMap<string, SpaceSummary>;
}): React.JSX.Element {
  const unread = threadUnread(row);
  const channels = row.spaceIds.flatMap((id) => {
    const space = spaces.get(id);
    return space ? [space] : [];
  });
  const appearance = resolveWorkstreamAppearance(row.id, row.appearance);
  const badges = row.breakoutOf
    ? [threadBadge(row.breakoutOf.workstreamId, row.breakoutOf.appearance, channels[0])]
    : channels.map(channelBadge);
  const names = channels.map((space) => space.name).join(' · ');
  const detail = row.kind === 'breakout' && row.breakoutOf
    ? `↳ ${row.breakoutOf.title}${names ? ` · ${names}` : ''}`
    : names;
  const threadId = row.breakoutOf?.workstreamId ?? row.id;
  const warmup = useWorkstreamSocketHoverWarmup(threadId);
  const socketOpenContext = useWorkstreamSocketOpenContext(threadId);
  const { pathname, search } = useLocation();
  const route = `${pathname}${search}`;
  const naming = useNamingSkeleton(row);
  const live = !ghost && !row.pending;
  const open = (event: React.MouseEvent): void => {
    if (opensElsewhere(event)) return;
    // The open row clicked again is not a new open.
    if (route === href) {
      event.preventDefault();
      return;
    }
    const socket = socketOpenContext();
    markWorkstreamFeedOpenStarted(threadId, pinned ? 'pinned' : 'recent', socket.state, performance.now(), socket.socketLeaseId);
    markWorkstreamNavigation(threadId, openWorkstreamId(pathname) !== null);
    markSurfaceEntrypoint(pinned ? 'sidebar_pinned' : 'sidebar_recent');
  };
  const wakeup = row.nextPendingWakeup;
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <Link
        aria-current={active ? 'page' : undefined}
        {...ghostProps(ghost)}
        className={clsx('navigation-row navigation-thread-row', active && 'is-active', unread && 'is-unread', ghost && 'is-pin-ghost')}
        // A thread still starting slides in, and out again if its start fails.
        data-motion-insert={row.pending ? '' : undefined}
        // A placeholder is not the row: the row is still in its list.
        data-motion-key={ghost ? undefined : `thread:${row.id}`}
        // Not a link drag: a row drags only to pin or reorder, which `drag` says.
        draggable={false}
        onClick={open}
        onPointerCancel={live ? warmup.onPointerCancel : undefined}
        onPointerEnter={live ? warmup.onPointerEnter : undefined}
        onPointerLeave={live ? warmup.onPointerLeave : undefined}
        to={href}
        {...drag}
      >
        <RowLayout
          detail={detail}
          tile={<IdentityTile badges={badges} icon={appearance.Icon} ink={appearance.ink} shape="circle" tint={appearance.tint} />}
          time={!row.pending && <RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={row.lastActivityAt} />}
          title={row.pending ? 'Starting…' : naming ? <TitleSkeleton /> : row.title}
          titleExtra={wakeup && <Tip
            align="center"
            className="workstream-timer-tooltip"
            delayDuration={300}
            disableHoverableContent
            label={<>
              <strong>Next: {formatDateTime(wakeup.dueAt)}</strong>
              <span>{wakeup.promptPreview}</span>
            </>}
            side="right"
            sideOffset={8}
          >
            <span
              aria-label={`Active timer. Next: ${formatDateTime(wakeup.dueAt)}. ${wakeup.promptPreview}`}
              className="sidebar-workstream-timer"
              role="img"
            >
              <IconClock aria-hidden="true" size={13} stroke={1.8} />
            </span>
          </Tip>}
          unread={unread}
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
        <PinMoveItems moves={moves} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

/**
 * The Channels tab: what this person pinned, then every Channel they may see,
 * in the order the sort control names (A–Z until changed). A Channel's second
 * line is how many threads in it they may see; a dot and a bold name mean a
 * thread was placed in it since this person last had it open.
 */
/** Members only: a guest has no Channels section. */
function ChannelsSection({ scroll }: { scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const { active, inactive } = useSpaceDirectories();
  const { api } = useAppSession();
  // The socket's Space snapshot seeds this; a placement nudge marks it stale
  // and only then is it read on its own.
  const stats = useQuery<ChannelStats[]>({
    queryKey: CHANNEL_STATS_QUERY_KEY,
    queryFn: ({ signal }) => api!.getChannelStats(signal),
    enabled: api !== null,
    staleTime: Infinity,
  });
  const pins = usePins();
  const pin = usePinAction(api);
  const openChannelId = useOpenChannelId();
  const sort = useUiStore((state) => state.channelSort);
  const setSort = useUiStore((state) => state.setChannelSort);
  const archived = useArchivedChannels();
  const statsById = useMemo(() => new Map((stats.data ?? []).map((item) => [item.channelId, item])), [stats.data]);
  const channels = active.data?.items ?? [];
  const byId = new Map(channels.map((space) => [space.id as string, space]));
  const channelPins = pins.filter((item) => item.kind === 'channel').map((item) => item.id).filter((id) => byId.has(id));
  const drag = usePinnedDrag('channel', channelPins);
  const pinned = new Set(channelPins);
  const pinDrop = usePinDrop(pinned, () => channelPins);
  const { drop } = pinDrop;
  const rest = channels.filter((space) => !pinned.has(space.id) && !(drop?.landed && drop.id === space.id))
    .sort(compareChannelRows(sort, statsById, openChannelId));
  const revealPin = usePinReveal(scroll, (id) => `channel:${id}`, pinned);
  // An archived Channel shares its motion key with its row in the list, so a
  // restore is the row moving up into place.
  useListMotion(scroll);
  const row = (
    space: SpaceSummary,
    rowDrag?: PinnedRowProps,
    moves?: PinMoves,
    ghost = false,
    position?: string,
  ): ReactNode => <ChannelRow
    active={space.id === openChannelId}
    drag={rowDrag}
    ghost={ghost}
    moves={moves}
    key={ghost ? `ghost:${space.id}` : space.id}
    onPin={(next) => {
      revealPin(space.id, next);
      pin('channel', space.id, next);
    }}
    pinned={pinned.has(space.id)}
    position={position}
    space={space}
    stats={statsById.get(space.id)}
  />;
  return <>
    <PinnedSection count={channelPins.length} drop={drop} label="Pinned channels" noun="channel" reorderable={channelPins.length > 1} target={pinDrop.targetProps}>
      {withPinDrop('channel', drag.order, drop).map((id) => {
        const space = byId.get(id);
        if (!space) return null;
        if (id === drop?.id) return row(space, undefined, undefined, !drop.landed);
        const index = drag.order.indexOf(id);
        return row(space, drag.rowProps(id, index), drag.moves(id, index), false, pinnedPosition(index, drag.order.length));
      })}
    </PinnedSection>
    <section aria-busy={active.data === undefined || undefined} aria-label="All channels" className="navigation-section">
      <SectionHeading motionKey="channels" trailing={<SortButton onChange={setSort} sort={sort} sorts={CHANNEL_SORTS} />}>All channels</SectionHeading>
      {active.data === undefined && <SidebarSkeletonRows count={5} hint />}
      {rest.map((space) => row(space, pinDrop.sourceProps('channel', space.id)))}
      {active.data !== undefined && channels.length === 0 && <p className="navigation-empty">No channels yet.</p>}
    </section>
    {(inactive.data?.items.length ?? 0) > 0 && <ArchivedChannels archived={archived} channels={inactive.data!.items} />}
  </>;
}

/**
 * The Archived section's state, held by the Channels tab so that changes to
 * its rows render the component that runs the list motion.
 */
function useArchivedChannels(): {
  failed: string | null;
  open: boolean;
  restore: (space: SpaceSummary) => void;
  toggle: () => void;
} {
  const { api } = useAppSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const restore = (space: SpaceSummary): void => {
    if (!api) return;
    setFailed(null);
    // One render for both lists, so the list motion sees the row move rather
    // than leave one render and arrive as a stranger the next.
    void api.restoreSpace(space.id).then((restored) => notifyManager.batch(() => {
      queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, (current) => current ? {
        ...current, items: current.items.filter((item) => item.id !== space.id),
      } : current);
      queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
        ...current, items: [...current.items.filter((item) => item.id !== space.id), restored],
      } : current);
    }), () => setFailed(space.name));
  };
  return { failed, open, restore, toggle: () => setOpen(!open) };
}

/**
 * Archived Channels, folded away under their own heading, each with
 * **Restore**. A restore brings back the threads the archive took out; any it
 * moved to General stay there too.
 */
function ArchivedChannels({ archived, channels }: {
  archived: ReturnType<typeof useArchivedChannels>;
  channels: readonly SpaceSummary[];
}): React.JSX.Element {
  const { failed, open, restore, toggle } = archived;
  return <section aria-label="Archived channels" className="navigation-section">
    <SectionHeading motionKey="archived" trailing={<button aria-expanded={open} className="navigation-sort" onClick={toggle} type="button">
      {open ? 'Hide' : `Show ${channels.length}`}
    </button>}>Archived</SectionHeading>
    {failed && <InlineError>{failed} couldn’t be restored. Try again.</InlineError>}
    {open && [...channels].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((space) => <div className="navigation-archived-row" data-motion-key={`channel:${space.id}`} key={space.id}>
        <ChannelTile size={30} space={space} />
        <span className="navigation-archived-name">{space.name}</span>
        <Button onClick={() => restore(space)}>Restore</Button>
      </div>)}
  </section>;
}

/** A Channel row: a link, so a modified click opens it elsewhere. */
function ChannelRow({ active, drag, ghost, moves, onPin, pinned, position, space, stats }: {
  active: boolean;
  drag?: PinnedRowProps | undefined;
  ghost: boolean;
  moves?: PinMoves | undefined;
  onPin: (pinned: boolean) => void;
  pinned: boolean;
  position?: string | undefined;
  space: SpaceSummary;
  stats: ChannelStats | undefined;
}): React.JSX.Element {
  const count = stats?.threadCount ?? 0;
  const unread = stats?.hasUnread === true;
  const route = useCurrentRoute();
  const href = channelRoute(space.id);
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <Link
        aria-current={active ? 'page' : undefined}
        {...ghostProps(ghost)}
        className={clsx('navigation-row navigation-channel-row', active && 'is-active', unread && 'is-unread', ghost && 'is-pin-ghost')}
        // A placeholder is not the row: the row is still in its list.
        data-motion-key={ghost ? undefined : `channel:${space.id}`}
        draggable={false}
        // The open Channel clicked again is not a new open.
        onClick={(event) => { if (!opensElsewhere(event) && route === href) event.preventDefault(); }}
        to={href}
        {...drag}
      >
        <RowLayout
          detail={count === 1 ? '1 thread' : `${count} threads`}
          tile={<ChannelTile space={space} />}
          time={stats?.lastActivityAt && <RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={stats.lastActivityAt} />}
          title={space.name}
          titleExtra={space.scope === 'personal' && <IconLock aria-label="Private" className="navigation-row-lock" size={13} stroke={1.8} />}
          unread={unread}
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
        <PinMoveItems moves={moves} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

/**
 * Naming a new Channel. Every Channel starts Organization-wide; making one
 * private is in its own menu, once it exists.
 */
function NewChannelDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const create = async (): Promise<void> => {
    if (!api || !name.trim()) return;
    setPending(true);
    setFailed(false);
    try {
      const created = await api.createSpace({ name: name.trim(), colorKey: 'blue', scope: 'workspace' });
      queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current && !current.items.some((item) => item.id === created.id)
        ? { ...current, items: [...current.items, created] }
        : current);
      onClose();
      void navigate(channelRoute(created.id));
    } catch {
      setFailed(true);
      setPending(false);
    }
  };
  return <Modal
    footer={<>
      <Button disabled={pending} onClick={onClose}>Cancel</Button>
      <Button className="button-primary" disabled={pending || !name.trim()} onClick={() => void create()}>Create channel</Button>
    </>}
    onOpenChange={(open) => { if (!open && !pending) onClose(); }}
    open
    title="New channel"
  >
    <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label className="form-field">
        <span>Name</span>
        <input autoFocus maxLength={180} onChange={(event) => setName(event.target.value)} placeholder="e.g. Outbound" value={name} />
      </label>
    </form>
    {failed && <InlineError>The channel couldn’t be created. Try again.</InlineError>}
  </Modal>;
}

const ACTIVITY_VERBS: Record<ActivityItem['kind'], string> = {
  added: 'added you to',
  mentioned: 'mentioned you in',
  thread_started: 'started',
  breakout_started: 'started a breakout on',
  run_finished: 'finished',
};

/** The Activity tab's chips; see `docs/digests.md#the-activity-tab`. */
type ActivityChip = 'all' | 'unread' | 'mentions';
const ACTIVITY_CHIPS: ReadonlyArray<{ chip: ActivityChip; label: string }> = [
  { chip: 'all', label: 'All' },
  { chip: 'unread', label: 'Unread' },
  { chip: 'mentions', label: 'Mentions' },
];

function activityQueryKey(only: ActivityFilter | null): readonly unknown[] {
  return [...ACTIVITY_QUERY_KEY, only ?? 'all'];
}

/**
 * Mark all read, the one way Activity is read: the server's waterline moves to
 * the newest row held, and every held page drops its dots now. Showing the tab
 * reads nothing, so Unread still lists what came in after a refetch.
 */
function useMarkActivityRead(): () => void {
  const { api } = useAppSession();
  const queryClient = useQueryClient();
  return useCallback(() => {
    const held = queryClient.getQueriesData<InfiniteData<ActivityPage>>({ queryKey: ACTIVITY_QUERY_KEY });
    const newest = held.flatMap(([, data]) => data?.pages[0]?.items[0]?.occurredAt ?? [])
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    if (!api || !newest) return;
    queryClient.setQueriesData<InfiniteData<ActivityPage>>({ queryKey: ACTIVITY_QUERY_KEY }, (data) => data && {
      ...data,
      pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => item.unread ? { ...item, unread: false } : item) })),
    });
    // A failed write puts the dots back from the server rather than leaving
    // them cleared over a waterline that never moved.
    void api.markActivitySeen(newest).catch(() => queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY }));
  }, [api, queryClient]);
}

function initials(name: string): string {
  return name.split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function dayLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  const start = (offset: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime();
  if (date.getTime() >= start(0)) return 'Today';
  if (date.getTime() >= start(1)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * The Activity tab: requests to join waiting on this person, then what
 * happened to them, newest first and grouped by day. A row stays unread until
 * Mark all read, so Unread is a list to work through rather than one glance.
 */
function ActivitySection({ accessDecisionFailed, accessRequests, attentionComplete, guest, onDecideAccessRequest, onOpenAccessRequest, scroll }: {
  accessDecisionFailed: boolean;
  guest: boolean;
  accessRequests: readonly ConversationAccessRequestItem[];
  attentionComplete: boolean;
  onDecideAccessRequest: (request: ConversationAccessRequestItem, decision: AccessDecision) => void;
  onOpenAccessRequest: (request: ConversationAccessRequestItem) => void;
  scroll: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const { api } = useAppSession();
  const live = useWorkstreamsQuery();
  const spaces = useSpaceMap();
  const [chip, setChip] = useState<ActivityChip>('all');
  const only: ActivityFilter | null = chip === 'mentions' ? 'mentions' : null;
  // A start names its starter by id; the name is the member directory's, the
  // same read the Channel feed names its authors from. A guest has no
  // directory and sees the label the server sent.
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api) && !guest,
    staleTime: 60_000,
  });
  const actorName = (item: ActivityItem): string => item.actorLabel
    || members.data?.find((member) => member.id === item.actorUserId)?.name
    || 'Someone';
  const feed = useInfiniteQuery({
    queryKey: activityQueryKey(only),
    queryFn: ({ pageParam, signal }) => api!.getActivity(pageParam, only, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api),
    refetchOnMount: 'always',
  });
  const fetched = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.items), [feed.data]);
  const items = chip === 'unread' ? fetched.filter((item) => item.unread) : fetched;
  const href = (item: ActivityItem): string => {
    const parent = live.data?.find((candidate) => candidate.id === item.threadId);
    return threadRoute(item.threadId, homeChannelId(parent?.spaceIds ?? item.channelIds), item.breakout?.substreamId);
  };
  // New activity pushes the rows under it down, and a request arriving or
  // answered slides in or out, rather than the list jumping.
  useListMotion(scroll);
  const groups: Array<{ label: string; items: ActivityItem[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.occurredAt);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  const empty = chip === 'unread' ? 'Nothing unread.'
    : chip === 'mentions' ? 'Nobody has mentioned you yet.'
      : attentionComplete ? 'Nothing new. Activity about your threads shows up here.' : 'Still loading…';
  return <>
    <div aria-label="Show" className="navigation-chips-row" role="group">
      {ACTIVITY_CHIPS.map((candidate) => <button
        aria-pressed={candidate.chip === chip}
        className={clsx('navigation-filter-chip', candidate.chip === chip && 'is-active')}
        key={candidate.chip}
        onClick={() => setChip(candidate.chip)}
        type="button"
      >{candidate.label}</button>)}
    </div>
    {accessDecisionFailed && <InlineError>That didn’t go through. Try again.</InlineError>}
    {accessRequests.length > 0 && chip === 'all' && <section aria-label="Requests to join" className="navigation-section">
      <SectionHeading motionKey="requests">Requests</SectionHeading>
      {accessRequests.map((request) => <div
        className="activity-row activity-request"
        data-motion-insert=""
        data-motion-key={`request:${request.id}`}
        key={request.id}
      >
        <button className="activity-row-body" onClick={() => onOpenAccessRequest(request)} type="button">
          <span className="activity-row-text"><strong>{request.requesterName}</strong> asked to join <strong>{request.title}</strong></span>
        </button>
        <span className="activity-request-actions">
          <IconButton label={`Approve ${request.requesterName}`} onClick={() => onDecideAccessRequest(request, 'approve')}>
            <IconCheck aria-hidden="true" size={16} stroke={2} />
          </IconButton>
          <IconButton label={`Decline ${request.requesterName}`} onClick={() => onDecideAccessRequest(request, 'decline')}>
            <IconCancel aria-hidden="true" size={16} stroke={2} />
          </IconButton>
        </span>
      </div>)}
    </section>}
    {feed.isPending && <div aria-busy="true" aria-label="Loading activity" className="navigation-section" role="status">
      <SidebarSkeletonRows count={5} hint />
    </div>}
    {groups.map((group) => <section aria-label={group.label} className="navigation-section" key={group.label}>
      <SectionHeading motionKey={`day:${group.label}`}>{group.label}</SectionHeading>
      {group.items.map((item) => {
        const channel = item.channelIds.map((id) => spaces.get(id)).find(Boolean);
        const actor: TileBadge = item.actorUserId === null
          ? { key: 'actor', shape: 'circle', fill: 'var(--av-sys-color-text-default)', ink: 'var(--av-sys-color-surface-default)', icon: Sparkle }
          : { key: 'actor', shape: 'circle', fill: 'var(--av-sys-color-accent-wash)', ink: 'var(--av-sys-color-accent-strong)', text: initials(actorName(item)) };
        const thread = resolveWorkstreamAppearance(item.threadId, live.data?.find((candidate) => candidate.id === item.threadId)?.appearance);
        return <Link
          className={clsx('activity-row', item.unread && 'is-unread')}
          data-motion-key={`activity:${item.id}`}
          key={item.id}
          to={href(item)}
        >
          {channel
            ? <ChannelTile badges={[actor]} space={channel} />
            : <IdentityTile badges={[actor]} icon={thread.Icon} ink={thread.ink} shape="circle" tint={thread.tint} />}
          <span className="activity-row-body">
            <span className="activity-row-text">
              <strong>{actorName(item)}</strong> {ACTIVITY_VERBS[item.kind]}{' '}
              <strong>{item.breakout && item.kind !== 'breakout_started' ? item.breakout.title : item.threadTitle}</strong>
            </span>
            {item.kind === 'breakout_started' && item.breakout && <span className="breakout-chip activity-chip">
              <IconCornerDownRight aria-hidden="true" className="breakout-chip-icon" size={13} stroke={1.9} />
              <span className="breakout-chip-title">{item.breakout.title}</span>
            </span>}
            <span className="activity-row-detail">
              {channel ? `${channel.name} · ` : ''}
              <RelativeTime format={formatTime} value={item.occurredAt} />
            </span>
          </span>
          {item.unread && <span aria-label="Unread" className="activity-unread-dot" role="img" />}
        </Link>;
      })}
    </section>)}
    {feed.isSuccess && items.length === 0 && (chip !== 'all' || accessRequests.length === 0) && <p className="navigation-empty">{empty}</p>}
    {feed.hasNextPage && <button className="navigation-more" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()} type="button">Show more</button>}
    {feed.isError && <InlineError>Activity couldn’t be loaded.</InlineError>}
  </>;
}

