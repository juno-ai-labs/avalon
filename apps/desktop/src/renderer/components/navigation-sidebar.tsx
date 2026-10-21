import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ActivityFilter, ActivityGroup, ActivityItem, ActivityPage, ArtifactPin, ConversationAccessRequestItem, PinKind, SpaceSummary, WorkstreamAppearance } from '@rally/contracts';
import { groupActivityItems, SPACE_COLOR_KEYS } from '@rally/contracts';
import { IdentityTile, ShapeOutline, type TileBadge } from '@rally/ui/components/identity-tile';
import { resourceGlyph } from '@rally/ui/components/resource-icon';
import { resolveWorkstreamAppearance, WORKSTREAM_ICON_COMPONENTS } from '@rally/ui/components/workstream-glyph';
import { markColors } from '@rally/ui/lib/project-palette';
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsSort,
  IconCancel,
  IconCheck,
  IconChecks,
  IconChevronRight,
  IconClock,
  IconCornerDownRight,
  IconDeviceDesktopDown,
  IconDots,
  IconLock,
  IconMenu2,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { File, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom';

import type { AttentionItem } from '../lib/attention-items';
import { useAppSession } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { consumeDeepLinkWorkstreamNavigation, useDeepLinkWorkstreamNavigation } from '../lib/deep-link-navigation';
import { desktopBridge } from '../lib/platform';
import { formatDateTime, formatSidebarActivityTime, formatTime, readerMarkerStatus } from '../lib/format';
import { layoutInsertIndex, layoutRowAt } from '../lib/list-motion';
import { OPEN_EXPANDED, channelRoute, homeChannelId, openThreadResourceState, threadRoute } from '../lib/navigation-routes';
import { moveWithin } from '../lib/personal-order';
import { compareChannels } from '../lib/sidebar-channel-order';
import { ACTIVITY_QUERY_KEY, CHANNEL_STATS_QUERY_KEY, MY_THREADS_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import { useNamingSkeleton } from '../lib/naming-skeleton';
import { latestPinWrite, reportThreadPin, useArtifactPinAction, useArtifactPins, useArtifactPinWrite, usePinAction, usePinFailure, usePinnedIds, usePins, usePinWrite, type PinnedThread } from '../lib/pins';
import { markSurfaceEntrypoint, markWorkstreamFeedOpenStarted, markWorkstreamNavigation } from '../lib/telemetry';
import type { SpaceConversationSummary, Workspace, WorkspaceMember, WorkstreamSummary } from '../lib/types';
import { useUiStore, type SidebarChannelSort, type SidebarSection } from '../lib/ui-store';
import { useListMotion, useListMotionPass } from '../lib/use-list-motion';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { openWorkstreamId } from '../lib/workstream-landing';
import { useWorkstreamSocketHoverWarmup, useWorkstreamSocketOpenContext } from '../lib/workstream-socket-pool';
import { resourceKindLabel } from './markdown-citations';
import { Avatar, Button, IconButton, InlineError, Modal, RallyAvatar, TitleSkeleton, Tip } from './primitives';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import { RailItem } from './rail-item';
import { RelativeTime } from './relative-time';
import { ResizableSidebar, SidebarFooterItems, SidebarScroll } from '@rally/ui/components/resizable-sidebar';
import { PHONE_LAYOUT_MAX_WIDTH, usePhoneLayout } from '@rally/ui/lib/phone-layout';
import type { ChannelStats, SpaceDirectory } from '@rally/contracts';

const NAVIGATION_SHEET_ID = 'rally-navigation-sheet';
/**
 * How long a pin's scroll-to-row waits for the list to carry the pin before
 * giving up. Carried over from the sidebar this one replaced.
 */
const REVEAL_DEADLINE_MS = 2_000;

/**
 * Each section's button is the outline of what its list holds: a Channel is a
 * squircle and a Thread a circle, as their rows draw them. Activity holds
 * neither, so it takes the triangle no object uses. Artifacts takes a page,
 * the outline its rows' sheet tiles stand for. Pinned holds every kind
 * that can be pinned, so it takes the pin a row's pin button draws, at the
 * outlines' stroke.
 */
const SECTIONS: ReadonlyArray<{ id: SidebarSection; label: string; icon: ReactNode }> = [
  { id: 'pinned', label: 'Pinned', icon: <IconPin aria-hidden="true" size={22} stroke={1.8} /> },
  { id: 'channels', label: 'Channels', icon: <ShapeOutline shape="squircle" /> },
  { id: 'threads', label: 'Threads', icon: <ShapeOutline shape="circle" /> },
  { id: 'activity', label: 'Activity', icon: <ShapeOutline shape="triangle" /> },
  { id: 'artifacts', label: 'Artifacts', icon: <ShapeOutline shape="sheet" /> },
];
type Section = (typeof SECTIONS)[number];

/**
 * How many sections the phone's tab row draws before folding the rest into a
 * More tab: four, then More, then Settings, six tiles across the row. The
 * product owner set the count (2026-10-17); it is a layout choice, not a
 * measured limit.
 */
const PHONE_RAIL_SECTIONS = 4;

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
 * group in Recent order. `heldId` is the open Channel; it keeps the unread
 * rank after opening reads the Channel.
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
 * The sidebar: a section switcher (Pinned, Channels, Threads, Activity, Artifacts) beside one
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
  onOpenSearch?: (() => void) | undefined;
  workspace: Workspace;
}): React.JSX.Element {
  const { host } = useShellCapabilities();
  const chosenSection = useUiStore((state) => state.sidebarSection);
  const setSection = useUiStore((state) => state.setSidebarSection);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  // The phone sheet. Escape closes it as it would any menu and hands focus
  // back to the button (the app shell then moves it on to a pane header's
  // menu mark, when that is what opened the sheet); widening past the phone
  // layout closes it, so an open sheet never leaves the conversation behind
  // it inert at a width that draws no sheet.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    // Opened from a pane header, focus fell with the pane as it went inert;
    // it lands on the close button, where the sheet starts.
    if (!panel.current?.contains(document.activeElement)) menuToggle.current?.focus();
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
  // sheet stays open on the list just picked. A navigation that asked for the
  // sheet (`sheetAfterNavigation`) opens it here instead, once.
  useEffect(() => {
    const { sheetAfterNavigation, setSheetAfterNavigation } = useUiStore.getState();
    if (sheetAfterNavigation) setSheetAfterNavigation(false);
    setSidebarOpen(sheetAfterNavigation);
  }, [pathname, setSidebarOpen]);
  const panel = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLElement | null>(null);
  const guest = workspace.currentUser.accessClass === 'guest';
  // A guest has no Channels section: they reach a Channel only through the
  // threads shared with them (the navigation PRD's privacy rules).
  const sections = guest ? SECTIONS.filter((candidate) => candidate.id !== 'channels') : SECTIONS;
  const section = guest && chosenSection === 'channels' ? 'threads' : chosenSection;
  const pinFailure = usePinFailure();
  // Threads: the dock badge's number, every conversation waiting on this
  // reader and every access request waiting on them. Activity: the menu
  // bar's, the access requests and every unread row. Channels: each Channel
  // with threads this reader has not seen. Pinned: each pinned row whose own
  // row says it is unread.
  const waiting = attentionItems.length + accessRequests.length;
  const unreadActivity = useUnreadActivityCount() + accessRequests.length;
  const channelNews = useChannelsWithNews(!guest);
  const unreadPinnedThreads = useUnreadPinnedThreadCount();
  const unreadArtifacts = useArtifactPins().filter((pin) => pin.unread).length;
  const badges: Record<SidebarSection, number> = {
    pinned: channelNews.pinned + unreadPinnedThreads + unreadArtifacts,
    channels: channelNews.all,
    threads: waiting,
    // Each pinned artifact with a version this person has not seen.
    artifacts: unreadArtifacts,
    activity: unreadActivity,
  };
  const title = SECTIONS.find((candidate) => candidate.id === section)?.label ?? 'Threads';
  // The phone's tab row has room for four sections beside More and Settings;
  // the rest fold into More. A guest's four all fit, so they get no More.
  const phone = usePhoneLayout();
  const folded = phone ? sections.slice(PHONE_RAIL_SECTIONS) : [];
  const shown = folded.length > 0 ? sections.slice(0, PHONE_RAIL_SECTIONS) : sections;
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
        {host === 'desktop' && <div className="navigation-rail-top window-drag" />}
        {shown.map((candidate) => <RailItem
          active={candidate.id === section}
          aria-current={candidate.id === section ? 'page' : undefined}
          badge={<RailBadge count={badges[candidate.id]} label={badgeLabel(candidate.id, badges[candidate.id])} />}
          icon={candidate.icon}
          key={candidate.id}
          label={candidate.label}
          onClick={() => setSection(candidate.id)}
        />)}
        {folded.length > 0 && <MoreSections active={section} badges={badges} onChoose={setSection} sections={folded} />}
        <div className="navigation-rail-spacer" />
        {accountMenu}
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
            {downloadedUpdate !== null && <IconButton className="navigation-update" label={`Restart to update to Rally ${downloadedUpdate}`} onClick={() => void desktopBridge().installDownloadedUpdate()}>
              <IconDeviceDesktopDown aria-hidden="true" size={17} stroke={1.8} />
            </IconButton>}
            {section === 'channels' && <IconButton label="New channel" onClick={() => setCreatingChannel(true)}>
              <IconPlus aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>}
            {section === 'activity' && <IconButton label="Mark all read" onClick={markActivityRead}>
              <IconChecks aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>}
            <IconButton disabled={!onOpenSearch} label="Search organization" onClick={onOpenSearch}>
              <IconSearch aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>
          </div>
        </header>
        <SidebarScroll className="navigation-panel-scroll" scrollRef={scroll}>
          {pinFailure && <InlineError>{pinFailure}</InlineError>}
          {section === 'pinned' && <PinnedPanel guest={guest} scroll={scroll} />}
          {section === 'threads' && <ThreadsSection scroll={scroll} />}
          {section === 'artifacts' && <ArtifactsSection scroll={scroll} />}
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
    {creatingChannel && <NewChannelDialog onClose={() => setCreatingChannel(false)} />}
  </ResizableSidebar>;
}

