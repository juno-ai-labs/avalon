import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ChannelStats, ChannelStatsList, SpaceSummary, WorkstreamAppearancePatch } from '@rally/contracts';
import { AppearancePicker, AppearanceSubmenu } from '@rally/ui/components/appearance-picker';
import { breakoutNewsLabel, type BreakoutMark } from '@rally/ui/components/breakout-marks';
import { ChannelContainerMenu } from '@rally/ui/components/conversation-menus';
import type { SidekickRow } from '@rally/ui/components/sidekick-section';
import { ChannelGlyph, spaceMark } from '@rally/ui/components/space-icon';
import { SplitConversationLayout, type SplitConversationMode } from '@rally/ui/components/split-conversation';
import { TitleMenuItem, TitlePillAction, TitlePillHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { resolveWorkstreamAppearance } from '@rally/ui/components/workstream-glyph';
import { IconChevronRight, IconCloudDownload, IconPalette, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { ChannelComposer } from '../components/channel-composer';
import { MarkdownBody } from '../components/workstream-blocks';
import { Avatar, Button, EmptyState, InlineError, LoadingState, Modal, TitleSkeleton } from '../components/primitives';
import { RelativeTime } from '../components/relative-time';
import { reportActivityEvent } from '../lib/activity-events';
import { useAppSession } from '../lib/app-session';
import { layoutKey, readLayout, writeLayout } from '../lib/desktop-layout';
import { copySpaceLink } from '../lib/copy-workstream-link';
import { ChannelPaneContextValue, channelRoute, threadRoute, usePaneExpansion, type ChannelPaneContext } from '../lib/navigation-routes';
import { PaneVisibility } from '../lib/pane-visibility';
import { useNow } from '../lib/clock';
import { formatDayLabel } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import { CHANNEL_STATS_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, SPACES_QUERY_KEY, channelFeedQueryKey } from '../lib/sidebar-list-store';
import { usePinAction, usePinnedIds } from '../lib/pins';
import { spaceFailureSentence } from '../lib/space-failure-copy';
import { WORKSTREAM_LANDING_ROUTE } from '../lib/workstream-landing';
import { typedMentionRendering } from '../lib/transcript';
import { EmailMentionContext, emailMentionDirectory, NO_INVITEES, useWorkspaceInvitees } from '../lib/workspace-invitees';
import type { AutomationSummary, Workspace, WorkspaceMember, WorkstreamSummary } from '../lib/types';
import { useSpaceDirectories } from '../lib/use-space-directories';
import { useVisibleReadAcknowledgement } from '../lib/use-visible-read-acknowledgement';
import { useWorkstreamsQuery } from '../lib/use-workstreams-query';
import { RemoveParticipantDialog } from './conversation-surface';
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
  const threadId = /^threads\/([^/]+)$/.exec(rest)?.[1] ?? null;
  return <ChannelStack channelId={channelId} threadId={threadId} workspace={workspace} />;
}

/**
 * A Channel, and one of its threads open beside it: the first two panes of
 * the stack. The thread pane is the ordinary thread screen; when it opens a
 * breakout or a panel it needs both panes, and the Channel steps off screen to
 * ride as the first breadcrumb (`docs/pane-stack.md`). The same two-slot layout
 * a thread uses for its breakout, one level up, so both panes stay mounted —
 * the Channel's composer and scroll survive a thread opening and closing.
 */
function ChannelStack({ channelId, threadId, workspace }: {
  channelId: string;
  threadId: string | null;
  workspace: Workspace;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { session } = useAppSession();
  const space = useChannel(channelId);
  const [threadUsesTwoPanes, setThreadUsesTwoPanes] = useState(false);
  const { expanded, setExpanded } = usePaneExpansion(threadId);
  // A breakout or a panel ends the expansion: the thread and what it opened
  // split the window as they would have, and closing it returns to the pair.
  const reportThreadUsesTwoPanes = useCallback((twoPanes: boolean): void => {
    setThreadUsesTwoPanes(twoPanes);
    if (twoPanes) setExpanded(false);
  }, [setExpanded]);
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
    setThreadUsesTwoPanes: reportThreadUsesTwoPanes,
    expanded,
    setExpanded,
  }), [channelId, expanded, navigate, reportThreadUsesTwoPanes, setExpanded, shifted, space, threadId]);
  return <ChannelPaneContextValue.Provider value={pane}>
    <SplitConversationLayout
      breakout={threadId === null ? null : <WorkstreamRoute key={threadId} />}
      breakoutWidth={threadWidth}
      main={<PaneVisibility visible={shown !== 'breakout'}>
        <ChannelPane channelId={channelId} openThreadId={threadId} workspace={workspace} />
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

type FeedRow = { placedAt: string; thread: WorkstreamSummary };

/**
 * What to acknowledge for a Channel the reader has open, or null when there is
 * nothing to send: the newest loaded placement, when it is past the cached
 * read position. The feed is read top to bottom down to now, so the newest
 * placement is on screen when the Channel opens; there is no per-row
 * visibility tracking, deliberately.
 */
export function channelReadAcknowledgement(
  newestLoadedSequence: number,
  stats: Pick<ChannelStats, 'readThroughSequenceNumber'>,
): { readThroughSequenceNumber: number } | null {
  if (newestLoadedSequence === 0 || newestLoadedSequence <= stats.readThroughSequenceNumber) return null;
  return { readThroughSequenceNumber: newestLoadedSequence };
}

/** Replace one Channel's row in the channel-stats cache. */
function writeChannelStats(list: ChannelStatsList | undefined, channelId: string, write: (row: ChannelStats) => ChannelStats): ChannelStatsList | undefined {
  return list?.map((row) => row.channelId === channelId ? write(row) : row);
}

function ChannelPane({ channelId, openThreadId, workspace }: {
  channelId: string;
  openThreadId: string | null;
  workspace: Workspace;
}): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
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
    const known = new Set(fetched.map((item) => item.thread.id));
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
      .map((thread): FeedRow => ({ placedAt: thread.createdAt ?? new Date().toISOString(), thread }));
    return [...started, ...fetched.map((item): FeedRow => ({ ...item, thread: liveById.get(item.thread.id) ?? item.thread }))];
  }, [channelId, feed.data, feed.isSuccess, live.data, liveById]);
  const queryClient = useQueryClient();
  // The Channel is read while it is open in a focused, visible window: the
  // same gate a conversation's read acknowledgement uses. One request per
  // position in flight; a failure leaves the sidebar dot standing and is not
  // retried, so an unread Channel that will not clear is what gets noticed.
  // The first page carries the Channel's latest number as it was read, which
  // covers a newest placement since removed or archived: nothing listed shows
  // it, and acknowledging only what is listed would leave the dot standing.
  const newestLoadedSequence = useMemo(() => Math.max(0, ...(feed.data?.pages ?? [])
    .flatMap((page) => [
      ...page.items.map((item) => item.attentionSequenceNumber),
      page.latestAttentionSequenceNumber ?? 0,
    ])), [feed.data]);
  // Subscribed rather than read once, so stats arriving after the feed (or a
  // mark made elsewhere) schedules the acknowledgement again. The sidebar owns
  // fetching this list; this pane only reads it.
  const channelStats = useQuery<ChannelStatsList>({
    queryKey: CHANNEL_STATS_QUERY_KEY,
    queryFn: ({ signal }) => api!.getChannelStats(signal),
    enabled: false,
  });
  const stats = channelStats.data?.find((row) => row.channelId === channelId);
  const ackInFlight = useRef<string | null>(null);
  const activityReportedRef = useRef<{ channelId: string; through: number } | null>(null);
  // The pane stays mounted from one Channel to the next; coming back to one
  // whose acknowledgement failed is opening it again, and may send again.
  useEffect(() => { ackInFlight.current = null; }, [channelId]);
  const acknowledgeRead = useCallback((): void => {
    if (!api || !stats || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    // Activity is told what is on screen whether or not the Channel's own read
    // position needs moving, once per Channel and again when it rises.
    const reported = activityReportedRef.current;
    if (newestLoadedSequence > 0 && (reported?.channelId !== channelId || newestLoadedSequence > reported.through)) {
      activityReportedRef.current = { channelId, through: newestLoadedSequence };
      reportActivityEvent(api, queryClient, {
        kind: 'read',
        subject: { kind: 'channel', channelId },
        through: newestLoadedSequence,
      });
    }
    const pending = channelReadAcknowledgement(newestLoadedSequence, stats);
    if (!pending) return;
    const key = `${channelId}:${pending.readThroughSequenceNumber}`;
    if (ackInFlight.current === key) return;
    ackInFlight.current = key;
    const previous = stats;
    queryClient.setQueryData<ChannelStatsList>(CHANNEL_STATS_QUERY_KEY, (list) =>
      writeChannelStats(list, channelId, (row) => ({ ...row, hasUnread: false })));
    void api.acknowledgeChannelRead(channelId, pending.readThroughSequenceNumber)
      .then((updated) => {
        queryClient.setQueryData<ChannelStatsList>(CHANNEL_STATS_QUERY_KEY, (list) =>
          writeChannelStats(list, channelId, () => updated));
      })
      .catch(() => {
        // Put the dot back: the server did not record the read.
        queryClient.setQueryData<ChannelStatsList>(CHANNEL_STATS_QUERY_KEY, (list) =>
          writeChannelStats(list, channelId, (row) => ({ ...row, hasUnread: previous.hasUnread })));
      });
  }, [api, channelId, newestLoadedSequence, queryClient, stats]);
  useVisibleReadAcknowledgement(acknowledgeRead);
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    // The member directory is a member's; a guest's feed names authors as Rally.
    enabled: Boolean(api) && workspace.currentUser.accessClass !== 'guest',
    staleTime: 60_000,
  });
  const memberById = useMemo(() => new Map((members.data ?? []).map((member) => [member.id, member])), [members.data]);
  // A summary's typed `@address` resolves against the directory the composer
  // below already reads, so it chips as it does in the thread.
  const invitees = useWorkspaceInvitees(api, workspace.currentUser.accessClass !== 'guest');
  const emailMentions = useMemo(
    () => emailMentionDirectory(members.data ?? NO_MEMBERS, invitees.data ?? NO_INVITEES),
    [invitees.data, members.data],
  );
  // The feed reads down to now, so it opens at its newest row, beside the
  // composer, and stays there as threads arrive, unless the reader has
  // scrolled up to read something older. Loading an earlier page keeps the
  // rows they were looking at where they were.
  const feedScroll = useRef<HTMLDivElement>(null);
  const atNewest = useRef(true);
  const anchoredChannel = useRef<string | null>(null);
  const previousHeight = useRef(0);
  const earlierPages = feed.data?.pages.length ?? 0;
  const previousPages = useRef(earlierPages);
  useLayoutEffect(() => {
    const element = feedScroll.current;
    if (!element) return;
    const loadedEarlier = earlierPages > previousPages.current;
    previousPages.current = earlierPages;
    if (anchoredChannel.current !== channelId) {
      if (rows.length === 0) return;
      anchoredChannel.current = channelId;
      element.scrollTop = element.scrollHeight;
    } else if (loadedEarlier) {
      element.scrollTop += element.scrollHeight - previousHeight.current;
    } else if (atNewest.current) {
      element.scrollTop = element.scrollHeight;
    }
    previousHeight.current = element.scrollHeight;
    // `space` too: the feed element first mounts when the Channel list arrives,
    // which may be after the rows were already in hand.
  }, [channelId, earlierPages, rows, space]);

  if (active.data === undefined) return <LoadingState label="Opening channel…" />;
  if (!space) return <EmptyState description="It may have been archived, made private, or you may no longer have access." title="Channel not found" />;
  const openThread = (threadId: string): void => void navigate(threadRoute(threadId, channelId));
  // Only a member may start a thread in a private Channel; a thread placed
  // there is the Channel's to accept (`canEdit` on the server).
  const canStart = workspace.currentUser.accessClass !== 'guest' && space.reach !== 'through_channel';
  return <div className="channel-screen">
    {/* Keyed so a confirmation still open when the route changes (a leave,
        a removal, an archive) cannot be continued against the next Channel. */}
    <ChannelHeader key={space.id} members={members.data ?? []} space={space} workspace={workspace} />
    <div
      className="channel-feed transcript-scroll"
      onScroll={(event) => {
        const element = event.currentTarget;
        atNewest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      ref={feedScroll}
    >
      {/* Newest nearest the composer: the list reads down to now. */}
      <EmailMentionContext.Provider value={emailMentions}><ol aria-label={`Threads in ${space.name}`} className="channel-feed-list">
        {feed.hasNextPage && <li className="channel-feed-more">
          <Button disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>Show earlier threads</Button>
        </li>}
        {[...rows].reverse().flatMap((row, index, ordered) => {
          // Grouped by the local calendar date, year and all; the label is
          // only for display, and two years' "Oct 2" are different days.
          const day = new Date(row.placedAt).toDateString();
          const card = <ThreadCard
            author={row.thread.createdByUserId ? memberById.get(row.thread.createdByUserId) : undefined}
            key={row.thread.id}
            members={members.data ?? NO_MEMBERS}
            onOpen={openThread}
            open={row.thread.id === openThreadId}
            placedAt={row.placedAt}
            thread={row.thread}
          />;
          const previous = ordered[index - 1];
          if (previous && new Date(previous.placedAt).toDateString() === day) return [card];
          return [<DaySeparator key={`day:${row.thread.id}`} placedAt={row.placedAt} />, card];
        })}
      </ol></EmailMentionContext.Provider>
      {feed.isSuccess && rows.length === 0 && <p className="channel-feed-empty">No threads yet. Describe the work below and Rally starts a thread for it.</p>}
      {feed.isError && <InlineError>The threads in this channel couldn’t be loaded.</InlineError>}
    </div>
    {canStart && <ChannelComposer channelId={channelId} channelName={space.name} channelScope={space.scope} threadOpen={openThreadId !== null} workspace={workspace} />}
  </div>;
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
function ThreadCard({ author, members, onOpen, open, placedAt, thread }: {
  author: WorkspaceMember | undefined;
  members: readonly WorkspaceMember[];
  onOpen: (threadId: string) => void;
  open: boolean;
  placedAt: string;
  thread: WorkstreamSummary;
}): React.JSX.Element {
  // The title says what the thread's own title pill says at every moment: a
  // skeleton while Rally names it, never the request's first line, and no
  // "new" on the thread the reader has open beside it, which they are reading
  // as it arrives.
  const mark: BreakoutMark = {
    substreamId: thread.id,
    title: thread.title,
    naming: thread.pending === true || thread.titleStatus === 'naming',
    unreadCount: open || !thread.hasUnread ? 0 : 1,
    youAreMentioned: !open && thread.youAreMentioned,
    unseen: !open && thread.unseen,
    needsInput: thread.harnessStatus === 'needs_input',
  };
  const news = breakoutNewsLabel(mark);
  const { Icon, tint, ink } = resolveWorkstreamAppearance(thread.id, thread.appearance);
  // Rally starts a thread only when nobody did; a person this reader cannot
  // look up (a guest has no member list, and a member's loads after the feed)
  // is somebody, not Rally.
  const byline = author?.name ?? (thread.createdByUserId ? 'Someone' : 'Rally');
  // The summary is the opening message's text without its mentions, so the
  // names in it are found again the way the send path found them, and drawn
  // by the renderer the message itself uses.
  const summary = useMemo(() => typedMentionRendering(thread.objective ?? '', members), [members, thread.objective]);
  return <li className="channel-feed-item">
    <button
      aria-label={[mark.naming ? 'Rally is choosing a name' : thread.title, news, open && 'Open'].filter(Boolean).join(', ')}
      aria-pressed={open}
      className={clsx('channel-feed-thread', open && 'is-open')}
      onClick={() => onOpen(thread.id)}
      type="button"
    >
      <span className="channel-feed-body">
        <span className="channel-feed-title">
          {news && (mark.needsInput
            ? <span className="breakout-chip-badge">{news}</span>
            : <span className="channel-feed-news">{news}</span>)}
          <span className="channel-feed-title-text">{mark.naming ? <TitleSkeleton className="breakout-chip-skeleton" /> : thread.title}</span>
          <IconChevronRight aria-hidden="true" className="channel-feed-caret" size={13} stroke={2} />
        </span>
        {thread.objective && <span className="channel-feed-summary">
          <MarkdownBody glance mentions={summary.mentions} preserveLineBreaks rallyMentions verbatim>{summary.text}</MarkdownBody>
        </span>}
        <span className="channel-feed-meta">
          {author && <Avatar member={author} size="small" title={null} />}
          <span>{byline}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime value={placedAt} />
        </span>
      </span>
      <span aria-hidden="true" className="channel-feed-mark" style={{ background: tint, color: ink }}>
        <Icon size={19} strokeWidth={1.8} />
      </span>
    </button>
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
  const member = workspace.currentUser.accessClass !== 'guest';
  const editable = member && space.reach !== 'through_channel';
  const general = space.systemRole === 'general';
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
        scope: space.scope,
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
  const sidekicks: SidekickRow[] = (library.data ?? [])
    .filter((sidekick) => recommended.has(sidekick.id))
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
      channel={{ name: space.name, scope: space.scope }}
      members={roster}
      onArchive={editable && !general ? () => setArchiving('confirm') : undefined}
      onCopyLink={copyLink}
      onOpenSidekick={(id) => void desktopBridge().openSidekicks(id)}
      onRename={editable ? () => setRenaming(space.name) : undefined}
      people={editable ? {
        candidates: members.filter((candidate) => !participantIds.includes(candidate.id) && (candidate.status ?? 'active') === 'active'),
        adding,
        currentUserId: workspace.currentUser.id,
        ...(failure ? { error: failure } : {}),
        onAdd: async (person) => {
          setAdding(true);
          try { await setAudience(space.scope, [...participantIds, person.id]); } finally { setAdding(false); }
        },
        onRemove: (person) => setRemoving({ member: person, pending: false }),
      } : undefined}
      pinned={api ? {
        on: pinned,
        onChange: (next) => pin('channel', space.id, next),
      } : undefined}
      publicToOrganization={editable && !general ? {
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
    {failure && <InlineError>{failure}</InlineError>}
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
        It leaves the Channels list for everyone. Its threads keep going, and any that live only
        here move to General. You can restore it from <strong>Archived</strong> at the bottom of
        the Channels list.
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

