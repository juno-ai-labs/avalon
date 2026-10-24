import { MessageIssueProvider } from '../components/message-issue-dialog';
import { readAnnotationVersion } from '../lib/annotation-preview';
import { newWorkstreamDraftKey } from '../lib/draft-keys';
import { usePeopleRanking } from '../lib/use-people-ranking';
import { AnnotationDraftProvider } from '../components/artifact-annotations';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import type { ChannelMessage, ChannelStats, ChannelStatsList, SpaceSummary, WorkstreamAppearancePatch } from '@rally/contracts';
import { AppearancePicker, AppearanceSubmenu } from '@rally/ui/components/appearance-picker';
import type { BreakoutMark } from '@rally/ui/components/breakout-marks';
import { ConversationCard } from '@rally/ui/components/conversation-card';
import { MergeMessage } from '@rally/ui/components/merge-message';
import { resolveWorkstreamAppearance } from '@rally/ui/components/workstream-glyph';
import { ChannelContainerMenu } from '@rally/ui/components/conversation-menus';
import type { SidekickRow } from '@rally/ui/components/sidekick-section';
import { ChannelGlyph, spaceMark } from '@rally/ui/components/space-icon';
import { SplitConversationLayout, type SplitConversationMode } from '@rally/ui/components/split-conversation';
import { TitleMenuItem, TitlePillAction, TitlePillHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { IconCloudDownload, IconLock, IconPalette, IconPlus } from '@tabler/icons-react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

import { ChannelComposer } from '../components/channel-composer';
import { AttachmentPanel } from '../components/attachment-panel';
import type { AttachmentPreview } from '../components/attachments';
import { InspectorRail } from '../components/inspector-rail';
import { openMemorySource, useMemoryFacts } from '../components/memory-review';
import { MarkdownBody, MessageActions } from '../components/workstream-blocks';
import type { CitationContext } from '../components/markdown-citations';
import { openLink } from '../lib/browser-rail-links';
import { Avatar, Button, EmptyState, ErrorNotice, LoadingState, Modal, RallyAvatar } from '../components/primitives';
import { RelativeTime } from '../components/relative-time';
import { reportActivityEvent } from '../lib/activity-events';
import { ApiError } from '../lib/api';
import { useAppSession } from '../lib/app-session';
import { layoutKey, readLayout, writeLayout } from '../lib/desktop-layout';
import { copySpaceLink } from '../lib/copy-workstream-link';
import { ChannelPaneContextValue, OPEN_EXPANDED, channelArtifactRoute, channelRoute, revealChannelMessageRequest, threadRoute, usePaneExpansion, type ChannelPaneContext } from '../lib/navigation-routes';
import { PaneVisibility } from '../lib/pane-visibility';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';
import { useNow } from '../lib/clock';
import { formatDayLabel } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import { CHANNEL_STATS_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, SPACES_QUERY_KEY, channelFeedQueryKey } from '../lib/sidebar-list-store';
import { usePinAction, usePinnedIds } from '../lib/pins';
import { spaceFailureSentence } from '../lib/space-failure-copy';
import { WORKSTREAM_LANDING_ROUTE } from '../lib/workstream-landing';
import { typedMentionRendering } from '../lib/transcript';
import { EmailMentionContext, emailMentionDirectory, NO_INVITEES, useWorkspaceInvitees } from '../lib/workspace-invitees';
import { useWorkspaceMembers } from '../lib/workspace-members';
import type { AutomationSummary, ResourceVersion, Workspace, WorkspaceMember, WorkstreamResource, WorkstreamSummary } from '../lib/types';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useUiStore } from '../lib/ui-store';
import { useResourceHeads, withResourceHead } from '../lib/resource-heads';
import { useRailFillsPane } from '../lib/rail-split';
import { useSiteArtifacts } from '../lib/use-site-artifacts';
import { expandToggle } from '../components/pane-expand-toggle';
import { useVisibleReadAcknowledgement } from '../lib/use-visible-read-acknowledgement';
import { useCachedWorkstreamAppearance, useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { RemoveParticipantDialog, resourceVersionsQueryKey } from './conversation-surface';
import { WorkstreamScreen } from './workstream';
import type { SpaceDirectory } from '@rally/contracts';

/**
 * A Channel: a list of threads, and a composer that starts one. There is no
 * conversation here — nothing is said in a Channel and nothing runs in it — so
 * the screen is a feed of what has been started, each thread as its title,
 * summary and who started it, split by day, and the composer below.
 * See `docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`.
 */
export function ChannelScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { channelId = '', '*': rest = '' } = useParams();
  const { api } = useAppSession();
  const threadId = /^threads\/([^/]+)$/.exec(rest)?.[1] ?? null;
  const artifactId = /^artifacts\/([^/]+)$/.exec(rest)?.[1] ?? null;
  return <AnnotationDraftProvider draftKey={`${newWorkstreamDraftKey(workspace.region, workspace.id)}:space:${channelId}`} scopeKey={`channel:${channelId}`} readResource={api ? (id) => api.getResource(id) : undefined} readResourceVersion={api ? (id,version,signal,annotation,mimeType) => readAnnotationVersion(api,id,version,signal,annotation,mimeType) : undefined} upload={api ? async (file) => (await api.uploadResource(file,crypto.randomUUID())).id : undefined}><ChannelStack artifactId={artifactId} channelId={channelId} threadId={threadId} workspace={workspace} /></AnnotationDraftProvider>;
}

/**
 * A Channel, and one of its threads open beside it: the first two panes of
 * the stack. The thread pane is the ordinary thread screen; when it opens a
 * breakout or a panel it needs both panes, and the Channel steps off screen to
 * ride as the first breadcrumb (`docs/pane-stack.md`). The same two-slot layout
 * a thread uses for its breakout, one level up, so both panes stay mounted —
 * the Channel's composer and scroll survive a thread opening and closing.
 */