/** What a section's count says it counts, for its accessible name. */
const BADGE_NOUNS: Record<SidebarSection, string> = { pinned: 'pinned with news', channels: 'with new threads', threads: 'waiting', artifacts: 'updated', activity: 'unread' };

/** What a section's count says, for its accessible name: "3 waiting". */
function badgeLabel(section: SidebarSection, count: number): string {
  return `${count} ${BADGE_NOUNS[section]}`;
}

/**
 * A red count; nothing at zero, `99+` past two digits. Over a section
 * button's corner by default; `className` puts the same pill in a menu row.
 */
function RailBadge({ className = 'navigation-rail-badge', count, label }: { className?: string; count: number; label: string }): React.JSX.Element | null {
  if (count <= 0) return null;
  return <span
    aria-label={label}
    className={count > 99 ? `${className} is-capped` : className}
    role="img"
  >{count > 99 ? '99+' : count}</span>;
}

/**
 * The phone tab row's More tab: a menu of the sections the row has no room
 * for, each a radio row with its own count. The tile reads as selected while
 * one of them is the open section, `aria-current` included, so assistive
 * technology hears where the open section is and `usePinReveal` finds it as
 * its last focus target as it would the section's own tab. Its count is the
 * folded counts added up, named count by count, so nothing a folded section
 * counts is lost from the row.
 * Choosing one switches the section as its own tab would, so the sheet stays
 * open on the list just picked.
 */
