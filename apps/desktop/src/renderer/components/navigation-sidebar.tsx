import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ActivityItem, ConversationAccessRequestItem, PinKind, PinList, SpaceSummary } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-icon';
import { markColors } from '@rally/ui/lib/project-palette';
import {
  IconArrowsSort,
  IconBell,
  IconCancel,
  IconCheck,
  IconCloudDownload,
  IconCornerDownRight,
  IconDeviceDesktopDown,
  IconHash,
  IconLock,
  IconMenu2,
  IconMessages,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';

import type { AttentionItem } from '../lib/attention-items';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { formatSidebarActivityTime, workstreamMarkerStatus } from '../lib/format';
import { channelRoute, homeChannelId, threadRoute } from '../lib/navigation-routes';
import { moveWithin } from '../lib/personal-order';
import { compareChannels } from '../lib/sidebar-channel-order';
import { ACTIVITY_QUERY_KEY, CHANNEL_STATS_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, MY_THREADS_QUERY_KEY, PINS_QUERY_KEY, SPACES_QUERY_KEY } from '../lib/sidebar-list-store';
import type { SpaceConversationSummary, Workspace } from '../lib/types';
import { useUiStore, type SidebarChannelSort, type SidebarSection } from '../lib/ui-store';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { Button, IconButton, InlineError, Modal, StatusDot, Tip } from './primitives';
import { RelativeTime } from './relative-time';
import { ResizableSidebar, SidebarFooterItems, SidebarScroll } from '@rally/ui/components/resizable-sidebar';
import type { ChannelStats, SpaceDirectory } from '@rally/contracts';

const NAVIGATION_SHEET_ID = 'rally-navigation-sheet';
/** The stylesheet's phone breakpoint: at or under it the sidebar is a sheet. */
const PHONE_LAYOUT_MAX_WIDTH = 640;

const SECTIONS: ReadonlyArray<{ id: SidebarSection; label: string; icon: ReactNode }> = [
  { id: 'threads', label: 'Threads', icon: <IconMessages aria-hidden="true" size={20} stroke={1.7} /> },
  { id: 'channels', label: 'Channels', icon: <IconHash aria-hidden="true" size={20} stroke={1.7} /> },
  { id: 'activity', label: 'Activity', icon: <IconBell aria-hidden="true" size={20} stroke={1.7} /> },
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
 * The sidebar: a section switcher (Threads, Channels, Activity) beside one
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
  const section = useUiStore((state) => state.sidebarSection);
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
  const guest = workspace.currentUser.accessClass === 'guest';
  const pinFailure = usePinFailure();
  // The same number as the dock badge and the menu bar: every conversation
  // waiting on this reader, and every access request waiting on them.
  const waiting = attentionItems.length + accessRequests.length;
  const title = SECTIONS.find((candidate) => candidate.id === section)?.label ?? 'Threads';
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
        {SECTIONS.map((candidate) => <button
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
            <IconButton disabled={!onOpenSearch} label="Search organization" onClick={onOpenSearch}>
              <IconSearch aria-hidden="true" size={16} stroke={1.9} />
            </IconButton>
            {!guest && onOpenImport && <IconButton label="Import a conversation" onClick={onOpenImport}>
              <IconCloudDownload aria-hidden="true" size={17} stroke={1.8} />
            </IconButton>}
          </div>
        </header>
        <SidebarScroll className="navigation-panel-scroll">
          {pinFailure && <InlineError>{pinFailure}</InlineError>}
          {section === 'threads' && <ThreadsSection />}
          {section === 'channels' && <ChannelsSection guest={guest} />}
          {section === 'activity' && <ActivitySection
            accessDecisionFailed={accessDecisionFailed}
            accessRequests={accessRequests}
            attentionComplete={attentionComplete}
            guest={guest}
            onDecideAccessRequest={onDecideAccessRequest}
            onOpenAccessRequest={onOpenAccessRequest}
          />}
        </SidebarScroll>
        {footerItems && <SidebarFooterItems>{footerItems}</SidebarFooterItems>}
      </div>
    </div>
    {accountSlot && createPortal(accountMenu, accountSlot)}
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

/** The last pin or reorder that did not save, shown above whichever tab is open. */
const PIN_FAILURE_QUERY_KEY = ['navigation', 'pin-failure'] as const;

function pinFailureCopy(error: unknown): string {
  return error instanceof ApiError && error.code === 'pin_limit_reached'
    ? 'You’ve pinned as many items as Rally allows. Unpin one first.'
    : 'That pin didn’t save. Try again.';
}

function usePinFailure(): string | null {
  return useQuery<string | null>({ queryKey: PIN_FAILURE_QUERY_KEY, queryFn: () => null, enabled: false }).data ?? null;
}

/** How many pin writes this window has started; only the newest one's answer is held. */
let pinWritesStarted = 0;

/**
 * Hold a pin write's answer, or say why it failed. Each answer is the whole
 * list, and two writes in flight can answer in either order, so an answer is
 * held only when no later write has started; the later one's answer, or the
 * snapshot every write republishes, carries what the older one would have.
 */
function usePinWrite(): (write: Promise<PinList>) => void {
  const queryClient = useQueryClient();
  return (write) => {
    const issued = ++pinWritesStarted;
    void write.then((list) => {
      if (issued !== pinWritesStarted) return;
      queryClient.setQueryData(PINS_QUERY_KEY, list);
      queryClient.setQueryData(PIN_FAILURE_QUERY_KEY, null);
    }, (error: unknown) => queryClient.setQueryData(PIN_FAILURE_QUERY_KEY, pinFailureCopy(error)));
  };
}

function usePins(): PinList {
  return useQuery<PinList>({ queryKey: PINS_QUERY_KEY, queryFn: async () => [], enabled: false }).data ?? [];
}

/** Pin or unpin, answered with the whole list, which replaces what is held. */
function usePinAction(): (kind: PinKind, id: string, pinned: boolean, parentId?: string) => void {
  const { api } = useAppSession();
  const write = usePinWrite();
  return (kind, id, pinned, parentId) => {
    if (api) write(api.setPinned(kind, id, pinned, parentId));
  };
}

/**
 * A Pinned list arranged by dragging: the order moves under the pointer and is
 * saved on drop. The server answers with the whole pin list, which replaces the
 * one held.
 */
function usePinnedDrag(kind: PinKind, ids: readonly string[]): {
  order: readonly string[];
  rowProps: (id: string, index: number) => React.HTMLAttributes<HTMLElement> & { draggable: boolean };
} {
  const { api } = useAppSession();
  const write = usePinWrite();
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const order = drag?.order ?? ids;
  return {
    order,
    rowProps: (id, index) => ({
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move';
        setDrag({ id, order: [...ids] });
      },
      onDragOver: (event) => {
        if (!drag) return;
        event.preventDefault();
        if (drag.order[index] !== drag.id) setDrag({ id: drag.id, order: moveWithin(drag.order, drag.id, index) });
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

function SectionHeading({ children, trailing }: { children: ReactNode; trailing?: ReactNode }): React.JSX.Element {
  return <div className="navigation-section-heading">
    <span>{children}</span>
    {trailing && <span className="navigation-section-trailing">{trailing}</span>}
  </div>;
}

/** The Channels a thread sits in that this person may see, as small marks. */
function ChannelChips({ spaceIds, spaces }: { spaceIds: readonly string[]; spaces: ReadonlyMap<string, SpaceSummary> }): React.JSX.Element | null {
  const shown = spaceIds.flatMap((id) => {
    const space = spaces.get(id);
    return space ? [space] : [];
  });
  if (shown.length === 0) return null;
  return <span className="navigation-chips">
    {shown.map((space) => <span className="navigation-chip" key={space.id}>
      <SpaceIcon size={12} space={space} />
      <span>{space.name}</span>
    </span>)}
  </span>;
}

function useSpaceMap(): Map<string, SpaceSummary> {
  const { active } = useSpaceDirectories();
  return useMemo(() => new Map((active.data?.items ?? []).map((space) => [space.id as string, space])), [active.data]);
}

/**
 * The Threads tab: what this person pinned, then every thread and breakout
 * they take part in. The list is the server's (`GET /navigation/threads`); a
 * thread the socket holds is drawn from the socket, so its dot moves live.
 */
function ThreadsSection(): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const sort = useUiStore((state) => state.threadSort);
  const setSort = useUiStore((state) => state.setThreadSort);
  const live = useWorkstreamsQuery();
  const spaces = useSpaceMap();
  const pins = usePins();
  const pin = usePinAction();
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
    return [...started, ...fetched.map((row) => row.kind === 'channel'
      ? { ...row, ...liveById.get(row.id), kind: row.kind, breakoutOf: row.breakoutOf }
      : row)];
  }, [list.data, live.data, liveById]);
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const threadPins = pins.filter((item) => item.kind === 'thread').map((item) => item.id);
  const breakoutPins = pins.filter((item) => item.kind === 'breakout').map((item) => item.id);
  const threadDrag = usePinnedDrag('thread', threadPins);
  const breakoutDrag = usePinnedDrag('breakout', breakoutPins);
  const pinned = new Set([...threadPins, ...breakoutPins]);
  const unpinned = rows.filter((row) => !pinned.has(row.id)).sort(compareChannels(sort, openThreadId));
  const open = (row: SpaceConversationSummary): void => {
    if (row.kind === 'breakout' && row.breakoutOf) {
      const parent = live.data?.find((candidate) => candidate.id === row.breakoutOf!.workstreamId);
      void navigate(threadRoute(row.breakoutOf.workstreamId, homeChannelId(parent?.spaceIds ?? row.spaceIds, openChannelId), row.id));
      return;
    }
    void navigate(threadRoute(row.id, homeChannelId(row.spaceIds, openChannelId)));
  };
  const nextSort = THREAD_SORTS[(THREAD_SORTS.findIndex((candidate) => candidate.sort === sort) + 1) % THREAD_SORTS.length]!;
  const renderRow = (row: SpaceConversationSummary, drag?: React.HTMLAttributes<HTMLElement> & { draggable: boolean }): ReactNode => <ThreadRow
    active={row.id === openThreadId}
    drag={drag}
    key={row.id}
    onOpen={() => open(row)}
    onPin={(next) => pin(row.kind === 'breakout' ? 'breakout' : 'thread', row.id, next, row.breakoutOf?.workstreamId)}
    pinned={pinned.has(row.id)}
    row={row}
    spaces={spaces}
  />;
  return <>
    {pinned.size > 0 && <section aria-label="Pinned threads" className="navigation-section">
      <SectionHeading trailing="Drag to reorder">Pinned</SectionHeading>
      {threadDrag.order.map((id, index) => {
        const row = byId.get(id);
        return row ? renderRow(row, threadDrag.rowProps(id, index)) : null;
      })}
      {breakoutDrag.order.map((id, index) => {
        const row = byId.get(id);
        return row ? renderRow(row, breakoutDrag.rowProps(id, index)) : null;
      })}
    </section>}
    <section aria-label="Threads" className="navigation-section">
      <SectionHeading trailing={<button className="navigation-sort" onClick={() => setSort(nextSort.sort)} type="button">
        {THREAD_SORTS.find((candidate) => candidate.sort === sort)?.label}
        <IconArrowsSort aria-hidden="true" size={13} stroke={1.8} />
      </button>}>Threads</SectionHeading>
      {unpinned.map((row) => renderRow(row))}
      {list.isSuccess && rows.length === 0 && <p className="navigation-empty">Threads you start or are added to appear here.</p>}
      {list.hasNextPage && <button className="navigation-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} type="button">Show more</button>}
      {list.isError && <InlineError>Your threads couldn’t be loaded.</InlineError>}
    </section>
  </>;
}

function ThreadRow({ active, drag, onOpen, onPin, pinned, row, spaces }: {
  active: boolean;
  drag?: (React.HTMLAttributes<HTMLElement> & { draggable: boolean }) | undefined;
  onOpen: () => void;
  onPin: (pinned: boolean) => void;
  pinned: boolean;
  row: SpaceConversationSummary;
  spaces: ReadonlyMap<string, SpaceSummary>;
}): React.JSX.Element {
  const status = workstreamMarkerStatus(row);
  // A finished or stopped run with nothing unread is the resting state, drawn without a dot.
  const quiet = status === 'completed' || status === 'stopped';
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <button
        aria-current={active ? 'page' : undefined}
        className={clsx('navigation-row navigation-thread-row', active && 'is-active', !quiet && 'has-activity')}
        onClick={onOpen}
        type="button"
        {...drag}
      >
        <span className="navigation-row-marker">{!quiet && <StatusDot compact status={status} tooltip />}</span>
        <span className="navigation-row-copy">
          <span className="navigation-row-title">{row.pending ? 'Starting…' : row.title}</span>
          {row.kind === 'breakout' && row.breakoutOf
            ? <span className="navigation-chips">
              <span className="navigation-chip">
                <IconCornerDownRight aria-hidden="true" size={12} stroke={1.8} />
                <span>{row.breakoutOf.title}</span>
              </span>
            </span>
            : <ChannelChips spaceIds={row.spaceIds} spaces={spaces} />}
        </span>
      </button>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <ContextMenu.Item className="menu-item" onSelect={() => onPin(!pinned)}>
          {pinned ? <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} /> : <IconPin aria-hidden="true" size={15} stroke={1.8} />}
          {pinned ? 'Unpin' : 'Pin'}
        </ContextMenu.Item>
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
function ChannelsSection({ guest }: { guest: boolean }): React.JSX.Element {
  const navigate = useNavigate();
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
  const pin = usePinAction();
  const openChannelId = useOpenChannelId();
  const sort = useUiStore((state) => state.channelSort);
  const setSort = useUiStore((state) => state.setChannelSort);
  const [creating, setCreating] = useState(false);
  const statsById = useMemo(() => new Map((stats.data ?? []).map((item) => [item.channelId, item])), [stats.data]);
  const channels = active.data?.items ?? [];
  const byId = new Map(channels.map((space) => [space.id as string, space]));
  const channelPins = pins.filter((item) => item.kind === 'channel').map((item) => item.id).filter((id) => byId.has(id));
  const drag = usePinnedDrag('channel', channelPins);
  const pinned = new Set(channelPins);
  const rest = channels.filter((space) => !pinned.has(space.id))
    .sort(compareChannelRows(sort, statsById, openChannelId));
  const nextSort = CHANNEL_SORTS[(CHANNEL_SORTS.findIndex((candidate) => candidate.sort === sort) + 1) % CHANNEL_SORTS.length]!;
  const row = (space: SpaceSummary, rowDrag?: React.HTMLAttributes<HTMLElement> & { draggable: boolean }): ReactNode => <ChannelRow
    active={space.id === openChannelId}
    drag={rowDrag}
    key={space.id}
    onOpen={() => void navigate(channelRoute(space.id))}
    onPin={(next) => pin('channel', space.id, next)}
    pinned={pinned.has(space.id)}
    space={space}
    stats={statsById.get(space.id)}
  />;
  return <>
    {channelPins.length > 0 && <section aria-label="Pinned channels" className="navigation-section">
      <SectionHeading trailing="Drag to reorder">Pinned</SectionHeading>
      {drag.order.map((id, index) => {
        const space = byId.get(id);
        return space ? row(space, drag.rowProps(id, index)) : null;
      })}
    </section>}
    <section aria-label="All channels" className="navigation-section">
      <SectionHeading trailing={<>
        <button className="navigation-sort" onClick={() => setSort(nextSort.sort)} type="button">
          {CHANNEL_SORTS.find((candidate) => candidate.sort === sort)?.label}
          <IconArrowsSort aria-hidden="true" size={13} stroke={1.8} />
        </button>
        {!guest && <Tip label="New channel"><button aria-label="New channel" className="navigation-sort" onClick={() => setCreating(true)} type="button">
          <IconPlus aria-hidden="true" size={14} stroke={1.9} />
        </button></Tip>}
      </>}>All channels</SectionHeading>
      {rest.map((space) => row(space))}
      {active.data !== undefined && channels.length === 0 && <p className="navigation-empty">No channels yet.</p>}
    </section>
    {!guest && (inactive.data?.items.length ?? 0) > 0 && <ArchivedChannels channels={inactive.data!.items} />}
    {creating && <NewChannelDialog onClose={() => setCreating(false)} />}
  </>;
}

/**
 * Archived Channels, folded away under their own heading, each with
 * **Restore**. A restore brings back the threads the archive took out; any it
 * moved to General stay there too.
 */
function ArchivedChannels({ channels }: { channels: readonly SpaceSummary[] }): React.JSX.Element {
  const { api } = useAppSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const restore = (space: SpaceSummary): void => {
    if (!api) return;
    setFailed(null);
    void api.restoreSpace(space.id).then((restored) => {
      queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, (current) => current ? {
        ...current, items: current.items.filter((item) => item.id !== space.id),
      } : current);
      queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
        ...current, items: [...current.items.filter((item) => item.id !== space.id), restored],
      } : current);
    }, () => setFailed(space.name));
  };
  return <section aria-label="Archived channels" className="navigation-section">
    <SectionHeading trailing={<button aria-expanded={open} className="navigation-sort" onClick={() => setOpen(!open)} type="button">
      {open ? 'Hide' : `Show ${channels.length}`}
    </button>}>Archived</SectionHeading>
    {failed && <InlineError>{failed} couldn’t be restored. Try again.</InlineError>}
    {open && [...channels].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((space) => <div className="navigation-archived-row" key={space.id}>
        <span className="navigation-channel-mark is-small" style={{ background: markColors(space.colorKey).tint }}>
          <SpaceIcon size={16} space={space} />
        </span>
        <span className="navigation-archived-name">{space.name}</span>
        <Button onClick={() => restore(space)}>Restore</Button>
      </div>)}
  </section>;
}

function ChannelRow({ active, drag, onOpen, onPin, pinned, space, stats }: {
  active: boolean;
  drag?: (React.HTMLAttributes<HTMLElement> & { draggable: boolean }) | undefined;
  onOpen: () => void;
  onPin: (pinned: boolean) => void;
  pinned: boolean;
  space: SpaceSummary;
  stats: ChannelStats | undefined;
}): React.JSX.Element {
  const count = stats?.threadCount ?? 0;
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <button
        aria-current={active ? 'page' : undefined}
        className={clsx('navigation-row navigation-channel-row', active && 'is-active', stats?.hasUnread && 'is-unread')}
        onClick={onOpen}
        type="button"
        {...drag}
      >
        <span className="navigation-channel-mark" style={{ background: markColors(space.colorKey).tint }}>
          <SpaceIcon size={18} space={space} />
        </span>
        <span className="navigation-row-copy">
          <span className="navigation-row-line">
            <span className="navigation-row-title">{space.name}</span>
            {space.scope === 'personal' && <IconLock aria-label="Private" className="navigation-row-lock" size={13} stroke={1.8} />}
            {stats?.lastActivityAt && <RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={stats.lastActivityAt} />}
            {stats?.hasUnread && <span aria-label="Unread" className="navigation-row-unread-dot" role="img" />}
          </span>
          <span className="navigation-row-detail">{count === 1 ? '1 thread' : `${count} threads`}</span>
        </span>
      </button>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <ContextMenu.Item className="menu-item" onSelect={() => onPin(!pinned)}>
          {pinned ? <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} /> : <IconPin aria-hidden="true" size={15} stroke={1.8} />}
          {pinned ? 'Unpin' : 'Pin'}
        </ContextMenu.Item>
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

function dayLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  const start = (offset: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime();
  if (date.getTime() >= start(0)) return 'Today';
  if (date.getTime() >= start(1)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * The Activity tab: requests to join waiting on this person, then what
 * happened to them, newest first and grouped by day. Opening it reads it, so
 * the next opening's dots are only what came after.
 */
function ActivitySection({ accessDecisionFailed, accessRequests, attentionComplete, guest, onDecideAccessRequest, onOpenAccessRequest }: {
  accessDecisionFailed: boolean;
  guest: boolean;
  accessRequests: readonly ConversationAccessRequestItem[];
  attentionComplete: boolean;
  onDecideAccessRequest: (request: ConversationAccessRequestItem, decision: AccessDecision) => void;
  onOpenAccessRequest: (request: ConversationAccessRequestItem) => void;
}): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const live = useWorkstreamsQuery();
  const spaces = useSpaceMap();
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
    queryKey: ACTIVITY_QUERY_KEY,
    queryFn: ({ pageParam, signal }) => api!.getActivity(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api),
    refetchOnMount: 'always',
  });
  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.items), [feed.data]);
  const markedThrough = useRef<string | null>(null);
  const newest = items[0]?.occurredAt ?? null;
  useEffect(() => {
    if (!api || !newest || markedThrough.current === newest) return;
    markedThrough.current = newest;
    void api.markActivitySeen(newest).catch(() => undefined);
  }, [api, newest]);
  const open = (item: ActivityItem): void => {
    const parent = live.data?.find((candidate) => candidate.id === item.threadId);
    void navigate(threadRoute(item.threadId, homeChannelId(parent?.spaceIds ?? item.channelIds), item.breakout?.substreamId));
  };
  const groups: Array<{ label: string; items: ActivityItem[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.occurredAt);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return <>
    {accessDecisionFailed && <InlineError>That didn’t go through. Try again.</InlineError>}
    {accessRequests.length > 0 && <section aria-label="Requests to join" className="navigation-section">
      <SectionHeading>Requests</SectionHeading>
      {accessRequests.map((request) => <div className="activity-row activity-request" key={request.id}>
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
    {groups.map((group) => <section aria-label={group.label} className="navigation-section" key={group.label}>
      <SectionHeading>{group.label}</SectionHeading>
      {group.items.map((item) => {
        const channel = item.channelIds.map((id) => spaces.get(id)).find(Boolean);
        return <button className={clsx('activity-row', item.unread && 'is-unread')} key={item.id} onClick={() => open(item)} type="button">
          <span aria-hidden="true" className={clsx('activity-avatar', item.actorUserId === null && 'is-rally')}>
            {item.actorUserId === null ? '✦' : actorName(item).split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
          </span>
          <span className="activity-row-body">
            <span className="activity-row-text">
              <strong>{actorName(item)}</strong> {ACTIVITY_VERBS[item.kind]}{item.kind === 'run_finished' ? ': ' : ' '}
              <strong>{item.breakout && item.kind !== 'breakout_started' ? item.breakout.title : item.threadTitle}</strong>
            </span>
            {item.kind === 'breakout_started' && item.breakout && <span className="breakout-chip activity-chip">
              <IconCornerDownRight aria-hidden="true" className="breakout-chip-icon" size={13} stroke={1.9} />
              <span className="breakout-chip-title">{item.breakout.title}</span>
            </span>}
            <span className="activity-row-detail">
              {channel ? `in ${channel.name} · ` : ''}
              <RelativeTime format={formatSidebarActivityTime} value={item.occurredAt} />
            </span>
          </span>
          {item.unread && <span aria-label="Unread" className="activity-unread-dot" role="img" />}
        </button>;
      })}
    </section>)}
    {feed.isSuccess && items.length === 0 && accessRequests.length === 0 && <p className="navigation-empty">
      {attentionComplete ? 'Nothing new. Activity about your threads shows up here.' : 'Still loading…'}
    </p>}
    {feed.hasNextPage && <button className="navigation-more" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()} type="button">Show more</button>}
    {feed.isError && <InlineError>Activity couldn’t be loaded.</InlineError>}
  </>;
}