function ChannelStack({ artifactId, channelId, threadId, workspace }: {
  /** An artifact open in the Channel's own panel, beside its feed. */
  artifactId: string | null;
  channelId: string;
  threadId: string | null;
  workspace: Workspace;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { session } = useAppSession();
  const space = useChannel(channelId);
  const [threadUsesTwoPanes, setThreadUsesTwoPanes] = useState(false);
  // A request to open a breakout expanded is the breakout's: the thread keeps
  // whatever it had, beside the Channel or expanded over it.
  const opensBreakout = new URLSearchParams(useLocation().search).has('substream');
  const { expanded: held, setExpanded } = usePaneExpansion(threadId, !opensBreakout);
  // A breakout or a panel puts the expansion on hold: the thread and what it
  // opened split the window as they would have, and closing it returns to the
  // thread expanded, as it was.
  const expanded = held && !threadUsesTwoPanes;
  const [shown, setShown] = useState<SplitConversationMode>('split');
  const widthKey = layoutKey(session?.workspace?.id ?? 'unbound', session?.user.id ?? 'unbound', 'thread-width');
  const [threadWidth, setThreadWidth] = useState<number | null>(() => {
    const stored = Number.parseFloat(readLayout(widthKey) ?? '');
    return Number.isFinite(stored) ? stored : null;
  });
  const changeThreadWidth = useCallback((width: number): void => {
    setThreadWidth(width);
    writeLayout(widthKey, String(width));
  }, [widthKey]);
  const shifted = threadId !== null && (threadUsesTwoPanes || expanded || shown === 'breakout');
  const pane = useMemo<ChannelPaneContext | null>(() => threadId === null ? null : ({
    channelId,
    crumb: {
      key: `channel-container:${channelId}`,
      icon: space ? <ChannelGlyph space={space} /> : null,
      ...(space ? { bridge: { mark: spaceMark(space), name: space.name, action: 'Open channel' } } : {}),
      title: space?.name ?? 'Channel',
      label: `Open ${space?.name ?? 'the channel'}`,
      // The Channel alone. The thread and its breakout leave with the
      // thread's route, and each surface closes its own panel as it unmounts.
      onSelect: () => void navigate(channelRoute(channelId)),
    },
    shifted,
    setThreadUsesTwoPanes,
    expanded,
    setExpanded,
  }), [channelId, expanded, navigate, setExpanded, shifted, space, threadId]);
  return <ChannelPaneContextValue.Provider value={pane}>
    <SplitConversationLayout
      breakout={threadId === null ? null : <WorkstreamRoute key={threadId} />}
      breakoutWidth={threadWidth}
      main={<PaneVisibility visible={shown !== 'breakout'}>
        <ChannelPane channelId={channelId} openArtifactId={threadId === null ? artifactId : null} openThreadId={threadId} workspace={workspace} />
      </PaneVisibility>}
      mode={threadId === null ? 'main' : threadUsesTwoPanes || expanded ? 'breakout' : 'split'}
      onBreakoutWidthChange={changeThreadWidth}
      onShownChange={setShown}
    />
  </ChannelPaneContextValue.Provider>;
}

/** The thread screen reads its id from the route, so it is mounted under `threads/:id`. */
function WorkstreamRoute(): React.JSX.Element {
  return <Routes>
    <Route element={<WorkstreamScreen />} path="threads/:id" />
  </Routes>;
}

/** The Channel's directory row, as the socket keeps it. */
function useChannel(channelId: string): SpaceSummary | undefined {
  const { active } = useSpaceDirectories();
  return active.data?.items.find((space) => space.id === channelId);
}

type FeedRow =
  | { kind: 'thread'; placedAt: string; attentionSequenceNumber?: number; thread: WorkstreamSummary }
  | { kind: 'message'; placedAt: string; attentionSequenceNumber?: number; message: ChannelMessage };

/** A thread card's element id in the feed, so a merge can bring its thread into view. */
function feedThreadElementId(threadId: string): string {
  return `channel-feed-thread-${threadId}`;
}

function feedRowId(row: FeedRow): string {
  return row.kind === 'thread' ? row.thread.id : row.message.id;
}

function containsReadBoundary(rows: readonly FeedRow[], firstUnread: number | null): boolean {
  if (firstUnread === null) return true;
  const ordered = [...rows].reverse();
  const unreadIndex = ordered.findIndex((row) => (row.attentionSequenceNumber ?? 0) >= firstUnread);
  return unreadIndex !== 0 && rows.some((row) => {
    const sequence = row.attentionSequenceNumber ?? 0;
    return sequence > 0 && sequence <= firstUnread;
  });
}

function isAtNewest(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

/**
 * What to acknowledge for a Channel the reader has open, or null when there is
 * nothing to send: the newest visible placement, when it is past the cached
 * read position. Only reaching the end acknowledges the whole server waterline,
 * including placements no longer listed in the feed.
 */
export function channelReadAcknowledgement(
  visibleSequence: number,
  stats: Pick<ChannelStats, 'readThroughSequenceNumber'>,
): { readThroughSequenceNumber: number } | null {
  if (visibleSequence === 0 || visibleSequence <= stats.readThroughSequenceNumber) return null;
  return { readThroughSequenceNumber: visibleSequence };
}

/** Replace one Channel's row in the channel-stats cache. */
function writeChannelStats(list: ChannelStatsList | undefined, channelId: string, write: (row: ChannelStats) => ChannelStats): ChannelStatsList | undefined {
  return list?.map((row) => row.channelId === channelId ? write(row) : row);
}

function ChannelPane({ channelId, openArtifactId, openThreadId, workspace }: {
  channelId: string;
  openArtifactId: string | null;
  openThreadId: string | null;
  workspace: Workspace;
}): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const location = useLocation();
  const reveal = revealChannelMessageRequest(location.state);
  const [finishedRevealKey, setFinishedRevealKey] = useState<string | null>(null);
  const { active } = useSpaceDirectories();
  const space = useChannel(channelId);
  const live = useWorkstreamsQuery();
  const feed = useInfiniteQuery({
    queryKey: channelFeedQueryKey(channelId),
    queryFn: ({ pageParam, signal }) => api!.getChannelFeed(channelId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api && channelId && space),
  });
  // The feed is the server's order and visibility; a row the socket already
  // holds is drawn from the socket, so its dot and title move live. A thread
  // started here a moment ago is in the socket's list before the feed is read
  // again, so it is drawn at once.
  const liveById = useMemo(() => new Map((live.data ?? []).map((row) => [row.id, row])), [live.data]);
  const rows = useMemo<FeedRow[]>(() => {
    const fetched = (feed.data?.pages ?? []).flatMap((page) => page.items);
    const known = new Set(fetched.map(feedRowId));
    // A thread stays drawn from the socket from the moment it is started until
    // the feed lists it. Its pending mark clears when the create answers, which
    // can be before the feed is read again; dropping it in that gap made the
    // row vanish and come back. Newer than the newest listed placement is what
    // keeps an older thread that is merely not on a loaded page out.
    // Until the feed has answered there is nothing to be newer than, so only a
    // thread still being created is drawn; otherwise every thread the socket
    // knows in this Channel would flash in as if just started.
    const newestListed = feed.isSuccess ? fetched[0]?.placedAt ?? '' : undefined;
    const started = (live.data ?? [])
      .filter((row) => !known.has(row.id) && row.spaceIds.includes(channelId)
        && (row.pending || (newestListed !== undefined && (row.createdAt ?? '') > newestListed)))
      .map((thread): FeedRow => ({ kind: 'thread', placedAt: thread.createdAt ?? new Date().toISOString(), thread }));
    return [...started, ...fetched.map((item): FeedRow => item.kind === 'thread'
      ? { ...item, thread: liveById.get(item.thread.id) ?? item.thread }
      : item)];
  }, [channelId, feed.data, feed.isSuccess, live.data, liveById]);
  const queryClient = useQueryClient();
  // The Channel is read while it is open in a focused, visible window: the
  // same gate a conversation's read acknowledgement uses. One request per
  // position in flight; a failure leaves the sidebar dot standing and is not
  // retried, so an unread Channel that will not clear is what gets noticed.
  // At the end, the first page's latest number also covers placements since
  // removed or archived. Elsewhere only visible rows advance the waterline.
  const newestLoadedSequence = useMemo(() => Math.max(0, ...(feed.data?.pages ?? [])
    .flatMap((page) => [
      ...page.items.map((item) => item.attentionSequenceNumber ?? 0),
      page.latestAttentionSequenceNumber ?? 0,
    ])), [feed.data]);
  // Reuse fresh pushed stats, but refresh invalidated or missing state before
  // choosing a read position, even when the Channels sidebar is not shown.
  const channelStats = useQuery<ChannelStatsList>({
    queryKey: CHANNEL_STATS_QUERY_KEY,
    queryFn: ({ signal }) => api!.getChannelStats(signal),
    enabled: Boolean(api && space),
    staleTime: Infinity,
    retry: false,
  });
  const stats = channelStats.data?.find((row) => row.channelId === channelId);
  const statsAttempt = useRef<string | null>(null);
  const statsReady = stats !== undefined && !channelStats.isStale && !channelStats.isFetching && !channelStats.isError;
  // Only an admitted feed needs a reading-position error. A stale directory
  // row can still be here while the feed's authority refuses a private Channel.
  const statsUnavailable = feed.isSuccess && !feed.isFetching && (channelStats.isError
    || (!stats && statsAttempt.current === channelId && !channelStats.isFetching));
  useEffect(() => {
    if (!api || !space) return;
    if (channelStats.isFetching) {
      statsAttempt.current = channelId;
      return;
    }
    if (!channelStats.isError && (channelStats.isStale || (!stats && statsAttempt.current !== channelId))) {
      statsAttempt.current = channelId;
      void channelStats.refetch();
    }
  }, [api, channelId, channelStats.isError, channelStats.isFetching, channelStats.isStale, channelStats.refetch, space, stats]);
  // An artifact panel expanded over the feed, or filling a narrow window,
  // covers it: what arrives behind it has not been seen.
  const railExpanded = useUiStore((state) => state.railExpanded);
  const fillsPane = useRailFillsPane(useUiStore((state) => state.sidebarWidth));
  const feedCovered = openArtifactId !== null && (railExpanded || fillsPane);
  const ackInFlight = useRef<string | null>(null);
  const activityReportedRef = useRef<{ channelId: string; through: number } | null>(null);
  // The pane stays mounted from one Channel to the next; coming back to one
  // whose acknowledgement failed is opening it again, and may send again.
  useEffect(() => { ackInFlight.current = null; }, [channelId]);
  const acknowledgeRead = useCallback((): void => {
    if (!api || !stats || !statsReady || feedCovered || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const element = feedScroll.current;
    if (!element || element.clientHeight === 0 || anchoredChannel.current !== channelId) return;
    if (degradedOpening.current) return;
    const viewport = element.getBoundingClientRect();
    const atEnd = isAtNewest(element);
    const visibleSequence = atEnd ? newestLoadedSequence : Math.max(0, ...Array.from(
      element.querySelectorAll<HTMLElement>('[data-attention-sequence]'),
    ).filter((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    }).map((row) => Number(row.dataset.attentionSequence)));
    // Activity is told what is on screen whether or not the Channel's own read
    // position needs moving, once per Channel and again when it rises.
    const reported = activityReportedRef.current;
    if (visibleSequence > 0 && (reported?.channelId !== channelId || visibleSequence > reported.through)) {
      activityReportedRef.current = { channelId, through: visibleSequence };
      reportActivityEvent(api, queryClient, {
        kind: 'read',
        subject: { kind: 'channel', channelId },
        through: visibleSequence,
      });
    }
    const pending = channelReadAcknowledgement(visibleSequence, stats);
    if (!pending) return;
    const key = `${channelId}:${pending.readThroughSequenceNumber}`;
    if (ackInFlight.current === key) return;
    ackInFlight.current = key;
    void api.acknowledgeChannelRead(channelId, pending.readThroughSequenceNumber)
      .then((updated) => {
        queryClient.setQueryData<ChannelStatsList>(CHANNEL_STATS_QUERY_KEY, (list) =>
          writeChannelStats(list, channelId, (row) => updated.readThroughSequenceNumber >= row.readThroughSequenceNumber ? updated : row));
      })
      // Leave the authoritative dot standing when the read was not recorded.
      .catch(() => undefined);
    // Rows intentionally reschedule visible reads, even when their arrival
    // does not change the newest attention sequence.
  }, [api, channelId, feedCovered, newestLoadedSequence, queryClient, rows, stats, statsReady]);
  const scheduleRead = useVisibleReadAcknowledgement(acknowledgeRead);
  // A guest's is the roster: names and faces, no addresses, no other guests.
  const members = useWorkspaceMembers(api, { guest: workspace.currentUser.accessClass === 'guest' });
  const memberById = useMemo(() => new Map((members.data ?? []).map((member) => [member.id, member])), [members.data]);
  // A summary's typed `@address` resolves against the directory the composer
  // below already reads, so it chips as it does in the thread.
  const invitees = useWorkspaceInvitees(api, workspace.currentUser.accessClass !== 'guest');
  const emailMentions = useMemo(
    () => emailMentionDirectory(members.data ?? NO_MEMBERS, invitees.data ?? NO_INVITEES),
    [invitees.data, members.data],
  );
  // Freeze the server's first-unread position for this visit before any visible
  // row is acknowledged. Later stats pushes must not move the reader again.
  const feedScroll = useRef<HTMLDivElement>(null);
  const feedVisible = useContext(ConversationVisibilityContext);
  const atNewest = useRef(true);
  const scrollChannel = useRef(channelId);
  const anchoredChannel = useRef<string | null>(null);
  const heldScrollTop = useRef(0);
  const restoreScroll = useRef(false);
  const degradedOpening = useRef(false);
  const previousHeight = useRef(0);
  const earlierPages = feed.data?.pages.length ?? 0;
  const previousPages = useRef(earlierPages);
  const openingRead = useRef<{ channelId: string; firstUnread: number | null } | null>(null);
  const [positionedChannel, setPositionedChannel] = useState<string | null>(null);
  const { fetchNextPage, hasNextPage, isFetching, isFetchNextPageError } = feed;
  const feedLoaded = feed.data !== undefined;
  useLayoutEffect(() => {
    // Even an empty or still-loading Channel starts a new visit. Otherwise
    // A -> empty B -> A can mistake A's first page for a history prepend.
    if (scrollChannel.current !== channelId) {
      scrollChannel.current = channelId;
      anchoredChannel.current = null;
      atNewest.current = true;
      heldScrollTop.current = 0;
      previousHeight.current = 0;
      previousPages.current = earlierPages;
      openingRead.current = null;
      degradedOpening.current = false;
      setPositionedChannel(null);
    }
    const element = feedScroll.current;
    if (!element) return;
    // A pane hidden behind an expanded thread has no layout. Neither its
    // zero dimensions nor its scroll events describe the reader's position.
    if (!feedVisible || element.clientHeight === 0) {
      restoreScroll.current = true;
      return;
    }
    if (openingRead.current === null && statsReady) {
      openingRead.current = { channelId, firstUnread: stats.firstUnreadSequenceNumber };
    }
    const loadedEarlier = earlierPages > previousPages.current;
    previousPages.current = earlierPages;
    if (anchoredChannel.current !== channelId) {
      if (reveal && finishedRevealKey !== location.key) return;
      if ((!openingRead.current && !statsUnavailable) || !feedLoaded) return;
      const firstUnread = openingRead.current?.firstUnread ?? null;
      const missingUnread = firstUnread !== null && !rows.some((row) => (row.attentionSequenceNumber ?? 0) >= firstUnread);
      if (missingUnread && isFetching) return;
      if (hasNextPage && !containsReadBoundary(rows, firstUnread) && !isFetchNextPageError) return;
      degradedOpening.current = statsUnavailable || isFetchNextPageError;
      anchoredChannel.current = channelId;
      const ordered = [...rows].reverse();
      const unreadIndex = firstUnread === null ? -1 : ordered.findIndex((row) =>
        row.attentionSequenceNumber !== undefined && row.attentionSequenceNumber >= firstUnread);
      const targetIndex = degradedOpening.current ? 0 : Math.max(0, unreadIndex - 1);
      const target = unreadIndex < 0 && !degradedOpening.current ? null : element.querySelector<HTMLElement>(
        `[data-feed-row-id="${CSS.escape(ordered[targetIndex] ? feedRowId(ordered[targetIndex]) : '')}"]`,
      );
      const unread = unreadIndex < 0 ? null : element.querySelector<HTMLElement>(
        `[data-feed-row-id="${CSS.escape(feedRowId(ordered[unreadIndex]!))}"]`,
      );
      let top = rows.length === 0 ? 0 : target === null ? element.scrollHeight
        : element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top;
      if (unread && !degradedOpening.current) {
        const bounds = unread.getBoundingClientRect();
        top = Math.max(top, element.scrollTop + bounds.top - element.getBoundingClientRect().top
          - element.clientHeight + Math.min(bounds.height, element.clientHeight));
      }
      element.scrollTop = top;
      atNewest.current = isAtNewest(element);
      setPositionedChannel(channelId);
      scheduleRead();
    } else if (loadedEarlier) {
      element.scrollTop = heldScrollTop.current + element.scrollHeight - previousHeight.current;
    } else if (atNewest.current && rows.length > 0) {
      element.scrollTop = element.scrollHeight;
    } else if (restoreScroll.current) {
      element.scrollTop = heldScrollTop.current;
    }
    restoreScroll.current = false;
    heldScrollTop.current = element.scrollTop;
    previousHeight.current = element.scrollHeight;
    // `space` too: the feed element first mounts when the Channel list arrives,
    // which may be after the rows were already in hand.
  }, [channelId, earlierPages, feedLoaded, feedVisible, hasNextPage, isFetching, isFetchNextPageError,
    finishedRevealKey, location.key, reveal?.messageId, rows, scheduleRead, space, stats, statsReady, statsUnavailable]);
  // useInfiniteQuery updates its observer's address in a passive effect. A
  // layout-effect fetch during a route switch can still page the previous
  // Channel, so network work follows that update; positioning stays before paint.
  useEffect(() => {
    if (!feedVisible || !feedLoaded || isFetching || isFetchNextPageError || !hasNextPage
      || !feedScroll.current || feedScroll.current.clientHeight === 0) return;
    if (reveal && finishedRevealKey !== location.key) {
      if (reveal.searchHistory && !feedScroll.current.querySelector(`[data-message-id="${CSS.escape(reveal.messageId)}"]`)) {
        void fetchNextPage();
      }
      return;
    }
    if (anchoredChannel.current === channelId || openingRead.current?.channelId !== channelId) return;
    if (!containsReadBoundary(rows, openingRead.current.firstUnread)) void fetchNextPage();
  }, [channelId, feedLoaded, feedVisible, fetchNextPage, finishedRevealKey, hasNextPage, isFetching,
    isFetchNextPageError, location.key, reveal?.messageId, reveal?.searchHistory, rows, stats]);
  // A navigation onto one message brings it into view once per navigation,
  // and lights it briefly so the eye lands on it. One just posted (a merge) is
  // revealed once the feed lists it as its newest row. Newest, not merely
  // listed: a repeat merge keeps its message id and moves to the bottom, and
  // the cached feed still holds it where it was. An older one (a source's
  // merge divider) is revealed wherever it is, paging back until it is
  // loaded; until the feed is settled a missing row proves nothing, since a
  // Channel opened from its cache is still refetching.
  const revealedFor = useRef<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!reveal || revealedFor.current === location.key) return;
    if (!feedVisible || !feedScroll.current || feedScroll.current.clientHeight === 0) return;
    const target = feedScroll.current?.querySelector(`[data-message-id="${CSS.escape(reveal.messageId)}"]`);
    if (!reveal.searchHistory) {
      if (rows[0] === undefined || feedRowId(rows[0]) !== reveal.messageId || !target) {
        if (!feedLoaded || isFetching) return;
        if (!target) {
          revealedFor.current = location.key;
          setFinishedRevealKey(location.key);
          return;
        }
        atNewest.current = false;
      }
    } else if (!target) {
      if (!feedLoaded || isFetching || !feedScroll.current) return;
      if (!hasNextPage || isFetchNextPageError) {
        revealedFor.current = location.key;
        setFinishedRevealKey(location.key);
      }
      return;
    } else {
      atNewest.current = false;
    }
    revealedFor.current = location.key;
    setFinishedRevealKey(location.key);
    target.scrollIntoView({ block: 'center' });
    anchoredChannel.current = channelId;
    heldScrollTop.current = feedScroll.current.scrollTop;
    setPositionedChannel(channelId);
    scheduleRead();
    setHighlightedId(reveal.messageId);
  }, [channelId, feedLoaded, feedVisible, fetchNextPage, hasNextPage, isFetching, isFetchNextPageError, location.key,
    reveal?.messageId, reveal?.searchHistory, rows, scheduleRead, space]);
  useEffect(() => {
    if (highlightedId === null) return;
    const timer = window.setTimeout(() => setHighlightedId(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [highlightedId]);

  if (active.data === undefined) return <LoadingState label="Opening channel…" />;
  if (!space || (feed.error instanceof ApiError
    && (feed.error.code === 'space_access_denied' || feed.error.code === 'space_not_found'))) {
    return <EmptyState description="It may have been archived, made private, or you may no longer have access." title="Channel not found" />;
  }
  const openThread = (threadId: string): void => void navigate(threadRoute(threadId, channelId), { state: OPEN_EXPANDED });
  // What a merge shared with the Channel opens here, beside the feed, for
  // every reader of the Channel: it is the Channel's, not only the thread's.
  const openArtifact = (resourceId: string): void => void navigate(channelArtifactRoute(channelId, resourceId));
  // Only a member may start a thread in a private Channel; a thread placed
  // there is the Channel's to accept (`canEdit` on the server).
  const canStart = workspace.currentUser.accessClass !== 'guest' && space.reach !== 'through_channel';
  return <MessageIssueProvider api={api} target={{ kind: 'channel', channelId }}><div className="conversation-layout">
    <div className="channel-screen has-message-capsule">
      {/* Keyed so a confirmation still open when the route changes (a leave,
          a removal, an archive) cannot be continued against the next Channel. */}
      <ChannelHeader key={space.id} members={members.data ?? []} space={space} workspace={workspace} />
      <div className="channel-feed-pane">
        {feed.isError && <ErrorNotice occurrence={feed.error}>{isFetchNextPageError
          ? 'Earlier messages couldn’t be loaded. Use Show earlier to retry.'
          : 'The threads in this channel couldn’t be loaded.'}</ErrorNotice>}
        {statsUnavailable && <>
          <ErrorNotice occurrence={channelStats.error}>Your reading position couldn’t be loaded.</ErrorNotice>
          <Button onClick={() => {
            anchoredChannel.current = null;
            openingRead.current = null;
            degradedOpening.current = false;
            setPositionedChannel(null);
            void channelStats.refetch();
          }}>Retry reading position</Button>
        </>}
        <div
          className="channel-feed transcript-scroll"
          onScroll={(event) => {
            const element = event.currentTarget;
            if (!feedVisible || element.clientHeight === 0) return;
            if (element.scrollTop !== heldScrollTop.current) degradedOpening.current = false;
            heldScrollTop.current = element.scrollTop;
            atNewest.current = isAtNewest(element);
            scheduleRead();
          }}
          ref={feedScroll}
        >
          {/* Newest nearest the composer: the list reads down to now. */}
          <EmailMentionContext.Provider value={emailMentions}><ol aria-busy={positionedChannel !== channelId} aria-label={`${space.name} feed`} className="channel-feed-list">
            {feed.hasNextPage && <li className="channel-feed-more">
              <Button disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>Show earlier</Button>
            </li>}
            {[...rows].reverse().flatMap((row, index, ordered) => {
              // Grouped by the local calendar date, year and all; the label is
              // only for display, and two years' "Oct 2" are different days.
              const day = new Date(row.placedAt).toDateString();
              const card = row.kind === 'thread'
                ? <ThreadCard
                  attentionSequenceNumber={row.attentionSequenceNumber}
                  author={row.thread.createdByUserId ? memberById.get(row.thread.createdByUserId) : undefined}
                  key={row.thread.id}
                  members={members.data ?? NO_MEMBERS}
                  onOpen={openThread}
                  open={row.thread.id === openThreadId}
                  placedAt={row.placedAt}
                  thread={row.thread}
                />
                : row.message.merge
                  ? <MergeCard
                    attentionSequenceNumber={row.attentionSequenceNumber}
                    author={row.message.author.kind === 'member' ? memberById.get(row.message.author.userId) : undefined}
                    focused={row.message.id === highlightedId}
                    key={row.message.id}
                    members={members.data ?? NO_MEMBERS}
                    merge={row.message.merge}
                    message={row.message}
                    onOpenArtifact={openArtifact}
                    onOpenThread={openThread}
                    placedAt={row.placedAt}
                  />
                  : <MessageCard
                    attentionSequenceNumber={row.attentionSequenceNumber}
                    author={row.message.author.kind === 'member' ? memberById.get(row.message.author.userId) : undefined}
                    focused={row.message.id === highlightedId}
                    key={row.message.id}
                    members={members.data ?? NO_MEMBERS}
                    message={row.message}
                    placedAt={row.placedAt}
                  />;
              const previous = ordered[index - 1];
              if (previous && new Date(previous.placedAt).toDateString() === day) return [card];
              return [<DaySeparator key={`day:${feedRowId(row)}`} placedAt={row.placedAt} />, card];
            })}
          </ol></EmailMentionContext.Provider>
          {feed.isSuccess && rows.length === 0 && <div className="channel-feed-empty">
            {canStart ? <>
              <p>Channels in Rally act as places to gather related work. You can't talk directly in a channel with Rally or another person. Instead you create a thread for a specific piece of work you want to accomplish by typing it into the input box below.</p>
              <p>Rally will then create a thread for that work. In the thread you'll be able to work with Rally and other people (you can invite them manually using Add people in the thread's title pill or just tag them).</p>
              <p>One more thing... Once you're inside a thread you can create a breakout from any message. This is a private (but you can add people at any time) work area where you can work on first drafts, exploratory work, or anything else.</p>
              <p>You can always merge work back from a breakout into a thread (for example when the first draft is ready and you want to collaborate on it) or merge a thread back into this channel (for example when some work is complete).</p>
            </> : <p>No threads yet.</p>}
          </div>}
        </div>
      </div>
      {canStart && <ChannelComposer channelColor={space.colorKey} channelId={channelId} channelName={space.name} channelScope={space.scope === 'workspace' ? 'workspace' : 'personal'} threadOpen={openThreadId !== null} workspace={workspace} />}
    </div>
    {openArtifactId && <ChannelArtifactPanel
      channelId={channelId}
      space={space}
      key={openArtifactId}
      onClose={() => void navigate(channelRoute(channelId))}
      resourceId={openArtifactId}
    />}
  </div></MessageIssueProvider>;
}

/**
 * An artifact shared with the Channel, in the same panel a thread opens one
 * in. It is read by its id alone: the Channel holds no conversation, and its
 * reader may not be able to open the thread it came from.
 */
function ChannelArtifactPanel({ channelId, onClose, resourceId, space }: {
  channelId: string;
  onClose: () => void;
  resourceId: string;
  space: SpaceSummary;
}): React.JSX.Element {
  const { api } = useAppSession();
  const siteArtifacts = useSiteArtifacts(api);
  // Expanded over the Channel or beside it, with the same controls and
  // crumbs a thread's panel has (`docs/pane-stack.md`).
  const { expanded, setExpanded } = usePaneExpansion(`resource:${resourceId}`);
  const setRailExpanded = useUiStore((state) => state.setRailExpanded);
  useEffect(() => {
    setRailExpanded(expanded);
    return () => setRailExpanded(false);
  }, [expanded, setRailExpanded]);
  const fillsPane = useRailFillsPane(useUiStore((state) => state.sidebarWidth));
  const ancestors: TitlePillLevel[] | undefined = !expanded && !fillsPane ? undefined : [{
    key: `panel-channel:${channelId}`,
    icon: <ChannelGlyph space={space} />,
    bridge: { mark: spaceMark(space), name: space.name, action: 'Open channel' },
    title: space.name,
    label: `Show ${space.name}`,
    onSelect: () => (fillsPane ? onClose() : setExpanded(false)),
  }];
  // The shell makes room for the right slot while it is open, so the panel
  // claims it as a thread's does, scoped to this Channel, and gives it back.
  useEffect(() => {
    const scope = `channel:${channelId}`;
    const ui = useUiStore.getState();
    if (ui.railScope !== scope) ui.setRailScope(scope);
    ui.openRail('context');
    return () => {
      if (useUiStore.getState().railScope === scope) useUiStore.getState().closeRail();
    };
  }, [channelId]);
  const fetched = useQuery({
    queryKey: ['resource', resourceId],
    queryFn: () => api!.getResource(resourceId),
    enabled: Boolean(api),
    retry: false,
  });
  // The resource read carries no link, so no direction: what a merge shares
  // with a Channel is an artifact here, as its card draws it. A version
  // published while the panel is open moves it through the recorded heads,
  // as it moves a thread's copy (`lib/resource-heads.ts`).
  const head = useResourceHeads()[resourceId];
  const resource = useMemo(() => {
    if (!fetched.data) return fetched.isError ? null : undefined;
    const artifact: WorkstreamResource = { ...fetched.data, direction: 'artifact' };
    return head ? withResourceHead(artifact, head) : artifact;
  }, [fetched.data, fetched.isError, head]);
  const currentVersion = resource?.currentVersion ?? null;
  const versions = useQuery({
    queryKey: resourceVersionsQueryKey(resourceId, currentVersion),
    queryFn: ({ signal }) => api!.getResourceVersions(resourceId, signal),
    enabled: Boolean(api && currentVersion !== null),
  });
  // A prior version opens in this panel's place, and comes back to the
  // current one, as the thread's panel does.
  const [olderVersion, setOlderVersion] = useState<AttachmentPreview | null>(null);
  const openResourceVersion = useCallback((opened: WorkstreamResource, version: ResourceVersion) => {
    setOlderVersion({
      resourceId:opened.id,version:version.version,
      name: version.title,
      ...(version.mimeType ? { mimeType: version.mimeType } : {}),
      loadContent: (signal?: AbortSignal) => api!.getResourceVersionContent(opened.id, version.version, signal),
      superseded: {
        label: `Version ${version.version} · not current`,
        onReturnToCurrent: () => setOlderVersion(null),
      },
    });
  }, [api]);
  const railWidth = useUiStore((state) => state.railWidth);
  const setRailWidth = useUiStore((state) => state.setRailWidth);
  const loadResourceContent = useCallback((id: string, signal?: AbortSignal) => api
    ? api.getResourcePreviewContent(id, signal)
    : Promise.reject(new Error('No API session')), [api]);
  const loadOriginalResourceContent = useCallback((id: string, signal?: AbortSignal) => api
    ? api.getResourceContent(id, signal)
    : Promise.reject(new Error('No API session')), [api]);
  const expandAction = fillsPane ? undefined : expandToggle(expanded, true, setExpanded);
  if (olderVersion) {
    return <AttachmentPanel
      ancestors={ancestors}
      expandAction={expandAction}
      onClose={onClose}
      onResize={setRailWidth}
      preview={olderVersion}
      width={railWidth}
    />;
  }
  return <InspectorRail
    {...(api ? { loadResourceContent, loadOriginalResourceContent } : {})}
    onOpenResourceVersion={openResourceVersion}
    panel={{
      resourceId,
      onClose,
      expandAction,
      ancestors,
    }}
    resource={resource}
    resourceVersions={versions.data}
    resourceVersionsFailed={Boolean(versions.error)}
    {...(siteArtifacts ? { siteArtifacts } : {})}
  />;
}

/**
 * Where the feed crosses into another day: "Today", "Yesterday", a weekday, a
 * date. It reads the shared clock itself, so "Today" turns into "Yesterday" at
 * midnight without the feed re-rendering.
 */
function DaySeparator({ placedAt }: { placedAt: string }): React.JSX.Element {
  const label = formatDayLabel(placedAt, new Date(useNow()));
  return <li aria-label={label} className="channel-feed-day" role="separator">
    <span aria-hidden="true">{label}</span>
  </li>;
}

/** The default for a member list not yet loaded, hoisted so each card's memo holds. */
const NO_MEMBERS: WorkspaceMember[] = [];

/**
 * One thread in the feed: its title, its summary in a line or two, who started
 * it and when, and its mark beside them. The whole entry opens the thread.
 * Threads sit to the trailing side, as what people started; nothing else is
 * said in a Channel.
 */
function ThreadCard({ attentionSequenceNumber, author, members, onOpen, open, placedAt, thread }: {
  attentionSequenceNumber: number | undefined;
  author: WorkspaceMember | undefined;
  members: readonly WorkspaceMember[];
  onOpen: (threadId: string) => void;
  open: boolean;
  placedAt: string;
  thread: WorkstreamSummary;
}): React.JSX.Element {
  // The title says what the thread's own title pill says at every moment: a
  // skeleton while Rally names it, never the request's first line.
  const mark: BreakoutMark = {
    substreamId: thread.id,
    resolved: thread.resolved,
    title: thread.title,
    naming: thread.pending === true || thread.titleStatus === 'naming',
    unreadCount: thread.hasUnread ? 1 : 0,
    youAreMentioned: thread.youAreMentioned,
    unseen: thread.unseen,
    needsInput: thread.harnessStatus === 'needs_input',
    appearance: thread.appearance,
  };
  // Rally starts a thread only when nobody did; a person this reader cannot
  // look up (another guest, whom a guest's roster leaves out, or anyone while
  // the list loads after the feed) is somebody, not Rally.
  const byline = author?.name ?? (thread.createdByUserId ? 'Someone' : 'Rally');
  // The summary is the opening message's text without its mentions, so the
  // names in it are found again the way the send path found them, and drawn
  // by the renderer the message itself uses.
  const summary = useMemo(() => typedMentionRendering(thread.objective ?? '', members), [members, thread.objective]);
  return <li className="channel-feed-item" data-attention-sequence={attentionSequenceNumber} data-feed-row-id={thread.id} id={feedThreadElementId(thread.id)}>
    <ConversationCard
      conversation={mark}
      meta={<>
        {author && <Avatar member={author} size="small" title={null} />}
        <span>{byline}</span>
        <span aria-hidden="true">·</span>
        <RelativeTime value={placedAt} />
      </>}
      onOpen={() => onOpen(thread.id)}
      open={open}
      private={thread.scope === 'personal'}
      summary={thread.objective && <MarkdownBody glance mentions={summary.mentions} preserveLineBreaks rallyMentions verbatim>{summary.text}</MarkdownBody>}
    />
  </li>;
}

/**
 * A message in the Channel itself, outside any thread, by whoever said it:
 * Rally, or a member. Not a button, because there is nothing to open. Its hover
 * row is the one every message gets; a Channel has nothing to branch from or
 * merge into, so it carries the text actions alone.
 */
function MessageCard({ attentionSequenceNumber, author, focused, members, message, placedAt }: {
  attentionSequenceNumber: number | undefined;
  /** The member who said it, once the directory has them; unused for Rally. */
  author: WorkspaceMember | undefined;
  /** A navigation asked for this message; see `revealChannelMessageState`. */
  focused: boolean;
  members: readonly WorkspaceMember[];
  message: ChannelMessage;
  placedAt: string;
}): React.JSX.Element {
  const rally = message.author.kind === 'rally';
  const body = useMemo(() => typedMentionRendering(message.body, members), [members, message.body]);
  return <li className={clsx('channel-feed-item is-message', focused && 'is-focused')} data-attention-sequence={attentionSequenceNumber} data-feed-row-id={message.id} data-message-id={message.id}>
    <div className="channel-feed-message">
      {rally ? <RallyAvatar /> : author && <Avatar member={author} title={null} />}
      <div className="channel-feed-message-body">
        <div className="channel-feed-message-text">
          <MarkdownBody mentions={body.mentions} preserveLineBreaks rallyMentions verbatim>{body.text}</MarkdownBody>
        </div>
        {/* The row rides the byline rather than a line of its own: it is
            laid out even while hidden, and under every message it would make
            the feed a line taller at rest. */}
        <div className="channel-feed-byline">
          <span className="channel-feed-meta">
            <span>{rally ? 'Rally' : author?.name ?? 'Someone'}</span>
            <span aria-hidden="true">·</span>
            <RelativeTime value={placedAt} />
          </span>
          {/* Copy and speech take the stored words; the exports draw what the
              card drew, chips included. */}
          <MessageActions rendered={body} subject={rally ? 'response' : 'message'} telemetry={{ messageId: message.id }} text={message.body} verbatim />
        </div>
      </div>
    </div>
  </li>;
}

/**
 * A thread's merged result, on the left at the bottom of the feed when it was
 * merged, so the Channel reads in time order (docs/conversation-merge.md). It
 * names its thread, and that name opens it; it quotes the thread's summary;
 * its body renders as markdown with the artifacts it embeds as cards, drawn
 * from the titles stored with the merge. An artifact opens in the Channel's
 * own panel: the merge shared it with the Channel, so everyone who reads the
 * Channel may read it, whether or not they can open the thread.
 */
function MergeCard({ attentionSequenceNumber, author, focused, members, merge, message, onOpenArtifact, onOpenThread, placedAt }: {
  attentionSequenceNumber: number | undefined;
  author: WorkspaceMember | undefined;
  /** A navigation asked for this merge: a source's divider, or the merge just made. */
  focused: boolean;
  members: readonly WorkspaceMember[];
  merge: NonNullable<ChannelMessage['merge']>;
  message: ChannelMessage;
  onOpenArtifact: (resourceId: string) => void;
  onOpenThread: (threadId: string) => void;
  placedAt: string;
}): React.JSX.Element {
  const body = useMemo(() => typedMentionRendering(message.body, members), [members, message.body]);
  const citations = useMemo<CitationContext>(() => {
    const embeds = new Map(merge.embeds.flatMap((embed) => [[embed.id, embed] as const, ...(embed.slug ? [[embed.slug, embed] as const] : [])]));
    return {
      resolve: (resourceId) => {
        const embed = embeds.get(resourceId);
        return embed ? { id: embed.id, title: embed.title, resourceType: embed.kind } : undefined;
      },
      open: (target) => {
        if (target.scheme === 'external') void openLink(target.url);
        if (target.scheme !== 'resource') return;
        // The merge shared the artifact with the Channel, so it opens here,
        // by its id whichever spelling the body cited it by.
        const embed = embeds.get(target.resourceId);
        if (embed) onOpenArtifact(embed.id);
      },
    };
  }, [merge.embeds, onOpenArtifact]);
  const quote = merge.summary?.split('\n').find((line) => line.trim() !== '')?.trim();
  const appearance = useCachedWorkstreamAppearance(merge.threadId);
  const { Icon, tint, ink } = resolveWorkstreamAppearance(merge.threadId, appearance);
  const merger = author?.name ?? 'Someone';
  // The quote scrolls to the thread's card when that card is loaded, and
  // focus goes with it, so the next Tab starts from the card; an older one is
  // pages away, so the quote opens the thread instead.
  const showThread = (): void => {
    const card = document.getElementById(feedThreadElementId(merge.threadId));
    if (!card) return onOpenThread(merge.threadId);
    card.scrollIntoView({ block: 'center' });
    card.querySelector('button')?.focus({ preventScroll: true });
  };
  // A thread this reader cannot open is named only as private: no title, no
  // quote line, nothing to open.
  return <li className={clsx('channel-feed-item is-message is-merge', focused && 'is-focused')} data-attention-sequence={attentionSequenceNumber} data-feed-row-id={message.id} data-message-id={message.id}>
    <MergeMessage
      actions={<MessageActions citations={citations} rendered={body} telemetry={{ messageId: message.id }} text={message.body} />}
      label={`${merge.private ? 'A private thread' : merge.title || 'A thread'}, merged by ${merger}`}
      mergedBy={<>{author && <Avatar member={author} size="small" title={null} />}{merger}</>}
      onQuote={showThread}
      quote={merge.private ? null : quote}
      source={merge.private ? {
        mark: <IconLock aria-hidden="true" size={10} stroke={2} />,
        title: 'Private thread',
      } : {
        mark: <Icon size={10} strokeWidth={2} />,
        tint: { background: tint, ink },
        title: merge.title || 'A thread',
        onOpen: () => onOpenThread(merge.threadId),
      }}
      time={<RelativeTime value={placedAt} />}
    >
      <MarkdownBody citations={citations} mentions={body.mentions}>{body.text}</MarkdownBody>
    </MergeMessage>
  </li>;
}

/** The Channel's pill and its menu: people, audience, pin and Sidekicks. */
function ChannelHeader({ members, space, workspace }: {
  members: readonly WorkspaceMember[];
  space: SpaceSummary;
  workspace: Workspace;
}): React.JSX.Element {
  const { api, session } = useAppSession();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Taking somebody out, the reader included, asks first: a private Channel
  // is not theirs to come back to without somebody adding them again.
  const [removing, setRemoving] = useState<{ member: WorkspaceMember; pending: boolean; failure?: string } | null>(null);
  const [archiving, setArchiving] = useState<'confirm' | 'saving' | null>(null);
  const navigate = useNavigate();
  const pinnedChannels = usePinnedIds('channel');
  const pin = usePinAction(api);
  const library = useQuery<AutomationSummary[]>({ queryKey: ['automations'], queryFn: async () => [], enabled: false });
  // The Channel's own facts, read once its Memory level opens.
  const memory = useMemoryFacts({
    queryKey: ['memory', 'channel', space.id],
    read: (signal) => api!.getChannelMemory(space.id, signal),
    forget: (factId) => api!.forgetChannelMemory(space.id, factId),
    enabled: api !== null,
    lazy: true,
  });
  const member = workspace.currentUser.accessClass !== 'guest';
  const peopleRanking = usePeopleRanking(api, workspace.id, workspace.currentUser.id, space.id, member);
  const editable = member && space.reach !== 'through_channel';
  const general = space.systemRole === 'general';
  // A Personal Channel is its owner's alone: nobody can be added, it cannot
  // be made public or left, and it cannot be archived. It reads as private.
  const personal = space.scope === 'individual';
  const audienceScope = space.scope === 'workspace' ? 'workspace' : 'personal';
  const participantIds = space.participants.map((participant) => participant.userId as string);
  const roster = participantIds.flatMap((id) => {
    const found = members.find((candidate) => candidate.id === id);
    return found ? [found] : [];
  });
  // `null` is this person having left a private Channel: it is gone from
  // their list now rather than when the snapshot lands, and so are they.
  const stored = (next: SpaceSummary | null): void => {
    queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
      ...current,
      items: next
        ? current.items.map((item) => item.id === next.id ? next : item)
        : current.items.filter((item) => item.id !== space.id),
    } : current);
    if (!next) void navigate(WORKSTREAM_LANDING_ROUTE, { replace: true, state: { skipWorkstreamIds: [] } });
  };
  const run = async (write: () => Promise<SpaceSummary | null>, copy: string): Promise<void> => {
    setFailure(null);
    try {
      stored(await write());
    } catch {
      setFailure(copy);
    }
  };
  const setAudience = (scope: 'personal' | 'workspace', ids: readonly string[]): Promise<void> => run(
    () => api!.updateSpaceAudience(space.id, { scope, participantUserIds: [...ids] }),
    scope === 'personal' ? 'This channel couldn’t be made private.' : 'This channel’s people couldn’t be updated.',
  );
  const remove = async (person: WorkspaceMember): Promise<void> => {
    setRemoving({ member: person, pending: true });
    try {
      const next = await api!.updateSpaceAudience(space.id, {
        scope: audienceScope,
        participantUserIds: participantIds.filter((id) => id !== person.id),
      });
      setRemoving(null);
      stored(next);
    } catch (cause) {
      setRemoving({ member: person, pending: false, failure: spaceFailureSentence(cause, 'This channel’s people couldn’t be updated.') });
    }
  };
  const archive = async (): Promise<void> => {
    setArchiving('saving');
    setFailure(null);
    try {
      const archived = await api!.archiveSpace(space.id);
      // Out of the list now rather than when the snapshot lands, so the
      // landing below cannot pick it.
      queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
        ...current, items: current.items.filter((item) => item.id !== space.id),
      } : current);
      queryClient.setQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY, (current) => current ? {
        ...current, items: [...current.items.filter((item) => item.id !== space.id), archived],
      } : current);
      setArchiving(null);
      void navigate(WORKSTREAM_LANDING_ROUTE, { replace: true, state: { skipWorkstreamIds: [] } });
    } catch (cause) {
      setArchiving(null);
      setFailure(spaceFailureSentence(cause, 'This channel couldn’t be archived.'));
    }
  };
  // Every write saves the whole presentation (name, icon and colour), so a
  // rename and each pick run one after another and each starts from the one
  // before it: an icon chosen before a rename answers must not be sent back
  // as the old one. The header stays mounted from one Channel to the next, so
  // what is pending belongs to the Channel it was written for.
  type Presentation = Pick<SpaceSummary, 'id' | 'name' | 'iconKey' | 'colorKey'>;
  const openSpaceId = useRef(space.id);
  openSpaceId.current = space.id;
  const presentationWrites = useRef<{ queue: Promise<void>; latest: Presentation | null }>({ queue: Promise.resolve(), latest: null });
  const writePresentation = (patch: Partial<Omit<Presentation, 'id'>>): Promise<void> => {
    const writes = presentationWrites.current;
    const base = writes.latest?.id === space.id
      ? writes.latest
      : { id: space.id, name: space.name, iconKey: space.iconKey, colorKey: space.colorKey };
    const next = { ...base, ...patch };
    writes.latest = next;
    const { id, ...presentation } = next;
    const write = writes.queue.then(async () => {
      stored(await api!.updateSpacePresentation(id, presentation));
    }).finally(() => { if (writes.latest === next) writes.latest = null; });
    writes.queue = write.catch(() => undefined);
    return write;
  };
  const changeAppearance = (patch: WorkstreamAppearancePatch): Promise<void> => writePresentation({
    ...(patch.icon ? { iconKey: patch.icon } : {}),
    ...(patch.color ? { colorKey: patch.color } : {}),
  });
  const copyLink = session?.workspace ? (): void => {
    const target = session.workspace!;
    const copied = space.id;
    void copySpaceLink({ region: target.region, workspaceId: target.id }, copied)
      // Not on the next Channel's screen, if the person moved on meanwhile.
      .catch(() => { if (openSpaceId.current === copied) setFailure('This channel’s link couldn’t be copied.'); });
  } : undefined;
  // An import starts a thread in this Channel, so it sits on the Channel's
  // header and is locked to it. Only the Mac app has the embedded browser the
  // import runs in, and only someone who may start a thread here sees it.
  const openBrowserImport = typeof window === 'undefined' ? undefined : window.rally?.openBrowserImport;
  const importButton = editable && openBrowserImport ? <TitlePillAction
    label="Import from Claude or ChatGPT"
    onClick={() => void openBrowserImport({ spaces: [{ id: space.id, name: space.name }], spaceLocked: true })}
  >
    <IconCloudDownload aria-hidden="true" size={16} stroke={1.9} />
  </TitlePillAction> : undefined;
  const pinned = pinnedChannels.has(space.id);
  const recommended = new Set(space.defaultSidekickIds);
  const sidekicks: SidekickRow[] | undefined = library.data
    ?.filter((sidekick) => recommended.has(sidekick.id))
    .map((sidekick) => ({
      id: sidekick.id,
      name: sidekick.name,
      description: sidekick.description,
      ...(sidekick.appearance ? { appearance: sidekick.appearance } : {}),
      ...(editable ? { removeLabel: 'Remove from this channel', onRemove: () => void run(() => api!.removeSpaceSidekick(space.id, sidekick.id), 'That Sidekick couldn’t be removed.') } : {}),
    }));
  const addable = (library.data ?? []).filter((sidekick) => !recommended.has(sidekick.id));
  const level: TitlePillLevel = {
    key: `channel-container:${space.id}`,
    icon: <ChannelGlyph space={space} />,
    ...(editable && api ? {
      iconAction: <AppearancePicker
        appearance={{ icon: space.iconKey, color: space.colorKey }}
        id={space.id}
        key={space.id}
        label={`Change ${space.name} icon and color`}
        onChange={changeAppearance}
        renderGlyph={(appearance) => <ChannelGlyph
          space={{ iconKey: appearance.icon ?? space.iconKey, colorKey: appearance.color ?? space.colorKey }}
        />}
      />,
    } : {}),
    title: space.name,
    label: `Channel menu: ${space.name}`,
    onMenuOpen: editable && !personal ? peopleRanking.onOpen : undefined,
    menu: <ChannelContainerMenu
      addSidekick={editable && addable.length > 0 ? <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="menu-item title-menu-item">
          <IconPlus aria-hidden="true" size={16} stroke={1.8} /> Add Sidekick
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent className="menu-content" sideOffset={6}>
            {addable.map((sidekick) => <TitleMenuItem
              icon={null}
              key={sidekick.id}
              onSelect={() => void run(() => api!.addSpaceSidekick(space.id, sidekick.id), 'That Sidekick couldn’t be added.')}
            >{sidekick.name}</TitleMenuItem>)}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub> : undefined}
      appearance={editable && api ? <AppearanceSubmenu
        appearance={{ icon: space.iconKey, color: space.colorKey }}
        icon={<IconPalette aria-hidden="true" size={16} stroke={1.8} />}
        id={space.id}
        key={space.id}
        label="Icon"
        onChange={changeAppearance}
      /> : undefined}
      channel={{ name: space.name, scope: audienceScope }}
      members={roster}
      memory={api ? { ...memory, onOpenSource: (source) => openMemorySource(source, (to) => void navigate(to)) } : undefined}
      onArchive={editable && !general && !personal ? () => setArchiving('confirm') : undefined}
      onCopyLink={copyLink}
      onOpenSidekick={(id) => void desktopBridge().openSidekicks(id)}
      onRename={editable ? () => setRenaming(space.name) : undefined}
      people={editable && !personal ? {
        ...peopleRanking,
        candidates: members.filter((candidate) => !participantIds.includes(candidate.id) && (candidate.status ?? 'active') === 'active'),
        adding,
        currentUserId: workspace.currentUser.id,
        ...(failure ? { error: failure } : {}),
        onAdd: async (person) => {
          setAdding(true);
          try { await setAudience(audienceScope, [...participantIds, person.id]); } finally { setAdding(false); }
        },
        onRemove: (person) => setRemoving({ member: person, pending: false }),
      } : undefined}
      pinned={api ? {
        on: pinned,
        onChange: (next) => pin('channel', space.id, next),
      } : undefined}
      publicToOrganization={editable && !general && !personal ? {
        on: space.scope === 'workspace',
        // A private Channel nobody is in is one nobody can open; the person
        // making it private stays in it. Leaving it afterwards is theirs to do.
        onChange: (next) => void setAudience(
          next ? 'workspace' : 'personal',
          next ? participantIds : [...new Set([...participantIds, workspace.currentUser.id])],
        ),
      } : undefined}
      sidekicks={sidekicks}
    />,
  };
  return <>
    <div className="channel-header">
      <TitlePillHeader current={level} trailing={importButton} />
    </div>
    {failure && <ErrorNotice>{failure}</ErrorNotice>}
    <Modal
      footer={<>
        <Button onClick={() => setRenaming(null)}>Cancel</Button>
        <Button
          className="button-primary"
          disabled={!renaming?.trim() || renaming.trim() === space.name}
          onClick={() => {
            const name = renaming?.trim() ?? '';
            setRenaming(null);
            setFailure(null);
            void writePresentation({ name }).catch(() => setFailure('This channel couldn’t be renamed.'));
          }}
        >Rename</Button>
      </>}
      onOpenChange={(open) => { if (!open) setRenaming(null); }}
      open={renaming !== null}
      title="Rename channel"
    >
      <label className="form-field">
        <span>Name</span>
        <input autoFocus maxLength={180} onChange={(event) => setRenaming(event.target.value)} value={renaming ?? ''} />
      </label>
    </Modal>
    <Modal
      footer={<>
        <Button disabled={archiving === 'saving'} onClick={() => setArchiving(null)}>Cancel</Button>
        <Button className="button-danger" disabled={archiving === 'saving'} onClick={() => void archive()}>Archive</Button>
      </>}
      onOpenChange={(open) => { if (!open && archiving !== 'saving') setArchiving(null); }}
      open={archiving !== null}
      title={`Archive ${space.name}?`}
    >
      <p className="modal-copy">
        It leaves the Channels list for everyone. Threads that belong only to this channel
        and their owned Sidekicks are archived too. Threads in other channels stay active.
        Restoring the channel does not restore its Threads or Sidekicks. You can restore this channel
        from <strong>Archived</strong> at the bottom of the Channels list.
      </p>
    </Modal>
    <RemoveParticipantDialog
      failure={removing?.failure}
      member={removing?.member}
      noun="channel"
      onCancel={() => setRemoving(null)}
      onContinue={() => { if (removing) void remove(removing.member); }}
      pending={removing?.pending ?? false}
      self={removing?.member.id === workspace.currentUser.id}
    />
  </>;
}