function MoreSections({ active, badges, onChoose, sections }: {
  active: SidebarSection;
  badges: Record<SidebarSection, number>;
  onChoose: (section: SidebarSection) => void;
  sections: readonly Section[];
}): React.JSX.Element {
  const counted = sections.filter((candidate) => badges[candidate.id] > 0);
  const holdsActive = sections.some((candidate) => candidate.id === active);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <RailItem
        active={holdsActive}
        aria-current={holdsActive ? 'page' : undefined}
        badge={<RailBadge
          count={counted.reduce((total, candidate) => total + badges[candidate.id], 0)}
          label={counted.map((candidate) => badgeLabel(candidate.id, badges[candidate.id])).join(', ')}
        />}
        icon={<IconDots aria-hidden="true" size={22} stroke={1.8} />}
        label="More"
      />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu-content navigation-more-menu" collisionPadding={8} sideOffset={4}>
        <DropdownMenu.RadioGroup
          onValueChange={(value) => {
            const chosen = sections.find((candidate) => candidate.id === value);
            if (chosen) onChoose(chosen.id);
          }}
          value={active}
        >
          {sections.map((candidate) => <DropdownMenu.RadioItem className="menu-item navigation-more-item" key={candidate.id} value={candidate.id}>
            {candidate.icon}
            <span className="navigation-more-label">{candidate.label}</span>
            <RailBadge className="navigation-more-count" count={badges[candidate.id]} label={badgeLabel(candidate.id, badges[candidate.id])} />
            <DropdownMenu.ItemIndicator className="navigation-more-check">
              <IconCheck aria-hidden="true" size={15} stroke={1.9} />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/** The Activity tab's whole feed, whichever filter is shown: the tab and its badge share the one cache entry per filter. */
function useActivityFeed(only: ActivityFilter | null) {
  const { api } = useAppSession();
  return useInfiniteQuery({
    queryKey: activityQueryKey(only),
    queryFn: ({ pageParam, signal }) => api!.getActivity(pageParam, only, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page: ActivityPage) => page.nextCursor,
    enabled: Boolean(api),
    refetchOnMount: 'always',
  });
}

/**
 * Activity's unread rows, as the menu bar counts them: the first page is 250
 * rows, so the count is exact up to that. The socket's activity nudge
 * refetches it, and Mark all read clears it with the dots.
 */
function useUnreadActivityCount(): number {
  const feed = useActivityFeed(null);
  return useMemo(() => groupActivityItems((feed.data?.pages ?? []).flatMap((page) => page.items))
    .filter((item) => item.unread).length, [feed.data]);
}

/**
 * Channels with threads this reader has not seen, as each row says "n new
 * threads": all of them, and the pinned ones. The same stats query the
 * Channels list reads, which the socket's Space snapshot seeds. A guest has no
 * Channels section, so nothing to count.
 */
function useChannelsWithNews(enabled: boolean): { all: number; pinned: number } {
  const { api } = useAppSession();
  const pinned = usePinnedIds('channel');
  const stats = useQuery<ChannelStats[]>({
    queryKey: CHANNEL_STATS_QUERY_KEY,
    queryFn: ({ signal }) => api!.getChannelStats(signal),
    enabled: enabled && api !== null,
    staleTime: Infinity,
  });
  const news = enabled ? (stats.data ?? []).filter((item) => item.hasUnread && item.newThreadCount > 0) : [];
  return { all: news.length, pinned: news.filter((item) => pinned.has(item.channelId)).length };
}

/** This person's threads and breakouts (`GET /navigation/threads`): the Threads tab and the Pinned count share it. */
function useMyThreads() {
  const { api } = useAppSession();
  return useInfiniteQuery({
    queryKey: MY_THREADS_QUERY_KEY,
    queryFn: ({ pageParam, signal }) => api!.getMyThreads(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api),
  });
}

/**
 * Pinned threads and breakouts whose rows read as unread, from the copies
 * the Pinned list draws: a thread started a moment ago, which the socket
 * holds before the list is read again, the first page's pinned rows, a loaded
 * page's row where it has one, and the socket's live thread over each.
 */
function useUnreadPinnedThreadCount(): number {
  const list = useMyThreads();
  const live = useWorkstreamsQuery();
  const threads = usePinnedIds('thread');
  const breakouts = usePinnedIds('breakout');
  return useMemo(() => {
    const liveById = new Map((live.data ?? []).map((row) => [row.id, row]));
    const byId = new Map<string, SpaceConversationSummary>();
    for (const row of live.data ?? []) if (row.pending) byId.set(row.id, { ...row, kind: 'channel', breakoutOf: null });
    for (const row of list.data?.pages[0]?.pinned ?? []) byId.set(row.id, row);
    for (const page of list.data?.pages ?? []) for (const row of page.items) byId.set(row.id, row);
    return [...threads, ...breakouts].filter((id) => {
      const row = byId.get(id);
      return row !== undefined && threadUnread(withLiveThread(row, liveById));
    }).length;
  }, [breakouts, list.data, live.data, threads]);
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
function usePinnedDrag(kind: SidebarPinKind, ids: readonly string[]): {
  order: readonly string[];
  rowProps: (id: string, index: number) => PinnedRowProps;
  moves: (id: string, index: number) => PinMoves;
} {
  const { api } = useAppSession();
  const write = usePinWrite();
  const writeArtifacts = useArtifactPinWrite();
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const order = drag?.order ?? ids;
  // Artifact pins are a list of their own, saved through their own route.
  const save = (next: string[]): void => {
    if (!api) return;
    if (kind === 'artifact') writeArtifacts(api.reorderArtifactPins(next));
    else write(api.reorderPins(kind, next));
  };
  // Dragging has a keyboard and a menu path too: Option/Alt with an arrow on
  // a focused row, or Move up / Move down in its menu.
  const moveTo = (id: string, target: number): (() => void) | null => (
    api && target >= 0 && target < ids.length
      ? () => save(moveWithin([...ids], id, target))
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
        save(next);
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
  'data-pin-kind'?: SidebarPinKind;
};

/** Every kind a sidebar row can be pinned as: the shared list's kinds, and an artifact. */
type SidebarPinKind = PinKind | 'artifact';

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
function PinnedSection({ children, count, drop, heading = 'Pinned', howToPin, label, loading = false, noun, pinnedOnly = false, reorderable, target }: {
  children: ReactNode;
  count: number;
  drop: PinDrop | null;
  heading?: string;
  /** The heading mark's tip while there is nothing to arrange, where dragging a row in is not how this kind is pinned. */
  howToPin?: string;
  label: string;
  /**
   * In the Pinned tab, where no list beside it shows its own placeholders:
   * the rows are still being read, so placeholders stand in for them.
   */
  loading?: boolean;
  noun: string;
  /** In the Pinned tab, where no unpinned row sits beside it to be moved in. */
  pinnedOnly?: boolean;
  /** Whether any one kind holds two or more pins; each kind reorders on its own. */
  reorderable: boolean;
  target: React.HTMLAttributes<HTMLElement>;
}): React.JSX.Element {
  const hint = useId();
  // How to reorder is said once, for the section; each row says only its
  // place (`pinnedPosition`). As a per-row description it would be repeated
  // before every title.
  return <section aria-busy={loading || undefined} aria-describedby={reorderable ? hint : undefined} aria-label={label} className="navigation-section" {...target}>
    <SectionHeading motionKey={pinnedOnly ? `pinned:${noun}` : 'pinned'} trailing={<PinnedMark howToPin={howToPin} reorderable={reorderable} />}>{heading}</SectionHeading>
    {reorderable && <p className="sr-only" id={hint}>Hold Alt and press the up or down arrow to move a pinned {noun}.</p>}
    {loading && <SidebarSkeletonRows count={Math.max(1, count)} />}
    {!loading && count === 0 && drop?.index == null && <div className={clsx('pinned-empty-drop-surface', drop && 'is-armed')}>
      <IconPin aria-hidden="true" size={15} stroke={1.7} />
      <span>{pinnedOnly ? `Pin ${/^[aeiou]/u.test(noun) ? 'an' : 'a'} ${noun} to keep it here` : `Move a ${noun} here to pin it`}</span>
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
 * focuses it if the move left focus nowhere. Where the move took the row off
 * the tab, as unpinning does on Pinned, focus goes to the row that was beside
 * it, or to the tab's own button when none is left. Call before
 * `useListMotion`, whose first frame draws the row back at its old slot.
 */
function usePinReveal(
  scroll: RefObject<HTMLElement | null>,
  motionKeyOf: (id: string) => string,
  pinnedIds: ReadonlySet<string>,
): (id: string, pinned: boolean) => void {
  const [reveal, setReveal] = useState<{ id: string; pinned: boolean; neighbour: string | null } | null>(null);
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
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const neighbour = reveal.neighbour === null ? null : scroll.current?.querySelector<HTMLElement>(`[data-motion-key="${reveal.neighbour}"]`);
    const sectionButton = scroll.current?.closest('.navigation-sidebar')?.querySelector<HTMLElement>('.navigation-rail-button[aria-current="page"]');
    (row ?? neighbour ?? sectionButton)?.focus({ preventScroll: true });
  });
  return useCallback((id, pinned) => {
    // The row beside it, read now, while the row is still drawn.
    const rows = [...scroll.current?.querySelectorAll<HTMLElement>('[data-motion-key]:not([data-motion-key^="heading:"])') ?? []];
    const index = rows.findIndex((candidate) => candidate.dataset.motionKey === motionKeyOf(id));
    const neighbour = index < 0 ? null : (rows[index + 1] ?? rows[index - 1])?.dataset.motionKey ?? null;
    setReveal({ id, pinned, neighbour });
  }, [motionKeyOf, scroll]);
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

/** The Pinned heading's pin; its tooltip says how to pin, then how to arrange once there is something to arrange. */
function PinnedMark({ howToPin = 'Drag a row here or right-click it to pin', reorderable }: { howToPin?: string | undefined; reorderable: boolean }): React.JSX.Element {
  const mark = <span aria-hidden="true" className="navigation-section-mark">
    <IconPin size={14} stroke={1.8} />
  </span>;
  return <Tip label={reorderable ? 'Drag to reorder' : howToPin}>{mark}</Tip>;
}

/** A Channel's identity as a tile: its glyph on its hue's pastel pair. */
function channelLook(space: SpaceSummary): { Icon: LucideIcon; tint: string; ink: string } {
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
  return { key: space.id, shape: 'squircle', fill: ink, ink: tint, icon: Icon, label: space.name };
}

/** A thread as a badge, inverted the same way, with its Channel on its corner. */
function threadBadge(threadId: string, title: string, saved: WorkstreamAppearance | undefined, channel: SpaceSummary | undefined): TileBadge {
  const { Icon, ink, tint } = resolveWorkstreamAppearance(threadId, saved);
  return { key: threadId, shape: 'circle', fill: ink, ink: tint, icon: Icon, label: title, badge: channel && channelBadge(channel) };
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
  const thread = liveById.get(row.breakoutOf.workstreamId)?.appearance;
  const appearance = thread ?? row.breakoutOf.appearance;
  // A breakout's colour is its thread's: the server writes both from their
  // Channel in one job (`channel-color-sync.ts`). Only the thread's row is
  // live here, so without this a Channel recolour left the breakout's own
  // tile in the old colour until the list was read again.
  const color = thread?.color;
  return {
    ...row,
    ...(color ? { appearance: { icon: row.appearance?.icon ?? null, color } } : {}),
    breakoutOf: { ...row.breakoutOf, appearance },
  };
}

/** A list motion with nothing to watch, for a section drawn inside a tab that runs one over several. */
const NO_CONTAINER: RefObject<HTMLElement | null> = { current: null };

/**
 * The Pinned tab: what this person pinned, a section per kind, each the same
 * Pinned list its own tab draws above everything else, so a pin made or
 * moved in one is the same pin in the other. A guest has no Channels section
 * here either. Two motions over one scroll box would each animate every row,
 * so the tab owns one and each section runs it on its own commits: a drag
 * re-renders only its section.
 */
function PinnedPanel({ guest, scroll }: { guest: boolean; scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const motion = useListMotionPass(scroll);
  return <>
    {!guest && <ChannelsSection motion={motion} scroll={scroll} />}
    <ThreadsSection motion={motion} scroll={scroll} />
    <ArtifactsSection motion={motion} scroll={scroll} />
  </>;
}

/**
 * A section's list motion: its own over the scroll box, or, inside the Pinned
 * tab, the tab's shared one. Call after `usePinReveal`.
 */
function useSectionMotion(scroll: RefObject<HTMLElement | null>, shared: (() => void) | undefined): void {
  const own = useListMotionPass(shared ? NO_CONTAINER : scroll);
  const run = shared ?? own;
  useLayoutEffect(() => run());
}

/**
 * The Threads tab: what this person pinned, then every thread and breakout
 * they take part in. The list is the server's (`GET /navigation/threads`); a
 * thread the socket holds is drawn from the socket, so its dot moves live.
 */
/** `motion` is the Pinned tab's shared list motion; given it, only the pinned rows are drawn. */
function ThreadsSection({ motion, scroll }: { motion?: () => void; scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const pinnedOnly = motion !== undefined;
  const { api } = useAppSession();
  const sort = useUiStore((state) => state.threadSort);
  const setSort = useUiStore((state) => state.setThreadSort);
  const live = useWorkstreamsQuery();
  const spaces = useSpaceMap();
  const pins = usePins();
  const pin = usePinAction(api);
  const openChannelId = useOpenChannelId();
  const openThreadId = useOpenThreadId();
  const { search } = useLocation();
  // A breakout's pathname names its parent; its own row is named by the query.
  const breakoutId = new URLSearchParams(search).get('substream');
  const openRowId = openThreadId !== null && breakoutId && breakoutId !== '0' ? breakoutId : openThreadId;
  const list = useMyThreads();
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
    .sort(compareChannels(sort));
  // Opening reads a thread. Keep its last displayed slot while it is open,
  // rather than promoting every selection to the attention group. All other
  // rows still sort live, and an explicit sort change starts a fresh order.
  const previousOrder = useRef<{ sort: SidebarChannelSort; ids: string[] } | null>(null);
  if (sort === 'needs_you' && previousOrder.current?.sort === sort && openRowId !== null) {
    const heldIndex = previousOrder.current.ids.indexOf(openRowId);
    const currentIndex = unpinned.findIndex((row) => row.id === openRowId);
    if (heldIndex >= 0 && currentIndex >= 0 && heldIndex !== currentIndex) {
      const [held] = unpinned.splice(currentIndex, 1);
      unpinned.splice(heldIndex, 0, held!);
    }
  }
  useLayoutEffect(() => {
    previousOrder.current = { sort, ids: unpinned.map((row) => row.id) };
  });
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
    // The Pinned tab draws no pages past the pins, so there is nothing to load.
    if (pinnedOnly || !list.hasNextPage) {
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
  useSectionMotion(scroll, motion);
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
    active={row.id === openRowId}
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
      heading={pinnedOnly ? 'Threads' : undefined}
      label="Pinned threads"
      loading={pinnedOnly && list.isPending}
      noun="thread"
      pinnedOnly={pinnedOnly}
      reorderable={threadPins.length > 1 || breakoutPins.length > 1}
      target={pinDrop.targetProps}
    >
      {pinnedRows('thread', threadDrag, 0)}
      {pinnedRows('breakout', breakoutDrag, threadDrag.order.length)}
    </PinnedSection>
    {!pinnedOnly && <section aria-busy={list.isPending || undefined} aria-label="All threads" className="navigation-section">
      <SectionHeading motionKey="threads" trailing={<SortButton onChange={setSort} sort={sort} sorts={THREAD_SORTS} />}>All threads</SectionHeading>
      {list.isPending && rows.length === 0 && <SidebarSkeletonRows count={6} hint />}
      {unpinned.map((row) => renderRow(
        row,
        row.pending ? undefined : pinDrop.sourceProps(pinKind(row), row.id, row.breakoutOf?.workstreamId, row),
      ))}
      {list.isSuccess && rows.length === 0 && <p className="navigation-empty">Threads you start or are added to appear here.</p>}
      {list.hasNextPage && <button className="navigation-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} type="button">Show more</button>}
      {list.isError && <InlineError>Your threads couldn’t be loaded.</InlineError>}
    </section>}
    {pinnedOnly && list.isError && <InlineError>Your threads couldn’t be loaded.</InlineError>}
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
    ? [threadBadge(row.breakoutOf.workstreamId, row.breakoutOf.title, row.breakoutOf.appearance, channels[0])]
    : channels.map(channelBadge);
  const names = channels.map((space) => space.name).join(' · ');
  const detail = row.kind === 'breakout' && row.breakoutOf
    ? <>
      {row.breakoutOf.title}
      {names && <>
        <IconChevronRight aria-label="in" className="navigation-row-detail-chevron" role="img" size={12} stroke={2} />
        {names}
      </>}
    </>
    : names;
  const threadId = row.breakoutOf?.workstreamId ?? row.id;
  const warmup = useWorkstreamSocketHoverWarmup(threadId);
  const socketOpenContext = useWorkstreamSocketOpenContext(threadId);
  const { pathname, search } = useLocation();
  const route = `${pathname}${search}`;
  const naming = useNamingSkeleton(row);
  const live = !ghost && !row.pending;
  const open = (event: React.MouseEvent): void => {
    // The open row clicked again is not a new open, but it still asks for the
    // pane expanded, in place of its own history entry, in case the reader
    // collapsed it.
    if (opensElsewhere(event) || route === href) return;
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
        replace={route === href}
        state={OPEN_EXPANDED}
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
 * The Artifacts tab, and the Pinned tab's Artifacts part: the artifacts this
 * person pinned, in their order. Only pinned ones for now, so the tab draws
 * its Pinned part alone; an artifact is pinned from its card's `⋯` or
 * right-click menu, not by dragging a row in. A row opens its thread with the
 * artifact's panel open (`openThreadResourceState`).
 */
function ArtifactsSection({ motion, scroll }: { motion?: () => void; scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const inPinnedTab = motion !== undefined;
  const { api } = useAppSession();
  const pins = useArtifactPins();
  const setPinned = useArtifactPinAction(api);
  const live = useWorkstreamsQuery();
  const openChannelId = useOpenChannelId();
  const ids = useMemo(() => pins.map((pin) => pin.id), [pins]);
  const pinnedIds = useMemo(() => new Set(ids), [ids]);
  const drag = usePinnedDrag('artifact', ids);
  const revealPin = usePinReveal(scroll, (id) => `artifact:${id}`, pinnedIds);
  useSectionMotion(scroll, motion);
  const byId = new Map(pins.map((pin) => [pin.id, pin]));
  return <PinnedSection
    count={pins.length}
    drop={null}
    heading={inPinnedTab ? 'Artifacts' : undefined}
    howToPin="Pin an artifact from its ⋯ menu"
    label="Pinned artifacts"
    noun="artifact"
    pinnedOnly
    reorderable={pins.length > 1}
    target={{}}
  >
    {drag.order.map((id, index) => {
      const pin = byId.get(id);
      if (!pin) return null;
      // The live copy of the thread draws a recolour before the list is read again.
      const appearance = live.data?.find((row) => row.id === pin.threadId)?.appearance ?? pin.thread.appearance ?? undefined;
      return <ArtifactRow
        appearance={appearance}
        drag={drag.rowProps(id, index)}
        href={threadRoute(pin.threadId, homeChannelId(pin.thread.spaceIds, openChannelId))}
        key={id}
        moves={drag.moves(id, index)}
        onUnpin={() => {
          revealPin(id, false);
          setPinned(id, false, pin.threadId);
        }}
        pin={pin}
        position={pinnedPosition(index, pins.length)}
      />;
    })}
  </PinnedSection>;
}

/** An artifact's tile is neutral: an artifact has no hue of its own, as its card's badge has none. */
const ARTIFACT_TILE = { ink: 'var(--av-ref-color-neutral-11)', tint: 'var(--av-sys-color-surface-elevated-hover)' } as const;

/** A pinned artifact: its sheet tile badged with its thread, its title, and its kind and thread. */
function ArtifactRow({ appearance, drag, href, moves, onUnpin, pin, position }: {
  appearance: WorkstreamAppearance | undefined;
  drag: PinnedRowProps;
  href: string;
  moves: PinMoves;
  onUnpin: () => void;
  pin: ArtifactPin;
  position: string;
}): React.JSX.Element {
  const route = useCurrentRoute();
  const resource = { resourceType: pin.resourceType, title: pin.title, ...(pin.mimeType ? { mimeType: pin.mimeType } : {}) };
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <Link
        className={clsx('navigation-row navigation-artifact-row', pin.unread && 'is-unread')}
        data-motion-key={`artifact:${pin.id}`}
        replace={route === href}
        state={openThreadResourceState(pin.threadId, pin.id)}
        to={href}
        {...drag}
      >
        <RowLayout
          detail={`${resourceKindLabel(resource)} · ${pin.thread.title}`}
          tile={<IdentityTile
            // The thread alone: a nested Channel badge would push it over the glyph.
            badges={[threadBadge(pin.threadId, pin.thread.title, appearance, undefined)]}
            icon={resourceGlyph(resource)}
            ink={ARTIFACT_TILE.ink}
            shape="sheet"
            tint={ARTIFACT_TILE.tint}
          />}
          time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={pin.updatedAt} />}
          title={pin.title}
          unread={pin.unread}
        />
        <span className="sr-only">{position}</span>
      </Link>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <ContextMenu.Item className="menu-item" onSelect={onUnpin}>
          <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} />
          Unpin
        </ContextMenu.Item>
        <PinMoveItems moves={moves} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

/**
 * The Channels tab: what this person pinned, then every Channel they may see,
 * in the order the sort control names (A–Z until changed). A Channel's second
 * line appears only when threads were placed in it since this person last had
 * it open, and says how many, in red beside a bold name, with a dot.
 */
/** Members only: a guest has no Channels section. */
function ChannelsSection({ motion, scroll }: { motion?: () => void; scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const pinnedOnly = motion !== undefined;
  const { active } = useSpaceDirectories();
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
  useSectionMotion(scroll, motion);
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
    <PinnedSection
      count={channelPins.length}
      drop={drop}
      heading={pinnedOnly ? 'Channels' : undefined}
      label="Pinned channels"
      loading={pinnedOnly && active.data === undefined}
      noun="channel"
      pinnedOnly={pinnedOnly}
      reorderable={channelPins.length > 1}
      target={pinDrop.targetProps}
    >
      {withPinDrop('channel', drag.order, drop).map((id) => {
        const space = byId.get(id);
        if (!space) return null;
        if (id === drop?.id) return row(space, undefined, undefined, !drop.landed);
        const index = drag.order.indexOf(id);
        return row(space, drag.rowProps(id, index), drag.moves(id, index), false, pinnedPosition(index, drag.order.length));
      })}
    </PinnedSection>
    {!pinnedOnly && <section aria-busy={active.data === undefined || undefined} aria-label="All channels" className="navigation-section">
      <SectionHeading motionKey="channels" trailing={<SortButton onChange={setSort} sort={sort} sorts={CHANNEL_SORTS} />}>All channels</SectionHeading>
      {active.data === undefined && <SidebarSkeletonRows count={5} hint />}
      {rest.map((space) => row(space, pinDrop.sourceProps('channel', space.id)))}
      {active.data !== undefined && channels.length === 0 && <p className="navigation-empty">No channels yet.</p>}
    </section>}
  </>;
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
  // The server counts the feed's rows above the read position; the optimistic
  // read acknowledgement clears `hasUnread` before that count comes back.
  const fresh = stats?.hasUnread ? stats.newThreadCount : 0;
  const unread = fresh > 0;
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
          detail={unread && <span className="navigation-row-news">{fresh === 1 ? '1 new thread' : `${fresh} new threads`}</span>}
          tile={<ChannelTile space={space} />}
          time={stats?.lastActivityAt && <RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} tipPrefix="Last update at" value={stats.lastActivityAt} />}
          title={space.name}
          titleExtra={space.scope !== 'workspace' && <IconLock aria-label="Private" className="navigation-row-lock" size={13} stroke={1.8} />}
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
      const colorKey = SPACE_COLOR_KEYS[Math.floor(Math.random() * SPACE_COLOR_KEYS.length)]!;
      const created = await api.createSpace({ name: name.trim(), colorKey, scope: 'workspace' });
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
  new_message: 'replied in',
  thread_started: 'started',
  breakout_started: 'started a breakout on',
  run_finished: 'finished',
  merged: 'merged',
  artifact_updated: 'updated',
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
 * Mark all read: the server's waterline moves to the newest row held, and
 * every held page drops its dots now. Reading what a row names is the other
 * way a row is read (`lib/activity-events.ts`). Showing the tab
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
 * the person reads what it names (`lib/activity-events.ts`) or chooses Mark
 * all read, so Unread is a list to work through rather than one glance.
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
  const actorMember = (item: ActivityItem): WorkspaceMember | undefined =>
    members.data?.find((member) => member.id === item.actorUserId);
  const actorName = (item: ActivityItem, member: WorkspaceMember | undefined): string => item.actorLabel
    || member?.name
    || 'Someone';
  // Who acted, drawn as they are everywhere else: Rally's mark, or the
  // person's own avatar. A guest has no directory, so a person it cannot find
  // is drawn from the name the row carries.
  const actorBadge = (item: ActivityItem, member: WorkspaceMember | undefined, name: string): TileBadge => ({
    key: 'actor',
    shape: 'circle',
    content: item.actorUserId === null
      ? <RallyAvatar />
      : <Avatar member={member ?? { id: item.actorUserId, name, email: '', timezone: '' }} title={null} />,
  });
  const pinnedArtifacts = useArtifactPins();
  const artifactGlyph = (resourceId: string): LucideIcon => {
    const pin = pinnedArtifacts.find((candidate) => candidate.id === resourceId);
    return pin ? resourceGlyph({ resourceType: pin.resourceType, mimeType: pin.mimeType, title: pin.title }) : File;
  };
  const feed = useActivityFeed(only);
  const fetched = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.items), [feed.data]);
  const flattened = groupActivityItems(fetched);
  const items = chip === 'unread' ? flattened.filter((item) => item.unread) : flattened;
  // An artifact's row opens its thread onto the artifact, expanded; every
  // other row asks for its pane expanded.
  const linkState = (item: ActivityItem) => (item.kind === 'artifact_updated' && item.artifact
    ? openThreadResourceState(item.threadId, item.artifact.resourceId)
    : OPEN_EXPANDED);
  const href = (item: ActivityItem): string => {
    // A merge opens where it landed: the Channel, or the thread a breakout
    // merged into.
    if (item.kind === 'merged' && item.mergedInto) return channelRoute(item.mergedInto.channelId);
    const parent = live.data?.find((candidate) => candidate.id === item.threadId);
    return threadRoute(item.threadId, homeChannelId(parent?.spaceIds ?? item.channelIds),
      item.kind === 'merged' ? undefined : item.breakout?.substreamId);
  };
  // New activity pushes the rows under it down, and a request arriving or
  // answered slides in or out, rather than the list jumping.
  useListMotion(scroll);
  const groups: Array<{ label: string; items: ActivityGroup[] }> = [];
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
        const member = actorMember(item);
        const name = actorName(item, member);
        const actor = actorBadge(item, member, name);
        const thread = resolveWorkstreamAppearance(item.threadId, live.data?.find((candidate) => candidate.id === item.threadId)?.appearance);
        return <Link
          className={clsx('activity-row', item.unread ? 'is-unread' : 'is-read')}
          data-motion-key={`activity:${item.groupKey}`}
          key={item.groupKey}
          state={linkState(item)}
          to={href(item)}
        >
          {item.kind === 'artifact_updated' && item.artifact
            ? <IdentityTile badges={[actor]} icon={artifactGlyph(item.artifact.resourceId)} ink={ARTIFACT_TILE.ink} shape="sheet" tint={ARTIFACT_TILE.tint} />
            : channel
            ? <ChannelTile badges={[actor]} space={channel} />
            : <IdentityTile badges={[actor]} icon={thread.Icon} ink={thread.ink} shape="circle" tint={thread.tint} />}
          <span className="activity-row-body">
            <span className="activity-row-text">
              <strong>{name}</strong> {ACTIVITY_VERBS[item.kind]}{' '}
              {item.kind === 'artifact_updated' ? <>
                <strong>{item.artifact?.title ?? 'an artifact'}</strong> in <strong>{item.threadTitle}</strong>
              </> : item.kind === 'merged' ? <>
                {/* A merge from a thread this reader cannot open names no thread. */}
                {item.mergedInto?.threadPrivate ? 'a private thread' : <strong>{item.breakout ? item.breakout.title : item.threadTitle}</strong>} into{' '}
                <strong>{item.breakout ? item.threadTitle : item.mergedInto?.name ?? 'a channel'}</strong>
              </> : <strong>{item.breakout && item.kind !== 'breakout_started' ? item.breakout.title : item.threadTitle}</strong>}
            </span>
            {item.kind === 'new_message' && item.preview && <span className="activity-row-detail activity-message-preview">{item.preview}</span>}
            {(item.unreadMessages > 0 || item.unreadMention) && <span className="activity-row-detail">
              {item.unreadMessages > 0 ? `${item.unreadMessages} new message${item.unreadMessages === 1 ? '' : 's'}` : ''}
              {item.unreadMention ? `${item.unreadMessages > 0 ? ' · ' : ''}@mention` : ''}
            </span>}
            {item.rallyFinished && item.kind !== 'run_finished' && <span className="activity-row-detail">Rally also finished</span>}
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

