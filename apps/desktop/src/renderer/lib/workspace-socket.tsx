import { WorkspaceConversationViewEventSchema, type WorkspaceConversationViewEvent } from '@rally/contracts/conversation-view';
import { MERGE_CHANNELS_QUERY_KEY } from './use-merge-channels';
import {
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceSpaceConversationsEventSchema,
  WorkspaceSpaceSnapshotEventSchema,
  WorkspaceNavigationStateEventSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceWorkstreamRecencyEventSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspacePresenceEventSchema,
  WorkspaceReachChangedEventSchema,
  WorkspaceResourceVersionsEventSchema,
  WorkspaceAccessRequestsEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceChannelRailsEventSchema,
  WorkspaceSpaceChannelsEventSchema,
  WorkspaceSocketClientEventSchema,
  CHANNEL_RAILS_NAMED_LIMIT,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  WorkstreamIdSchema,
  type Region,
  type WorkstreamId,
  type SpaceDirectory,
  type WorkspaceSidebar,
  type WorkspaceSocketClientEvent,
  type WorkspaceSyncTopic,
  type WorkspaceWorkstreamPageEvent,
  type WorkspaceSpaceChannelsEvent,
  safeParseSocketEvent,
} from "@rally/contracts";
import type { TelemetryEventProperties } from '@rally/contracts/telemetry';
import { WorkspaceUsageEventSchema } from '@rally/contracts/usage';
import {
  WORKSPACE_SOCKET_HEARTBEAT_MS,
  WORKSPACE_SOCKET_OPEN_TIMEOUT_MS,
  WORKSPACE_SOCKET_PONG_TIMEOUT_MS,
  workspaceSocketReconnectDelay,
} from '@rally/contracts/workspace-reach-watch';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { ApiError, mapAutomationSummary, mapWorkstreamSummary, type RallyApi } from './api';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import { applyChannelViewerState } from './channel-viewer-state';
import { applyChannelRails, hasRailWaterline, holdsChannelRail, nextChannelRailRequest, settleUnanswered } from './channel-rails';
import { retainConversationParents } from './conversation-cache';
import { useLocalCacheScope } from './local-cache-scope';
import { applyPushedOrganizationUsage, organizationUsageQueryKey } from './organization-usage';
import { desktopBridge } from './platform';
import {
  SPACES_QUERY_KEY,
  INACTIVE_SPACES_QUERY_KEY,
  SPACES_READY_QUERY_KEY,
  PERSONAL_ORDER_QUERY_KEY,
  PINNED_ORDER_QUERY_KEY,
  SIDEBAR_LIST_QUERY_KEYS,
  applyNavigationState,
  applyVersionedSpaceSnapshot,
  CHANNEL_FEEDS_QUERY_KEY,
  applyVersionedSidebarList,
  CHANNEL_STATS_QUERY_KEY,
  MY_THREADS_QUERY_KEY,
  ACTIVITY_QUERY_KEY,
  channelFeedQueryKey,
} from './sidebar-list-store';
import { applyResourceHeads, followResourceHeads } from './resource-heads';
import { realtimeSocketTelemetry } from './socket-telemetry';
import { reportTelemetryProductIntent, telemetryJourneyDuration, uuidV7 } from './telemetry';
import type { WorkstreamSummary } from './types';
import { CLIENT_FEATURE_FLAGS_QUERY_KEY } from './use-client-feature-flags';
import { memberPreferencesQueryKey } from './use-member-preferences';
import { accessRequestsQueryKey } from './access-requests';
import { hydrateWorkspaceDirectory, mirrorWorkspaceDirectory } from './workspace-directory-cache';
import {
  applyVersionedWorkstreamState,
  applyWorkspaceWorkstreamFields,
  workstreamSummaryState,
  WORKSTREAM_STATE_WATERLINES_KEY,
  WORKSPACE_DIRECTORY_WATERLINES_KEY,
} from './workstream-state-store';
import { mergeCachedWorkstreamPage, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import { retainQueryData } from './retain-query-data';
import { isSocketTicketRequestTimeoutError } from './socket-ticket-request';
import { logWarn } from '../../common/logger';
import {
  sameWorkspaceSyncIdentity,
  type WorkspaceSyncConnectionState,
  type WorkspaceSyncPublication,
  type WorkspaceSyncRelayTopic,
  type WorkspaceSyncSourceSnapshot,
} from '../../common/workspace-sync-relay';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';
import type { z } from 'zod';

/**
 * Say, by name, that a socket message this build understands the *type* of was
 * dropped because its body did not parse.
 *
 * `safeParseSocketEvent` tolerates fields a newer sender added and nothing
 * else, so a field a newer sender made *required* fails every receiver that
 * predates it — and the handler's schema chain ends in a `return` either way.
 * That silence is the defect: the first required field added to the Space
 * snapshot would take every Space off the sidebar of a desktop running ahead
 * of its API, with nothing in the log naming the field.
 *
 * The `type` the caller pairs with each attempt is what tells a schema that
 * was never the right one to try from one that matched the event and rejected
 * its body — read off the message rather than inferred from the failure,
 * because two of these schemas are discriminated unions whose own failure
 * lands on a second discriminator instead. A type nothing here claims stays
 * silent: that is the ordinary forward-compatible case.
 */
function reportSocketContractSkew(
  eventType: unknown,
  attempts: readonly (readonly [string, string, { success: boolean; error?: z.ZodError }])[],
): void {
  for (const [type, name, attempt] of attempts) {
    if (type !== eventType || attempt.success || !attempt.error) continue;
    // `namesUnknownKeys`, because the sender is our own API and an added key
    // it could not strip is the whole diagnosis of a version skew — the case
    // that option exists to keep away from a *provider's* response.
    logWarn('rally', `dropped a ${name} event this build cannot read: `
      + describeZodIssues(attempt.error, { namesUnknownKeys: true }));
    return;
  }
}

type ListWorkstreamsCommand = Extract<WorkspaceSocketClientEvent, { type: 'list_workstreams' }>;

interface PendingRailRequest {
  resolve: (named: Set<string>) => void;
  reject: (error: Error) => void;
  timeout: number;
  /** Every Channel a frame of the answer named, in any of its three lists. */
  named: Set<string>;
}

interface PendingSpaceRequest {
  resolve: (answer: WorkspaceSpaceChannelsEvent) => void;
  reject: (error: Error) => void;
  timeout: number;
}
type WorkspaceSocketApi = Pick<RallyApi, 'getWorkspaceSocketTicket'> & Partial<Pick<RallyApi, 'confirmSocketTicket'>>;
export type WorkspaceSocketState = WorkspaceSyncConnectionState;

/**
 * How a window takes part in the Organization-sync relay.
 *
 * - `publish`: the main window. It holds the socket and tells main what it
 *   hears — its connection state and each topic change — and detaches when
 *   it unmounts with no successor.
 * - `consume`: the Settings and Sidekicks windows. Each holds no socket while main reports any
 *   publisher, and applies what is relayed for its own Organization through
 *   the same receivers a socket would. With no publisher (the main window
 *   closed, crashed, reloading or fallen into the error boundary) it dials its
 *   own, and puts it down again once one is back.
 * - absent: a window with a socket of its own that relays nothing (browser
 *   import), or a test.
 */
export type WorkspaceSyncRelayRole = 'publish' | 'consume';

function publishToMain(publication: WorkspaceSyncPublication): void {
  void desktopBridge().publishWorkspaceSync(publication).catch((error: unknown) => {
    logWarn('rally', 'could not relay organization sync to main', error);
  });
}

/**
 * The publishing provider currently mounted in this renderer. An Organization
 * switch, and StrictMode, unmount a publisher and mount its successor in one
 * pass; the successor claims this before the predecessor's deferred detach
 * runs, so only a publisher nobody replaced detaches.
 */
let mountedRelayPublisher: object | null = null;

/** One page of the work-stream directory, as every caller here receives it. */
export interface WorkstreamPage {
  items: WorkstreamSummary[];
  nextCursor: string | null;
}

/**
 * What the last connect payload established, for the surfaces that page beyond
 * it.
 *
 * `generation` counts payloads rather than identifying one: a paging hook needs
 * to know that a *new* sidebar arrived, not which. `nextCursor` is the
 * directory's position after the page the payload carried.
 */
export interface SidebarConnect {
  generation: number;
  nextCursor: string | null;
  /** This connection has delivered Space authority, not only the compatible sidebar fields. */
  spacesLive: boolean;
  /**
   * The payload carried no Channel rows: the directory is loaded by walking
   * the Spaces (`walkSpaceChannels`), not by paging `list_workstreams`.
   */
  channelsBySpace?: boolean;
}

/**
 * A correlated directory page awaiting its answer.
 *
 * Only pages are requested now — the sidebar's first screen arrives unasked on
 * subscribe. What is left is what a person's own action asked for: scrolling
 * past the first page, and turning Debug enabled on to widen the list.
 */
interface PendingDirectoryRequest {
  command: ListWorkstreamsCommand;
  resolve: (page: WorkstreamPage) => void;
  reject: (error: Error) => void;
  timeout: number;
}

interface WorkspaceSocketContextValue {
  requestConversationView(parentId: string, substreamId: string,
    receive: (event: WorkspaceConversationViewEvent) => void): () => void;
  state: WorkspaceSocketState;
  topicWaterlines: Readonly<Partial<Record<WorkspaceSyncTopic, number>>>;
  presenceUserIdsByWorkstream: Readonly<Record<string, readonly string[]>>;
  setForegroundWorkstreamId(workstreamId: string | null): void;
  listWorkstreams(input: {
    limit: number;
    before?: string;
    includeSystem: boolean;
  }): Promise<WorkstreamPage>;
  /** The last sidebar the server sent unasked, or null before the first one. */
  sidebarConnect: SidebarConnect | null;
  /**
   * Ask every Space for its Channel rows, and their rails, a page at a time,
   * writing each page into the directory as it lands. The Space given to
   * `prioritizeSpace` (else the Channel in front's) is asked alone; once its
   * first page is in, every other Space is asked at once.
   *
   * Resolves with every Channel id the walk returned, or `null` when this
   * connection's sidebar carried Channel rows and there is nothing to walk.
   * Rejects once `signal` aborts, before asking for another page.
   */
  walkSpaceChannels(signal?: AbortSignal): Promise<Set<string> | null>;
  /**
   * The Space on screen: walked first, ahead of the rest. One that no walk
   * has returned or is walking, such as a Space created since, is asked for
   * now on its own.
   */
  prioritizeSpace(spaceId: string | null): void;
  /** The Spaces a walk has returned whole. A Space missing here may still be loading. */
  loadedSpaceIds: ReadonlySet<string>;
  /**
   * Ask again for these Channels' rails now, whatever the rows say: after a
   * change this window made, before the row that reports it arrives. Rejects
   * while the organization is not connected.
   */
  refreshChannelRails(workstreamIds: readonly string[]): Promise<void>;
}

const WorkspaceSocketContext = createContext<WorkspaceSocketContextValue | null>(null);
const COMMAND_TIMEOUT_MS = 120_000;


function invalidateTopic(
  queryClient: ReturnType<typeof useQueryClient>,
  topic: WorkspaceSyncTopic,
): void {
  const roots: Record<WorkspaceSyncTopic, readonly (readonly unknown[])[]> = {
    workspace_profile: [['workspace'], ['workspace-onboarding'], ['account-onboarding'], ['onboarding-journey']],
    member_directory: [['workspace-members'], ['workspace-onboarding']],
    invitation_directory: [['workspace-invitations']],
    connector_connections: [
      ['connections'],
      ['connector-installation'],
      ['connector-catalog'],
      ['github-repository-access'],
      ['workspace-onboarding'],
    ],
    connector_oauth_attempts: [],
    terminal_policy: [['terminal-workspace-settings']],
    digest_schedule: [['digest-schedule']],
    // The lists themselves are pushed whole by WorkspaceDO, so the topic no
    // longer names them — it carries REST details and the broader Sidekick library.
    automations: [
      ['automation'], ['automation-draft'], ['automation-runs'], ['sidekicks-library'],
      // The workstream's owned and recommended Sidekicks, plus what its
      // conversation loaded. A room's row never travels in the
      // pushed sidebar list, so this topic is what tells its rails to re-read.
      ['attached-sidekicks'], ['workstream-sidekicks'], ['recommended-sidekicks'], ['sidekick-activity'],
    ],
    sidekick_activity: [['sidekick-activity']],
    notes: [['note']],
    // Projects are gone and Spaces replaced them; Space state is carried by the
    // connect snapshot and every later `workspace_space_snapshot`. This topic
    // survives in the contract's closed enum and can still arrive from a server
    // mid-deployment, but it must never turn the socket into news followed by a
    // REST read.
    projects: [],
    resources: [['resources'], ['workstream-context']],
    // A mention or a finished run is a new row in the Activity tab too.
    activity: [['work-opportunities'], ACTIVITY_QUERY_KEY],
    work_opportunities: [['work-opportunities']],
    workstream_directory: [WORKSTREAMS_QUERY_KEY],
    viewer_preferences: [['telemetry-preference'], ['member-preferences']],
    feature_flags: [['feature-flags']],
  };
  for (const queryKey of roots[topic]) void queryClient.invalidateQueries({ queryKey });
}

/** Merge one event's topics into the per-topic waterlines a surface observes. */
function withTopicWaterline(
  current: Partial<Record<WorkspaceSyncTopic, number>>,
  topics: readonly WorkspaceSyncTopic[],
  waterline: number,
): Partial<Record<WorkspaceSyncTopic, number>> {
  const next = { ...current };
  for (const topic of topics) next[topic] = Math.max(waterline, next[topic] ?? 0);
  return next;
}

/**
 * Write one directory page into the shared caches and return its rows.
 *
 * Shared by the paged answer and the sidebar batch, which carry the same page
 * body and must land in the ledger the same way: a row is only as fresh as its
 * own common/viewer waterline, so the cached copy wins whenever it is newer
 * than the page that just arrived. Returning the cached row rather than the
 * one off the wire is what keeps a page from walking back a state a later
 * `workspace_workstream_state` push already advanced.
 */
function applyDirectoryPage(
  queryClient: ReturnType<typeof useQueryClient>,
  page: Pick<WorkspaceWorkstreamPageEvent, 'items' | 'stateVersions' | 'directoryWaterline' | 'nextCursor'>,
  localCacheScope: string | null,
): WorkstreamPage {
  const versions = new Map(page.stateVersions.map((version) => [version.workstreamId, version]));
  const items = page.items.flatMap((row) => {
    const workstream = mapWorkstreamSummary(row);
    const version = versions.get(workstream.id);
    if (!version) return [workstream];
    const applied = applyVersionedWorkstreamState(queryClient, {
      workstreamId: workstream.id,
      stateVersion: version,
      ...workstreamSummaryState(workstream),
      visible: true,
    });
    // A page that lost the version comparison also loses the right to seed a
    // row after a newer tombstone removed it. Falling back to its wire value is
    // the archive disappear/reappear/disappear race.
    if (!applied.visible) return [];
    applyChannelViewerState(queryClient, row, version, localCacheScope);
    applyWorkspaceWorkstreamFields(queryClient, workstream.id, {
      pinPosition: workstream.pinPosition,
      spacePins: workstream.spacePins,
      lastAccessedAt: workstream.lastAccessedAt,
    }, page.directoryWaterline);
    return [queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
      ?.find((item) => item.id === workstream.id) ?? workstream];
  });
  return { items, nextCursor: page.nextCursor };
}

/** One persistent Electron connection to the current workspace's WorkspaceDO. */
export function WorkspaceSocketProvider({
  api,
  children,
  onAccessRevoked,
  region,
  relay,
  workspaceId,
}: PropsWithChildren<{
  api: WorkspaceSocketApi;
  onAccessRevoked?: () => void;
  /** With `workspaceId`, the Organization's identity: UUIDs are unique only within a region. */
  region: Region;
  relay?: WorkspaceSyncRelayRole;
  workspaceId: string;
}>): React.JSX.Element {
  const queryClient = useQueryClient();
  const localCacheScope = useLocalCacheScope();
  // Every conversation detail stays at the newest resource head this window
  // knows, whichever writer lands last.
  useEffect(() => followResourceHeads(queryClient), [queryClient]);
  const [state, setState] = useState<WorkspaceSocketState>('connecting');
  const [topicWaterlines, setTopicWaterlines] = useState<Partial<Record<WorkspaceSyncTopic, number>>>({});
  const [sidebarConnect, setSidebarConnect] = useState<SidebarConnect | null>(null);
  const [presenceUserIdsByWorkstream, setPresenceUserIdsByWorkstream] = useState<Record<string, readonly string[]>>({});
  // `null` until main has answered. A consumer dials nothing while it does not
  // know: the answer is one IPC round trip, and a socket opened in that gap
  // would be the second socket this exists to avoid.
  const [relaySnapshot, setRelaySnapshot] = useState<WorkspaceSyncSourceSnapshot | null>(null);
  // A publisher for another Organization is the main window mid-switch — the
  // two windows follow one session and apply it at different moments — so a
  // consumer waits for it rather than dialling for the gap. Only no publisher
  // at all means there is nobody to wait for.
  const ownSocket = relay !== 'consume' || relaySnapshot?.source === null;
  const relayedState = relaySnapshot?.source && sameWorkspaceSyncIdentity(relaySnapshot.source, { region, workspaceId })
    ? relaySnapshot.source.state
    : 'connecting';
  const conversationViewRequests = useRef(new Map<string, {
    parentId: string; substreamId: string; receive: (event: WorkspaceConversationViewEvent) => void; sentOn?: WebSocket;
  }>());
  const sendConversationViewRequestsRef = useRef<() => void>(() => undefined);
  const cancelRelayedConversationViewRef = useRef<(requestId: string) => void>(() => undefined);
  const completeRelayedConversationViewRef = useRef<(requestId: string) => void>(() => undefined);
  const requestConversationView = useCallback((parentId: string, substreamId: string,
    receive: (event: WorkspaceConversationViewEvent) => void): (() => void) => {
    const requestId = uuidV7();
    conversationViewRequests.current.set(requestId, { parentId, substreamId, receive });
    sendConversationViewRequestsRef.current();
    return () => {
      if (conversationViewRequests.current.delete(requestId)) cancelRelayedConversationViewRef.current(requestId);
    };
  }, []);
  const foregroundWorkstreamIdRef = useRef<WorkstreamId | null>(null);
  const reportPresenceRef = useRef<() => void>(() => undefined);
  const scheduleRailPrefetchRef = useRef<() => void>(() => undefined);
  const refreshChannelRailsRef = useRef<(workstreamIds: readonly string[]) => Promise<void>>(
    () => Promise.reject(new ApiError('The organization is not connected.', 409, 'workspace_socket_unavailable')),
  );
  const listWorkstreamsRef = useRef<WorkspaceSocketContextValue['listWorkstreams']>(
    () => Promise.reject(new ApiError(
      'The organization is not connected.',
      409,
      'workspace_socket_unavailable',
    )),
  );
  const walkSpaceChannelsRef = useRef<(signal?: AbortSignal) => Promise<Set<string> | null>>(() => Promise.resolve(null));
  const prioritySpaceIdRef = useRef<string | null>(null);
  const walkSpaceNowRef = useRef<(spaceId: string) => void>(() => undefined);
  const [loadedSpaceIds, setLoadedSpaceIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!ownSocket) return;
    const releaseData = retainQueryData(queryClient, [
      WORKSTREAMS_QUERY_KEY,
      SIDEBAR_LIST_QUERY_KEYS.automations,
      SPACES_QUERY_KEY, INACTIVE_SPACES_QUERY_KEY, SPACES_READY_QUERY_KEY,
      PERSONAL_ORDER_QUERY_KEY, PINNED_ORDER_QUERY_KEY,
      CLIENT_FEATURE_FLAGS_QUERY_KEY,
      WORKSTREAM_STATE_WATERLINES_KEY, WORKSPACE_DIRECTORY_WATERLINES_KEY,
    ]);
    let stopped = false;
    let permanentlyClosed = false;
    let socket: WebSocket | null = null;
    let activeTicketAbort: AbortController | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let openTimer: number | null = null;
    let pendingHandshakeDiagnostic: { id: string; requestedAt: number } | null = null;
    let connecting = false;
    let connectGeneration = 0;
    let syncTimer: number | null = null;
    /**
     * Set by main's `suspend`, cleared by `online()`: resume, the network coming
     * back, or a person asking to reconnect. Nothing dials in between, so a
     * ticket that settles as the machine sleeps is not dialled with.
     */
    let suspended = false;
    let attempt = 0;
    const socketTelemetry = realtimeSocketTelemetry('workspace');
    const reportHandshake = (
      attemptId: string,
      phase: TelemetryEventProperties<'workspace_socket_handshake'>['phase'],
      ticketRequestedAt?: number,
    ): void => reportTelemetryProductIntent({
      kind: 'workspace_socket_handshake',
      attemptId,
      phase,
      // Timers that fire minutes late and a window nobody can see are the
      // two things that told a sleeping Mac from a stuck server.
      ...(ticketRequestedAt === undefined
        ? {}
        : {
          sinceTicketRequested: telemetryJourneyDuration(Date.now() - ticketRequestedAt),
          windowVisible: document.visibilityState === 'visible',
        }),
    });
    const isOffline = (): boolean => navigator.onLine === false;
    let lastWaterline = -1;
    let presenceRevision = 0;
    const pendingDirectoryRequests = new Map<string, PendingDirectoryRequest>();
    const pendingRailRequests = new Map<string, PendingRailRequest>();
    const pendingSpaceRequests = new Map<string, PendingSpaceRequest>();
    /** This connection's sidebar said `channelsBySpace`. */
    let channelsBySpace = false;
    let railPrefetchRunning = false;
    let railPrefetchScheduled = false;
    let subscribed = false;
    let conversationViewsAvailable = false;
    /**
     * Whether the lists in the query cache are the socket's. Until the first
     * subscribe answer they may be the local cache's own seed, and the mirror
     * must not write a seed back over the row it came from.
     */
    let directoryLive = false;
    let applicationForegrounded = false;
    let applicationFocusObservation = 0;
    let windowForegrounded = document.visibilityState === 'visible' && document.hasFocus();

    sendConversationViewRequestsRef.current = () => {
      if (!subscribed || !conversationViewsAvailable || socket?.readyState !== WebSocket.OPEN) return;
      for (const [requestId, request] of conversationViewRequests.current) {
        if (request.sentOn === socket) continue;
        request.sentOn = socket;
        socket.send(JSON.stringify({ type: "conversation_view", requestId,
          parentId: request.parentId, substreamId: request.substreamId }));
      }
    };
    const sendPresence = (target: WebSocket | null = socket): void => {
      if (!subscribed || target?.readyState !== WebSocket.OPEN) return;
      target.send(JSON.stringify({
        type: 'set_presence',
        revision: presenceRevision += 1,
        applicationState: applicationForegrounded ? 'foreground' : 'background',
        foregroundWorkstreamId: applicationForegrounded && windowForegrounded
          ? foregroundWorkstreamIdRef.current
          : null,
      } satisfies WorkspaceSocketClientEvent));
    };
    reportPresenceRef.current = sendPresence;
    const bridge = desktopBridge();
    const publishTopics = (topics: WorkspaceSyncRelayTopic[], waterline: number): void => {
      if (relay === 'publish') publishToMain({ type: 'topics', region, workspaceId, waterline, topics });
    };
    const initialApplicationFocusObservation = applicationFocusObservation;
    void bridge.getApplicationForegroundState().then((foregrounded) => {
      if (stopped || applicationFocusObservation !== initialApplicationFocusObservation) return;
      applicationForegrounded = foregrounded;
      sendPresence();
    }).catch(() => undefined);
    const stopApplicationFocus = bridge.onApplicationForegroundChanged((foregrounded) => {
      applicationFocusObservation += 1;
      applicationForegrounded = foregrounded;
      if (foregrounded) recoverForeground();
      sendPresence();
    });
    const observeWindowFocus = (): void => {
      windowForegrounded = document.visibilityState === 'visible' && document.hasFocus();
      sendPresence();
    };
    window.addEventListener('focus', observeWindowFocus);
    window.addEventListener('blur', observeWindowFocus);
    document.addEventListener('visibilitychange', observeWindowFocus);

    const clearReconnect = (): void => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const clearSocketTimers = (): void => {
      if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
      if (pongTimer !== null) window.clearTimeout(pongTimer);
      if (openTimer !== null) window.clearTimeout(openTimer);
      if (syncTimer !== null) window.clearTimeout(syncTimer);
      heartbeatTimer = null;
      pongTimer = null;
      openTimer = null;
      syncTimer = null;
    };
    const clearHeartbeat = (): void => {
      if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
      if (pongTimer !== null) window.clearTimeout(pongTimer);
      heartbeatTimer = null;
      pongTimer = null;
    };
    const probeHeartbeatNow = (target: WebSocket): void => {
      if (stopped || socket !== target || target.readyState !== WebSocket.OPEN || pongTimer !== null) return;
      clearHeartbeat();
      try { target.send('ping'); } catch {
        retireTransport('transport_error');
        return;
      }
      pongTimer = window.setTimeout(() => {
        pongTimer = null;
        if (stopped || socket !== target) return;
        retireTransport('heartbeat_timeout');
      }, WORKSPACE_SOCKET_PONG_TIMEOUT_MS);
    };
    const scheduleHeartbeat = (target: WebSocket): void => {
      clearHeartbeat();
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null;
        probeHeartbeatNow(target);
      }, WORKSPACE_SOCKET_HEARTBEAT_MS);
    };
    /**
     * @returns whether the directory still needs a reconciling refetch.
     *
     * The payload is page one, merged over whatever is resident rather than
     * replacing it: a reader who had scrolled keeps the pages below it instead
     * of watching the list collapse and refill. The cost of merging is that a
     * cached row page one no longer returns is kept, and a work stream archived
     * while the socket was away is exactly that.
     *
     * A payload with no `nextCursor` is not page one, it is the whole
     * directory, so a resident row missing from it is a tombstone with no other
     * reading and the merge is replaced by the payload outright. Otherwise page
     * one cannot say which of the two an unaccounted-for row is — a later page
     * the reader scrolled to, or a tombstone — and the directory invalidation
     * is left to run so the query's own full walk decides. Deciding that here
     * would mean reproducing the server's `last_activity_at DESC,
     * workstream_id` ordering on the client, a second copy of the cursor
     * arithmetic that can drift from the first.
     *
     * A cold connect has nothing resident either way, so it asks for nothing;
     * that is the round trip this payload exists to remove.
     */
    const applyConnectedSidebar = (sidebar: WorkspaceSidebar): boolean => {
      channelsBySpace = sidebar.channelsBySpace === true;
      // The lists the socket does not carry. A nudge missed while the socket
      // was away is never sent again, so a connect is when they are read again.
      void queryClient.invalidateQueries({ queryKey: CHANNEL_FEEDS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MY_THREADS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
      if (channelsBySpace) {
        // Every Space is loading again: the walk this starts is what says
        // what the socket missed while it was away.
        loadedSpaces.clear();
        staleSpaces.clear();
        fullWalkFinished = false;
        setLoadedSpaceIds(new Set());
        applyVersionedSidebarList(
          queryClient,
          'automations',
          sidebar.automations.waterline,
          sidebar.automations.items.map(mapAutomationSummary),
        );
        if (sidebar.spaces) {
          applyVersionedSpaceSnapshot(queryClient, sidebar.spaces, sidebar.ordering ?? [], sidebar.spacesReady ?? true, sidebar.pinnedOrder, { pins: sidebar.pins, artifactPins: sidebar.artifactPins, channelStats: sidebar.channelStats });
        }
        void queryClient.invalidateQueries({ queryKey: ['sidekick-activity'] });
        directoryLive = true;
        setSidebarConnect((current) => ({
          generation: (current?.generation ?? 0) + 1,
          nextCursor: null,
          spacesLive: sidebar.spaces !== undefined,
          channelsBySpace: true,
        }));
        // The payload carried Spaces and no Channels: the directory's own
        // query walks them, and reconciles what it held against the walk.
        void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
        return false;
      }
      const page = applyDirectoryPage(queryClient, sidebar.workstreams, localCacheScope);
      const returned = new Set(page.items.map((workstream) => workstream.id));
      const unaccountedFor = (queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [])
        // A pending row cannot be in any answer yet, so it is not a question
        // for the reconciling refetch; `setCachedWorkstreams` keeps it.
        .some((workstream) => !workstream.pending && !returned.has(workstream.id));
      const wholeDirectory = page.nextCursor === null;
      if (wholeDirectory) setCachedWorkstreams(queryClient, () => page.items);
      else mergeCachedWorkstreamPage(queryClient, page.items);
      applyVersionedSidebarList(
        queryClient,
        'automations',
        sidebar.automations.waterline,
        sidebar.automations.items.map(mapAutomationSummary),
      );
      void queryClient.invalidateQueries({ queryKey: ['sidekick-activity'] });
      // `spacesReady` is optional on the wire and read as ready when absent:
      // a payload from a server that predates the cutover describes an
      // Organization that was never going to open, not one still opening.
      if (sidebar.spaces) {
        applyVersionedSpaceSnapshot(
          queryClient,
          sidebar.spaces,
          // Optional beside `spaces` and for the same reason: a payload from a
          // server without the ordering describes lists with no hand
          // arrangement, which is what an empty one draws.
          sidebar.ordering ?? [],
          sidebar.spacesReady ?? true,
          sidebar.pinnedOrder,
          { pins: sidebar.pins, artifactPins: sidebar.artifactPins, channelStats: sidebar.channelStats },
        );
      }
      directoryLive = true;
      // The directory is the bound on the conversation cache: a conversation
      // stays on disk for as long as its parent is a row here. Only the whole
      // directory can say a parent is gone; page one cannot tell a later page
      // from a tombstone, as the merge above already knows, so on a paged
      // workspace the disk follows evictions and the child rosters instead.
      if (localCacheScope !== null && wholeDirectory) {
        void retainConversationParents(localCacheScope, new Set([
          ...page.items.map((workstream) => workstream.id),
          ...sidebar.automations.items.map((automation) => automation.id),
        ]));
      }
      setSidebarConnect((current) => ({
        generation: (current?.generation ?? 0) + 1,
        nextCursor: page.nextCursor,
        spacesLive: sidebar.spaces !== undefined,
        channelsBySpace: false,
      }));
      return unaccountedFor && !wholeDirectory;
    };
    const sendPendingDirectoryRequests = (): void => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      for (const entry of pendingDirectoryRequests.values()) socket.send(JSON.stringify(entry.command));
    };
    const rejectPendingDirectoryRequests = (error: Error): void => {
      for (const entry of pendingDirectoryRequests.values()) {
        window.clearTimeout(entry.timeout);
        entry.reject(error);
      }
      pendingDirectoryRequests.clear();
    };
    const rejectPendingRailRequests = (error: Error): void => {
      for (const entry of pendingRailRequests.values()) {
        window.clearTimeout(entry.timeout);
        entry.reject(error);
      }
      pendingRailRequests.clear();
    };
    const rejectPendingSpaceRequests = (error: Error): void => {
      for (const entry of pendingSpaceRequests.values()) {
        window.clearTimeout(entry.timeout);
        entry.reject(error);
      }
      pendingSpaceRequests.clear();
    };
    const requestRails = (workstreamIds: string[]): Promise<Set<string>> =>
      new Promise((resolve, reject) => {
        if (!subscribed || socket?.readyState !== WebSocket.OPEN) {
          reject(new ApiError('The organization is not connected.', 409, 'workspace_socket_unavailable'));
          return;
        }
        const requestId = uuidV7();
        const timeout = window.setTimeout(() => {
          pendingRailRequests.delete(requestId);
          reject(new ApiError('Thread details could not be loaded.', 0, 'workspace_channel_rails_timeout'));
        }, COMMAND_TIMEOUT_MS);
        pendingRailRequests.set(requestId, { resolve, reject, timeout, named: new Set() });
        const command = WorkspaceSocketClientEventSchema.parse({ type: 'channel_rails', requestId, workstreamIds });
        socket.send(JSON.stringify(command));
      });
    // Settle only Channels no frame named: a named one was answered, and a
    // row that raised its waterline mid-request makes it stale again rather
    // than settled without its rail.
    const runRailTarget = async (workstreamIds: string[]): Promise<void> => {
      const named = await requestRails(workstreamIds);
      settleUnanswered(queryClient, workstreamIds.filter((id) => !named.has(id)));
    };
    const requestSpaceChannels = (
      target: { spaceId: string; after?: string; rails: boolean },
    ): Promise<WorkspaceSpaceChannelsEvent> =>
      new Promise((resolve, reject) => {
        if (!subscribed || socket?.readyState !== WebSocket.OPEN) {
          reject(new ApiError('The organization is not connected.', 409, 'workspace_socket_unavailable'));
          return;
        }
        const requestId = uuidV7();
        const timeout = window.setTimeout(() => {
          pendingSpaceRequests.delete(requestId);
          reject(new ApiError(
            'The thread list could not be loaded. Try again.',
            0,
            'workspace_space_channels_timeout',
          ));
        }, COMMAND_TIMEOUT_MS);
        pendingSpaceRequests.set(requestId, { resolve, reject, timeout });
        const command = WorkspaceSocketClientEventSchema.parse({ type: 'space_channels', requestId, ...target });
        socket.send(JSON.stringify(command));
      });
    /** The Spaces not yet walked, the one on screen first. */
    const spacesToWalk = (walked: ReadonlySet<string>): string[] => {
      const foreground = foregroundWorkstreamIdRef.current;
      const order = [
        prioritySpaceIdRef.current,
        ...(foreground === null ? [] : queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
          ?.find((row) => row.id === foreground)?.spaceIds ?? []),
        ...(queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY)?.items ?? []).map((space) => space.id),
        ...(queryClient.getQueryData<SpaceDirectory>(INACTIVE_SPACES_QUERY_KEY)?.items ?? []).map((space) => space.id),
      ];
      return [...new Set(order.filter((spaceId): spaceId is string => spaceId !== null && !walked.has(spaceId)))];
    };
    /**
     * One Space's pages, in order: each asks after the last. `onFirstPage`
     * is called once the first page is written.
     */
    /**
     * Spaces a walk has returned whole, Spaces being walked now, and loaded
     * Spaces to ask again when they next come on screen.
     */
    const loadedSpaces = new Set<string>();
    const walkingSpaces = new Set<string>();
    const staleSpaces = new Set<string>();
    /** Whole walks running now, and whether one has finished. */
    let fullWalks = 0;
    let fullWalkFinished = false;
    const walkSpace = async (
      spaceId: string,
      returned: Set<string>,
      signal: AbortSignal | undefined,
      onFirstPage: () => void = () => undefined,
    ): Promise<void> => {
      walkingSpaces.add(spaceId);
      staleSpaces.delete(spaceId);
      try {
        await walkSpacePages(spaceId, returned, signal, onFirstPage);
      } finally {
        walkingSpaces.delete(spaceId);
      }
      loadedSpaces.add(spaceId);
      setLoadedSpaceIds((current) => current.has(spaceId) ? current : new Set([...current, spaceId]));
      scheduleRailPrefetch();
    };
    const walkSpacePages = async (
      spaceId: string,
      returned: Set<string>,
      signal: AbortSignal | undefined,
      onFirstPage: () => void,
    ): Promise<void> => {
      const held = (queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [])
        .filter((row) => !row.pending && row.spaceIds.includes(spaceId));
      // Rails ride along unless every Channel held here has one already;
      // then the rows' waterlines say which moved, and those are asked for
      // by name.
      const rails = held.length === 0 || held.some((row) => !holdsChannelRail(queryClient, row.id));
      let after: string | null = null;
      do {
        // A newer walk replaced this one: stop rather than ask twice.
        signal?.throwIfAborted();
        const answer: WorkspaceSpaceChannelsEvent = await requestSpaceChannels({ spaceId, ...(after ? { after } : {}), rails });
        const page = applyDirectoryPage(queryClient, { ...answer, nextCursor: null }, localCacheScope);
        mergeCachedWorkstreamPage(queryClient, page.items);
        applyChannelRails(queryClient, { rails: answer.rails, oversized: [], unavailable: [] });
        for (const item of answer.items) returned.add(item.id);
        if (after === null) onFirstPage();
        after = answer.nextAfter;
      } while (after !== null && !stopped);
    };
    // A Space put on screen that no walk has returned (one listed since the
    // last whole walk, such as a Space just created) or that the directory
    // has moved under since. A whole walk still to come or running reaches it
    // itself. A failure shows what is held and asks again next time, rather
    // than leaving the Space loading.
    walkSpaceNowRef.current = (spaceId) => {
      if (!channelsBySpace || !subscribed || !fullWalkFinished || fullWalks > 0 || walkingSpaces.has(spaceId)
        || (loadedSpaces.has(spaceId) && !staleSpaces.has(spaceId))) return;
      void walkSpace(spaceId, new Set(), undefined).catch(() => {
        loadedSpaces.add(spaceId);
        staleSpaces.add(spaceId);
        setLoadedSpaceIds((current) => current.has(spaceId) ? current : new Set([...current, spaceId]));
      });
    };
    walkSpaceChannelsRef.current = async (signal) => {
      if (!channelsBySpace) return null;
      fullWalks += 1;
      try {
        const returned = await walkEverySpace(signal);
        fullWalkFinished = true;
        return returned;
      } finally {
        fullWalks -= 1;
        // A Space put on screen while the walk ran, and listed after it looked.
        if (prioritySpaceIdRef.current !== null) walkSpaceNowRef.current(prioritySpaceIdRef.current);
      }
    };
    const walkEverySpace = async (signal: AbortSignal | undefined): Promise<Set<string>> => {
      const returned = new Set<string>();
      const walked = new Set<string>();
      // The Space on screen alone, until its first page is in; then every
      // other Space at once. Pages within a Space still follow each other,
      // since each asks after the last. The WorkspaceDO answers one at a time
      // either way; asking together saves a round trip per Space.
      const [first] = spacesToWalk(walked);
      const walks: Promise<void>[] = [];
      if (first !== undefined) {
        walked.add(first);
        let firstPageIn!: () => void;
        const firstPage = new Promise<void>((resolve) => { firstPageIn = resolve; });
        const firstWalk = walkSpace(first, returned, signal, () => firstPageIn());
        walks.push(firstWalk);
        await Promise.race([firstPage, firstWalk]);
      }
      // Again until none is left: a Space can be listed while the walk runs.
      for (let rest = spacesToWalk(walked); rest.length > 0 && !stopped; rest = spacesToWalk(walked)) {
        for (const spaceId of rest) walked.add(spaceId);
        signal?.throwIfAborted();
        walks.push(...rest.map((spaceId) => walkSpace(spaceId, returned, signal)));
        await Promise.all(walks);
      }
      await Promise.all(walks);
      // A finished walk is the whole directory, so it can bound the
      // conversation cache the way a whole connect page does.
      if (!stopped && localCacheScope !== null) {
        void retainConversationParents(localCacheScope, new Set([
          ...returned,
          ...(queryClient.getQueryData<{ id: string }[]>(SIDEBAR_LIST_QUERY_KEYS.automations) ?? [])
            .map((automation) => automation.id),
        ]));
      }
      return returned;
    };
    /**
     * One request in flight at a time, until every rail a row has said is
     * held. A request that fails ends the pass; the next row, reconnect or
     * foreground change starts another.
     */
    const runRailPrefetch = async (): Promise<void> => {
      if (railPrefetchRunning) return;
      railPrefetchRunning = true;
      try {
        while (!stopped && subscribed) {
          const target = nextChannelRailRequest(
            queryClient,
            foregroundWorkstreamIdRef.current,
            queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [],
            queryClient.getQueryData<SpaceDirectory>(SPACES_QUERY_KEY),
          );
          if (!target) break;
          await runRailTarget(target);
        }
      } catch {
        // The rows still say what is stale; the next kick asks again.
      } finally {
        railPrefetchRunning = false;
      }
    };
    const scheduleRailPrefetch = (): void => {
      if (railPrefetchScheduled) return;
      railPrefetchScheduled = true;
      queueMicrotask(() => {
        railPrefetchScheduled = false;
        void runRailPrefetch();
      });
    };
    scheduleRailPrefetchRef.current = scheduleRailPrefetch;
    refreshChannelRailsRef.current = async (workstreamIds) => {
      const served = workstreamIds.filter((id) => hasRailWaterline(queryClient, id)).slice(0, CHANNEL_RAILS_NAMED_LIMIT);
      if (served.length === 0) return;
      await requestRails(served);
    };
    /** What every end of a socket's life resets, whoever ended it. */
    const releaseSocket = (): void => {
      clearSocketTimers();
      subscribed = false;
      conversationViewsAvailable = false;
      socket = null;
      setPresenceUserIdsByWorkstream({});
      rejectPendingRailRequests(new ApiError('The organization connection closed.', 0, 'workspace_socket_closed'));
      rejectPendingSpaceRequests(new ApiError('The organization connection closed.', 0, 'workspace_socket_closed'));
    };
    const cancelTicketAttempt = (): void => {
      connectGeneration += 1;
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      connecting = false;
    };
    const retireTransport = (cause: 'transport_error' | 'heartbeat_timeout' | 'open_timeout' | 'sync_timeout'): void => {
      const retired = socket;
      releaseSocket();
      try { retired?.close(); } catch { /* Ownership has already moved on. */ }
      socketTelemetry.disconnected({ attempts: attempt, retrying: !isOffline(), cause });
      scheduleReconnect();
    };
    const recoverForeground = (): void => {
      if (stopped || permanentlyClosed || suspended) return;
      if (socket?.readyState === WebSocket.OPEN) probeHeartbeatNow(socket);
      else {
        clearReconnect();
        void connect();
      }
    };
    const scheduleReconnect = (): void => {
      if (stopped || permanentlyClosed || suspended || reconnectTimer !== null) return;
      if (navigator.onLine === false) {
        setState('unavailable');
        return;
      }
      attempt += 1;
      setState('reconnecting');
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, workspaceSocketReconnectDelay(attempt));
    };
    const connect = async (): Promise<void> => {
      if (stopped || permanentlyClosed || suspended || connecting) return;
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
      if (socket) releaseSocket();
      const diagnosticAttemptId = uuidV7();
      if (navigator.onLine === false) {
        reportHandshake(diagnosticAttemptId, 'offline_blocked');
        setState('unavailable');
        return;
      }
      connecting = true;
      const generation = ++connectGeneration;
      clearReconnect();
      setState(attempt === 0 ? 'connecting' : 'reconnecting');
      const ticketAbort = new AbortController();
      activeTicketAbort = ticketAbort;
      const ticketRequestedAt = Date.now();
      pendingHandshakeDiagnostic = { id: diagnosticAttemptId, requestedAt: ticketRequestedAt };
      try {
        reportHandshake(diagnosticAttemptId, 'ticket_requested');
        const ticket = await api.getWorkspaceSocketTicket(ticketAbort.signal);
        // A ticket that settled as the machine went to sleep: resume dials.
        if (stopped || suspended || generation !== connectGeneration) return;
        reportHandshake(diagnosticAttemptId, 'ticket_received', ticketRequestedAt);
        // The offline handler normally aborts an in-flight ticket. This closes
        // the narrower race where the ticket settles just before that handler:
        // never dial after the network transition, and keep it distinct from a
        // transport failure.
        if (isOffline()) {
          reportHandshake(diagnosticAttemptId, 'offline_blocked');
          socketTelemetry.disconnected({ attempts: attempt, retrying: false, cause: 'offline' });
          setState('unavailable');
          return;
        }
        const next = new WebSocket(ticket.url, ticket.protocols);
        socket = next;
        // A `101` the client never receives leaves the socket CONNECTING, with
        // no heartbeat yet to notice, until the operating system gives up.
        openTimer = window.setTimeout(() => {
          openTimer = null;
          if (stopped || socket !== next || next.readyState !== WebSocket.CONNECTING) return;
          reportHandshake(diagnosticAttemptId, 'open_timeout', ticketRequestedAt);
          retireTransport('open_timeout');
        }, WORKSPACE_SOCKET_OPEN_TIMEOUT_MS);
        let firstSyncObserved = false;
        let firstSidebarApplied = false;
        let syncRejectionReported = false;
        next.addEventListener('open', () => {
          if (stopped || socket !== next) return;
          if (openTimer !== null) window.clearTimeout(openTimer);
          openTimer = null;
          // A pong can be answered by the platform while subscription is stuck.
          // Reuse the existing opening budget for the authoritative sidebar.
          syncTimer = window.setTimeout(() => {
            if (stopped || socket !== next) return;
            reportHandshake(diagnosticAttemptId, 'sync_timeout', ticketRequestedAt);
            retireTransport('sync_timeout');
          }, WORKSPACE_SOCKET_OPEN_TIMEOUT_MS);
          reportHandshake(diagnosticAttemptId, 'transport_open', ticketRequestedAt);
          socketTelemetry.connected(attempt);
          // A new transport has not inherited the prior one's Space snapshot.
          // Keep cached rows visible, but withhold writes until this subscribe
          // response (or a later Space push) establishes current authority.
          setSidebarConnect((current) => current ? { ...current, spacesLive: false } : current);
          setState('connected');
          next.send(JSON.stringify({
            type: 'subscribe',
            afterWaterline: Math.max(0, lastWaterline),
            diagnosticAttemptId,
          }));
          reportHandshake(diagnosticAttemptId, 'subscribe_sent');
          // No directory invalidation here: subscribing is answered with the
          // whole sidebar, so a reconnect reconverges from that payload rather
          // than from a refetch the client has to ask for.
          sendPendingDirectoryRequests();
          scheduleHeartbeat(next);
        });
        next.addEventListener('message', (messageEvent) => {
          if (stopped || socket !== next) return;
          if (String(messageEvent.data) === 'pong') {
            scheduleHeartbeat(next);
            return;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(String(messageEvent.data));
          } catch {
            return;
          }
          const conversationView = safeParseSocketEvent(WorkspaceConversationViewEventSchema, decoded);
          if (conversationView.success) {
            const event = conversationView.data;
            const request = conversationViewRequests.current.get(event.requestId);
            if (request && request.parentId === event.parentId && request.substreamId === event.substreamId) {
              conversationViewRequests.current.delete(event.requestId);
              request.receive(event);
            }
            return;
          }
          const sync = safeParseSocketEvent(WorkspaceSocketSyncEventSchema, decoded);
          if (sync.success) {
            if (sync.data.conversationViews) conversationViewsAvailable = true;
            if (!firstSyncObserved) {
              firstSyncObserved = true;
              reportHandshake(diagnosticAttemptId, 'sync_received');
            }
            if (!subscribed) {
              subscribed = true;
              sendPresence();
              sendConversationViewRequestsRef.current();
            }
            if (sync.data.accessRequests) {
              queryClient.setQueryData(accessRequestsQueryKey(workspaceId), sync.data.accessRequests);
            }
            if (sync.data.viewerPreferences) {
              // Cancelled first: a REST read started before this answer holds
              // older data and would otherwise land on top of it, fresh forever.
              const key = memberPreferencesQueryKey(workspaceId);
              void queryClient.cancelQueries({ queryKey: key });
              queryClient.setQueryData(key, sync.data.viewerPreferences);
            }
            if (sync.data.featureFlags) {
              queryClient.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, sync.data.featureFlags);
              // Every answer to `subscribe` carries the viewer's flags, and a
              // flag push made while this socket was away moved no topic. A
              // consumer refetches its own rather than trusting ours: flags
              // are the viewer's, but the relay carries names, not values.
              if (!sync.data.topics.includes('feature_flags')) {
                publishTopics(['feature_flags'], Math.max(lastWaterline, sync.data.waterline));
              }
            }
            // Before the waterline guard, not after. The sidebar rides on the
            // answer to `subscribe`, and a resume where no topic moved carries
            // the waterline the client already has — so a guard that ran first
            // would drop the state this event exists to deliver.
            const directoryNeedsReconciling = sync.data.sidebar
              ? applyConnectedSidebar(sync.data.sidebar)
              : false;
            // A plan-change push is not replayed: an open meter reads again.
            if (sync.data.sidebar) {
              void queryClient.invalidateQueries({ queryKey: MERGE_CHANNELS_QUERY_KEY });
              void queryClient.invalidateQueries({ queryKey: organizationUsageQueryKey(localCacheScope) });
              publishTopics(['usage'], Math.max(lastWaterline, sync.data.waterline));
            }
            if (sync.data.sidebar && !firstSidebarApplied) {
              firstSidebarApplied = true;
              if (syncTimer !== null) window.clearTimeout(syncTimer);
              syncTimer = null;
              attempt = 0;
              reportHandshake(diagnosticAttemptId, 'sync_applied');
              api.confirmSocketTicket?.(ticket);
            }
            if (sync.data.sidebar) scheduleRailPrefetch();
            if (sync.data.waterline <= lastWaterline) return;
            lastWaterline = sync.data.waterline;
            setTopicWaterlines((current) => withTopicWaterline(current, sync.data.topics, sync.data.waterline));
            // Every topic, `initial` and `history_unavailable` included: those
            // name everything because this socket cannot say what moved while
            // it was away, and neither can a window relying on it.
            if (sync.data.topics.length > 0) publishTopics(sync.data.topics, sync.data.waterline);
            for (const topic of sync.data.topics) {
              // An event that carried the sidebar has just delivered the
              // directory; telling the client to go and fetch it again in the
              // same breath undoes the whole point of the payload. `initial`
              // names every topic, so without this the connect answer is
              // followed immediately by the `list_workstreams` it replaced.
              // Unless the payload left a resident row unaccounted for — then
              // the refetch is the only thing that can retire a tombstone the
              // socket was away for.
              if (topic === 'workstream_directory' && sync.data.sidebar && !directoryNeedsReconciling) continue;
              // Loading a Space at a time, the directory moved somewhere this
              // cannot see: the Space on screen is asked again now, and every
              // other Space when it next comes on screen, rather than every
              // desktop asking every Space at once.
              if (topic === 'workstream_directory' && channelsBySpace) {
                for (const spaceId of loadedSpaces) staleSpaces.add(spaceId);
                if (prioritySpaceIdRef.current !== null) walkSpaceNowRef.current(prioritySpaceIdRef.current);
                continue;
              }
              invalidateTopic(queryClient, topic);
            }
            return;
          }
          const presence = safeParseSocketEvent(WorkspacePresenceEventSchema, decoded);
          if (presence.success) {
            const workstreamId = presence.data.workstreamId;
            if (workstreamId !== null) {
              setPresenceUserIdsByWorkstream((current) => ({
                ...current,
                [workstreamId]: presence.data.userIds,
              }));
            }
            return;
          }
          const featureFlags = safeParseSocketEvent(WorkspaceFeatureFlagsEventSchema, decoded);
          if (featureFlags.success) {
            queryClient.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, featureFlags.data.flags);
            // A push, not a sync event: no topic moved, so the flag change is
            // relayed as the `feature_flags` topic it amounts to.
            publishTopics(['feature_flags'], lastWaterline);
            return;
          }
          const recency = safeParseSocketEvent(WorkspaceWorkstreamRecencyEventSchema, decoded);
          if (recency.success) {
            mergeCachedWorkstreamPage(queryClient, applyDirectoryPage(queryClient, {
              directoryWaterline: recency.data.directoryWaterline,
              items: [recency.data.workstream], stateVersions: [recency.data.stateVersion], nextCursor: null,
            }, localCacheScope).items);
            scheduleRailPrefetch();
            return;
          }
          const channelRails = safeParseSocketEvent(WorkspaceChannelRailsEventSchema, decoded);
          if (channelRails.success) {
            applyChannelRails(queryClient, channelRails.data);
            const entry = pendingRailRequests.get(channelRails.data.requestId);
            if (entry) {
              for (const rail of channelRails.data.rails) entry.named.add(rail.workstreamId);
              for (const oversized of channelRails.data.oversized) entry.named.add(oversized.workstreamId);
              for (const id of channelRails.data.unavailable) entry.named.add(id);
            }
            if (entry && channelRails.data.final) {
              pendingRailRequests.delete(channelRails.data.requestId);
              window.clearTimeout(entry.timeout);
              entry.resolve(entry.named);
            }
            return;
          }
          const spaceChannels = safeParseSocketEvent(WorkspaceSpaceChannelsEventSchema, decoded);
          if (spaceChannels.success) {
            const entry = pendingSpaceRequests.get(spaceChannels.data.requestId);
            if (!entry) return;
            pendingSpaceRequests.delete(spaceChannels.data.requestId);
            window.clearTimeout(entry.timeout);
            entry.resolve(spaceChannels.data);
            return;
          }
          const workstreamPage = safeParseSocketEvent(WorkspaceWorkstreamPageEventSchema, decoded);
          if (workstreamPage.success) {
            const entry = pendingDirectoryRequests.get(workstreamPage.data.requestId);
            if (!entry) return;
            pendingDirectoryRequests.delete(workstreamPage.data.requestId);
            window.clearTimeout(entry.timeout);
            entry.resolve(applyDirectoryPage(queryClient, workstreamPage.data, localCacheScope));
            scheduleRailPrefetch();
            return;
          }
          const workstreamState = safeParseSocketEvent(WorkspaceWorkstreamStateEventSchema, decoded);
          if (workstreamState.success) {
            const workstream = workstreamState.data.workstream
              ? mapWorkstreamSummary(workstreamState.data.workstream)
              : queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
                ?.find((item) => item.id === workstreamState.data.workstreamId);
            const applied = applyVersionedWorkstreamState(queryClient, {
              workstreamId: workstreamState.data.workstreamId,
              stateVersion: workstreamState.data.stateVersion,
              ...(workstream ? workstreamSummaryState(workstream) : {
                common: {},
                viewer: {},
              }),
              visible: workstreamState.data.workstream !== null,
            });
            if (workstreamState.data.workstream && applied.visible) {
              applyChannelViewerState(
                queryClient,
                workstreamState.data.workstream,
                workstreamState.data.stateVersion,
                localCacheScope,
              );
              // A Channel the shared navigation lists (a guest's, or one
              // reached through its breakouts) draws Space and ancestor
              // presentation from that directory, which this row does not
              // carry. The one on screen rereads it when its row moves.
              if (workstreamState.data.workstreamId === foregroundWorkstreamIdRef.current
                && queryClient.getQueriesData<SharedNavigationDirectory>({ queryKey: ['shared-navigation'] })
                  .some(([, directory]) => directory?.workstreams
                    .some((item) => item.parentId === workstreamState.data.workstreamId))) {
                void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] });
              }
            }
            if (applied.commonApplied) {
              void queryClient.invalidateQueries({
                queryKey: ['terminal-workstream', workstreamState.data.workstreamId],
                exact: true,
              });
            }
            // A tombstone says this Channel is not one this person sees, which
            // is also what being seated in one of its breakouts, or leaving its
            // Main, looks like from here: which of its conversations they
            // reach may have changed, and only the conversation directory says.
            if (workstreamState.data.workstream === null) {
              void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] });
              // A loss of visibility may be archive or membership. Ask the
              // authoritative conversation list rather than guessing which
              // breakouts the viewer still reaches through this parent.
              if (!applied.visible) void queryClient.invalidateQueries({ queryKey: MY_THREADS_QUERY_KEY });
            }
            scheduleRailPrefetch();
            return;
          }
          const sidebarList = safeParseSocketEvent(WorkspaceSidebarListEventSchema, decoded);
          if (sidebarList.success) {
            // Through the shared receiver, not straight into the cache: the
            // opening batch writes the same two entries, and only a comparison
            // against one ledger can order the two producers.
            if (sidebarList.data.list === 'automations') {
              applyVersionedSidebarList(
                queryClient,
                'automations',
                sidebarList.data.waterline,
                sidebarList.data.items.map(mapAutomationSummary),
              );
              // The list is pushed whenever an automation's own row changes,
              // and the change that matters most to an open automation page
              // is one the page cannot see otherwise: its chat submitting a
              // revision. No HTTP request of the desktop's is in play then,
              // so no sync topic follows; the list push is the one signal,
              // and the detail surfaces it feeds refetch on it.
              void queryClient.invalidateQueries({ queryKey: ['automation'] });
              void queryClient.invalidateQueries({ queryKey: ['automation-runs'] });
              void queryClient.invalidateQueries({ queryKey: ['sidekicks-library'] });
              void queryClient.invalidateQueries({ queryKey: ['sidekick-activity'] });
              void queryClient.invalidateQueries({ queryKey: ['attached-sidekicks'] });
              void queryClient.invalidateQueries({ queryKey: ['workstream-sidekicks'] });
              // Relayed as the `automations` topic it amounts to, so the
              // Sidekicks window, which reads these surfaces and not the list,
              // hears it without a socket of its own.
              publishTopics(['automations'], Math.max(lastWaterline, 0));
            }
            return;
          }
          const spaceSnapshot = safeParseSocketEvent(WorkspaceSpaceSnapshotEventSchema, decoded);
          if (spaceSnapshot.success) {
            applyVersionedSpaceSnapshot(
              queryClient,
              spaceSnapshot.data.spaces,
              spaceSnapshot.data.ordering,
              spaceSnapshot.data.spacesReady,
              spaceSnapshot.data.pinnedOrder,
              { pins: spaceSnapshot.data.pins, channelStats: spaceSnapshot.data.channelStats },
            );
            void queryClient.invalidateQueries({ queryKey: ['sidekick-activity', 'space'] });
            setSidebarConnect((current) => current ? { ...current, spacesLive: true } : current);
            // Guest hierarchy is a separately authorized associative read.
            // The snapshot is still the realtime nudge for a membership
            // change, but it must never carry private Space rows itself.
            void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] });
            return;
          }
          const navigationState = safeParseSocketEvent(WorkspaceNavigationStateEventSchema, decoded);
          if (navigationState.success) {
            applyNavigationState(queryClient, navigationState.data);
            return;
          }
          const accessRequests = safeParseSocketEvent(WorkspaceAccessRequestsEventSchema, decoded);
          if (accessRequests.success) {
            queryClient.setQueryData(accessRequestsQueryKey(workspaceId), accessRequests.data.requests);
            return;
          }
          const usage = safeParseSocketEvent(WorkspaceUsageEventSchema, decoded);
          if (usage.success) {
            // A plan change moved the Organization's quota and overage.
            applyPushedOrganizationUsage(queryClient, localCacheScope, usage.data.usage);
            publishTopics(['usage'], lastWaterline);
            return;
          }
          const reachChanged = safeParseSocketEvent(WorkspaceReachChangedEventSchema, decoded);
          if (reachChanged.success) {
            void queryClient.invalidateQueries({ queryKey: MERGE_CHANNELS_QUERY_KEY });
            // This person joined or left a Channel or Breakout. A member's
            // sidebar already moved: the Channel row and the Space pages are
            // pushed on the same flip. A guest's is the associative read,
            // which no Space snapshot reaches, so it is read again here.
            void queryClient.invalidateQueries({ queryKey: ['shared-navigation'] });
            return;
          }
          const resourceVersions = safeParseSocketEvent(WorkspaceResourceVersionsEventSchema, decoded);
          if (resourceVersions.success) {
            // A resource some conversation holds has a new version: every
            // preview open on it moves to the new head.
            applyResourceHeads(queryClient, resourceVersions.data.resources);
            return;
          }
          const spaceConversations = safeParseSocketEvent(
            WorkspaceSpaceConversationsEventSchema, decoded,
          );
          if (spaceConversations.success) {
            // A Channel's feed is the one list on its screen the socket does
            // not carry, so the named Channels' feeds are read again. The
            // count beside each id updates the sidebar without rebuilding the
            // whole Space directory. The only
            // coalescing is React Query's own in-flight dedupe — a burst of
            // messages in one Space costs one refetch while it is in flight,
            // and there is no timer here to tune.
            for (const spaceId of spaceConversations.data.spaceIds) {
              void queryClient.invalidateQueries({ queryKey: channelFeedQueryKey(spaceId) });
            }
            // Only a placement changes which threads the Threads tab, Activity
            // and the Channel counts hold, so only a placement re-reads them
            // now. A message in a thread already placed marks them stale,
            // read again the next time one is shown, rather than re-reading
            // every loaded page for every message in the Organization.
            const refetchType = spaceConversations.data.placementChanged === false ? 'none' : 'active';
            if (spaceConversations.data.placementChanged !== false) {
              void queryClient.invalidateQueries({ queryKey: MERGE_CHANNELS_QUERY_KEY });
            }
            void queryClient.invalidateQueries({ queryKey: MY_THREADS_QUERY_KEY, refetchType });
            void queryClient.invalidateQueries({ queryKey: CHANNEL_STATS_QUERY_KEY, refetchType });
            void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY, refetchType });
            if (spaceConversations.data.attentionCounts.length > 0) {
              const counts = new Map(spaceConversations.data.attentionCounts.map((entry) => [
                entry.spaceId,
                entry.count,
              ]));
              queryClient.setQueryData<SpaceDirectory>(SPACES_QUERY_KEY, (current) => current ? {
                ...current,
                items: current.items.map((space) => counts.has(space.id)
                  ? { ...space, attentionCount: counts.get(space.id)! }
                  : space),
              } : current);
            }
            return;
          }
          // Nothing above claimed this message, and until now that ended the
          // handler in silence. A message whose `type` no schema here knows is
          // the ordinary forward-compatible case and stays silent; one whose
          // `type` a schema *did* match and whose body it then rejected is a
          // contract skew between two of our own components, and dropping it
          // without a word is how a desktop built ahead of its API would show
          // no Spaces at all with nothing anywhere saying `reach`.
          //
          // The message's own `type` is what picks the schema that should have
          // read it; `describeZodIssues` then names the field it rejected,
          // which is schema shape rather than the message's data.
          if (!syncRejectionReported && typeof decoded === 'object' && decoded !== null
            && 'type' in decoded && decoded.type === 'workspace_sync') {
            syncRejectionReported = true;
            reportHandshake(diagnosticAttemptId, 'sync_rejected');
          }
          reportSocketContractSkew(
            typeof decoded === 'object' && decoded !== null && 'type' in decoded
              ? (decoded as { type: unknown }).type
              : undefined,
            [
              ['workspace_sync', 'sync', sync],
              ['workspace_presence', 'presence', presence],
              ['workspace_feature_flags', 'feature flags', featureFlags],
              ['workspace_workstream_recency', 'channel recency', recency],
              ['workspace_workstream_page', 'channel page', workstreamPage],
              ['workspace_channel_rails', 'channel rails', channelRails],
              ['workspace_space_channels', 'space channels', spaceChannels],
              ['workspace_workstream_state', 'channel state', workstreamState],
              ['workspace_sidebar_list', 'sidebar list', sidebarList],
              ['workspace_space_snapshot', 'space snapshot', spaceSnapshot],
              ['space_conversations_changed', 'space conversations nudge', spaceConversations],
              ['workspace_reach_changed', 'reach change', reachChanged],
              ['workspace_resource_versions', 'resource versions', resourceVersions],
              ['workspace_access_requests', 'access requests', accessRequests],
              ['workspace_usage', 'usage', usage],
            ],
          );
        });
        next.addEventListener('close', (event) => {
          if (socket !== next) return;
          releaseSocket();
          const accessRevoked = event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE;
          const permanentError = accessRevoked
            ? new ApiError(
              'You can no longer access this organization.',
              403,
              'workspace_access_revoked',
            )
            : event.code === WORKSPACE_SOCKET_SESSION_INACTIVE_CODE
              ? new ApiError(
                'Your session is no longer active. Sign in again.',
                401,
                'workspace_session_inactive',
              )
              : event.code === WORKSPACE_SOCKET_INVALID_MESSAGE_CODE
                ? new ApiError(
                  'Rally could not complete this action because its realtime command was invalid. Restart the app and try again.',
                  400,
                  'workspace_socket_invalid_message',
                )
                : null;
          if (permanentError) {
            permanentlyClosed = true;
            if (accessRevoked) {
              onAccessRevoked?.();
              socketTelemetry.disconnected({
                attempts: attempt,
                retrying: false,
                cause: 'access_revoked',
              });
            } else {
              socketTelemetry.disconnected({ attempts: attempt, retrying: false });
            }
            setState('unavailable');
            rejectPendingDirectoryRequests(permanentError);
            return;
          }
          if (!stopped) {
            socketTelemetry.disconnected({ attempts: attempt, retrying: !isOffline() });
          }
          scheduleReconnect();
        });
        next.addEventListener('error', () => {
          // See `use-workstream-socket.ts`: the pending cause is the loop's, so
          // a superseded socket's error must not arm the live one's.
          if (stopped || socket !== next) return;
          retireTransport('transport_error');
        });
      } catch (error) {
        if (stopped || generation !== connectGeneration) return;
        if (!stopped) {
          const offline = isOffline();
          if (offline) reportHandshake(diagnosticAttemptId, 'offline_blocked');
          socketTelemetry.disconnected({
            attempts: attempt,
            retrying: !offline,
            cause: suspended
              ? 'suspended'
              : offline
                ? 'offline'
                : isSocketTicketRequestTimeoutError(error) ? 'ticket_timeout' : 'ticket_failed',
          });
        }
        scheduleReconnect();
      } finally {
        if (activeTicketAbort === ticketAbort) activeTicketAbort = null;
        if (generation === connectGeneration) {
          connecting = false;
          pendingHandshakeDiagnostic = null;
        }
      }
    };

    listWorkstreamsRef.current = (input) => new Promise((resolve, reject) => {
      const requestId = uuidV7();
      const command: ListWorkstreamsCommand = {
        type: 'list_workstreams',
        requestId,
        limit: input.limit,
        ...(input.before ? { before: input.before } : {}),
        includeSystem: input.includeSystem,
      };
      const timeout = window.setTimeout(() => {
        pendingDirectoryRequests.delete(requestId);
        reject(new ApiError(
          'The thread list could not be loaded. Try again.',
          0,
          'workspace_directory_timeout',
        ));
      }, COMMAND_TIMEOUT_MS);
      pendingDirectoryRequests.set(requestId, { command, resolve, reject, timeout });
      sendPendingDirectoryRequests();
      void connect();
    });

    const online = (): void => {
      suspended = false;
      clearReconnect();
      if (socket?.readyState === WebSocket.OPEN) probeHeartbeatNow(socket);
      else void connect();
    };
    const offline = (): void => {
      const hadAttempt = socket !== null || connecting;
      if (pendingHandshakeDiagnostic) {
        reportHandshake(pendingHandshakeDiagnostic.id, 'offline_blocked');
        pendingHandshakeDiagnostic = null;
      }
      clearReconnect();
      clearSocketTimers();
      cancelTicketAttempt();
      const retired = socket;
      if (hadAttempt) socketTelemetry.disconnected({ attempts: attempt, retrying: false, cause: 'offline' });
      setState('unavailable');
      setPresenceUserIdsByWorkstream({});
      rejectPendingDirectoryRequests(new ApiError(
        'The thread list cannot be loaded while offline.',
        0,
        'workspace_directory_offline',
      ));
      rejectPendingRailRequests(new ApiError('Thread details cannot be loaded while offline.', 0, 'workspace_directory_offline'));
      rejectPendingSpaceRequests(new ApiError(
        'The thread list cannot be loaded while offline.',
        0,
        'workspace_directory_offline',
      ));
      releaseSocket();
      try { retired?.close(); } catch { /* Offline already released ownership. */ }
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    const stopPowerState = bridge.onPowerStateChanged((state) => {
      if (stopped || permanentlyClosed) return;
      if (state === 'resumed') {
        cancelTicketAttempt();
        const retired = socket;
        releaseSocket();
        try { retired?.close(); } catch { /* Wake replaces the pre-sleep transport. */ }
        online();
        return;
      }
      suspended = true;
      const hadTicket = connecting;
      clearReconnect();
      cancelTicketAttempt();
      setState('reconnecting');
      const sleeping = socket;
      if (!sleeping) {
        if (hadTicket) socketTelemetry.disconnected({ attempts: attempt, retrying: true, cause: 'suspended' });
        return;
      }
      // Settled here rather than by its `close` event, which may arrive after
      // a resume has dialled again: that socket's events are then ignored, and
      // its cause is reported now, for it alone.
      releaseSocket();
      socketTelemetry.disconnected({ attempts: attempt, retrying: true, cause: 'suspended' });
      try { sleeping.close(); } catch { /* Sleep already released ownership. */ }
    });
    // The sidebar paints from the disk while the ticket and the handshake are
    // still in flight; the subscribe answer then applies over it through the
    // ordinary receivers, whose ledgers a seed never touches.
    const localCacheMirror = localCacheScope === null
      ? null
      : mirrorWorkspaceDirectory(queryClient, localCacheScope, { live: () => directoryLive });
    if (localCacheScope !== null) void hydrateWorkspaceDirectory(queryClient, localCacheScope, () => !stopped);
    void connect();
    return () => {
      stopped = true;
      localCacheMirror?.stop();
      releaseData();
      listWorkstreamsRef.current = () => Promise.reject(new ApiError(
        'The organization is no longer connected.',
        409,
        'workspace_socket_closed',
      ));
      rejectPendingDirectoryRequests(new ApiError(
        'The organization closed while loading the directory.',
        409,
        'workspace_socket_closed',
      ));
      rejectPendingRailRequests(new ApiError('The organization closed.', 409, 'workspace_socket_closed'));
      rejectPendingSpaceRequests(new ApiError('The organization closed.', 409, 'workspace_socket_closed'));
      walkSpaceChannelsRef.current = () => Promise.resolve(null);
      walkSpaceNowRef.current = () => undefined;
      scheduleRailPrefetchRef.current = () => undefined;
      sendConversationViewRequestsRef.current = () => undefined;
      refreshChannelRailsRef.current = () => Promise.reject(new ApiError('The organization closed.', 409, 'workspace_socket_closed'));
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      stopPowerState();
      window.removeEventListener('focus', observeWindowFocus);
      window.removeEventListener('blur', observeWindowFocus);
      document.removeEventListener('visibilitychange', observeWindowFocus);
      stopApplicationFocus();
      reportPresenceRef.current = () => undefined;
      subscribed = false;
      clearReconnect();
      clearSocketTimers();
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      socket?.close();
    };
  }, [api, localCacheScope, onAccessRevoked, ownSocket, queryClient, region, relay, workspaceId]);

  useEffect(() => {
    if (relay !== 'publish') return;
    const requests = new Map<string, () => void>();
    const stop = desktopBridge().onWorkspaceSyncRelayed((request) => {
      if (request.type !== 'conversation_view_request' && request.type !== 'conversation_view_cancel') return;
      if (!sameWorkspaceSyncIdentity(request, { region, workspaceId })) return;
      requests.get(request.requestId)?.();
      requests.delete(request.requestId);
      if (request.type === 'conversation_view_cancel') return;
      requests.set(request.requestId, requestConversationView(request.parentId, request.substreamId, (event) => {
        requests.delete(request.requestId);
        publishToMain({ type: 'conversation_view_response', region, workspaceId,
          event: { ...event, requestId: request.requestId } });
      }));
    });
    return () => {
      stop();
      for (const cancel of requests.values()) cancel();
    };
  }, [region, relay, requestConversationView, workspaceId]);

  useEffect(() => {
    if (ownSocket || relay !== 'consume') return;
    const bridge = desktopBridge();
    const sent = new Set<string>();
    const send = (): void => {
      if (!sameWorkspaceSyncIdentity(relaySnapshot?.source, { region, workspaceId })) return;
      for (const [requestId, request] of conversationViewRequests.current) {
        if (sent.has(requestId)) continue;
        sent.add(requestId);
        void bridge.requestWorkspaceConversationView({
          type: 'conversation_view_request', region, workspaceId, requestId,
          parentId: request.parentId, substreamId: request.substreamId,
        }).catch((error: unknown) => {
          sent.delete(requestId);
          logWarn('rally', 'could not relay conversation view request', error);
        });
      }
    };
    const cancel = (requestId: string): void => {
      if (!sent.delete(requestId)) return;
      void bridge.requestWorkspaceConversationView({
        type: 'conversation_view_cancel', region, workspaceId, requestId,
      }).catch((error: unknown) => logWarn('rally', 'could not cancel relayed conversation view', error));
    };
    sendConversationViewRequestsRef.current = send;
    cancelRelayedConversationViewRef.current = cancel;
    completeRelayedConversationViewRef.current = (requestId) => { sent.delete(requestId); };
    send();
    return () => {
      for (const requestId of sent) cancel(requestId);
      sendConversationViewRequestsRef.current = () => undefined;
      cancelRelayedConversationViewRef.current = () => undefined;
      completeRelayedConversationViewRef.current = () => undefined;
    };
  }, [ownSocket, region, relay, relaySnapshot, workspaceId]);

  // The publisher's lifetime. Its cleanup is what tells main the socket is
  // gone when the tree falls into the top-level error boundary: main would
  // otherwise go on reporting a connected publisher, and the Settings window
  // would dial nothing and hear nothing. Deferred to a microtask so that a
  // successor mounted in the same pass — an Organization switch, StrictMode —
  // claims the relay first and no detach is sent at all.
  useEffect(() => {
    if (relay !== 'publish') return;
    const claim = {};
    mountedRelayPublisher = claim;
    return () => {
      queueMicrotask(() => {
        if (mountedRelayPublisher !== claim) return;
        mountedRelayPublisher = null;
        publishToMain({ type: 'detach', region, workspaceId });
      });
    };
  }, [region, relay, workspaceId]);

  // The publisher's connection state, which attaches it: a consumer shows and
  // reacts to the socket it is actually relying on (the OAuth reconcile
  // re-runs on it).
  useEffect(() => {
    if (relay === 'publish') publishToMain({ type: 'state', region, workspaceId, state });
  }, [region, relay, state, workspaceId]);

  // A consumer listens for as long as it is mounted, whether or not it has
  // dialled a socket of its own. That overlap is what makes every hand-over
  // safe: whichever side takes over starts with an answer naming every topic
  // (its own socket's `initial`, or the publisher's), and nothing is missed
  // while the other is still delivering.
  useEffect(() => {
    if (relay !== 'consume') return;
    const bridge = desktopBridge();
    let stopped = false;
    let revision = -1;
    const observe = (snapshot: WorkspaceSyncSourceSnapshot): void => {
      if (stopped || snapshot.revision <= revision) return;
      revision = snapshot.revision;
      setRelaySnapshot(snapshot);
    };
    const stop = bridge.onWorkspaceSyncRelayed((event) => {
      if (event.type === 'source') {
        observe(event);
        return;
      }
      if (!sameWorkspaceSyncIdentity(event, { region, workspaceId })) return;
      if (event.type === 'conversation_view_response') {
        const answer = event.event;
        const request = conversationViewRequests.current.get(answer.requestId);
        if (request && request.parentId === answer.parentId && request.substreamId === answer.substreamId) {
          conversationViewRequests.current.delete(answer.requestId);
          completeRelayedConversationViewRef.current(answer.requestId);
          request.receive(answer);
        }
        return;
      }
      if (event.type !== 'topics') return;
      const topics = event.topics.filter((topic): topic is WorkspaceSyncTopic => topic !== 'usage');
      setTopicWaterlines((current) => withTopicWaterline(current, topics, event.waterline));
      if (topics.length < event.topics.length) {
        void queryClient.invalidateQueries({ queryKey: organizationUsageQueryKey(localCacheScope) });
      }
      // The directory is socket-owned and a consumer holds none; asking its
      // query to refetch would ask a socket this window does not have.
      for (const topic of topics) {
        if (topic !== 'workstream_directory') invalidateTopic(queryClient, topic);
      }
    });
    void bridge.getWorkspaceSyncSource().then(observe, (error: unknown) => {
      // Unanswerable is treated as nobody publishing: the window falls back
      // to the socket it would have had anyway.
      logWarn('rally', 'could not read the organization sync source', error);
      observe({ revision: 0, source: null });
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [localCacheScope, queryClient, region, relay, workspaceId]);

  const listWorkstreams = useCallback<WorkspaceSocketContextValue['listWorkstreams']>(
    (input) => listWorkstreamsRef.current(input),
    [],
  );
  const setForegroundWorkstreamId = useCallback((workstreamId: string | null): void => {
    const parsed = WorkstreamIdSchema.safeParse(workstreamId);
    const validatedWorkstreamId = parsed.success ? parsed.data : null;
    if (foregroundWorkstreamIdRef.current === validatedWorkstreamId) return;
    foregroundWorkstreamIdRef.current = validatedWorkstreamId;
    // Presence snapshots are valid only for the foreground route and live
    // transport that received them. Never paint a prior visit while the next
    // canonical socket frame is in flight.
    setPresenceUserIdsByWorkstream({});
    reportPresenceRef.current();
    // The prefetch asks for the Channel in front first when its rail is stale.
    scheduleRailPrefetchRef.current();
  }, []);
  const refreshChannelRails = useCallback(
    (workstreamIds: readonly string[]): Promise<void> => refreshChannelRailsRef.current(workstreamIds),
    [],
  );
  const walkSpaceChannels = useCallback(
    (signal?: AbortSignal): Promise<Set<string> | null> => walkSpaceChannelsRef.current(signal),
    [],
  );
  const prioritizeSpace = useCallback((spaceId: string | null): void => {
    prioritySpaceIdRef.current = spaceId;
    if (spaceId !== null) walkSpaceNowRef.current(spaceId);
  }, []);
  const exposedState: WorkspaceSocketState = ownSocket ? state : relayedState;
  const value = useMemo(
    () => ({
      state: exposedState,
      topicWaterlines,
      presenceUserIdsByWorkstream,
      setForegroundWorkstreamId,
      listWorkstreams,
      sidebarConnect,
      walkSpaceChannels,
      prioritizeSpace,
      loadedSpaceIds,
      refreshChannelRails,
      requestConversationView,
    }),
    [
      listWorkstreams,
      loadedSpaceIds,
      prioritizeSpace,
      walkSpaceChannels,
      refreshChannelRails,
      requestConversationView,
      presenceUserIdsByWorkstream,
      setForegroundWorkstreamId,
      sidebarConnect,
      exposedState,
      topicWaterlines,
    ],
  );
  return <WorkspaceSocketContext.Provider value={value}>{children}</WorkspaceSocketContext.Provider>;
}

export function useWorkspaceSocket(): WorkspaceSocketContextValue {
  const context = useContext(WorkspaceSocketContext);
  if (!context) throw new Error('useWorkspaceSocket must be used inside WorkspaceSocketProvider');
  return context;
}

/** Test/embedding escape hatch; product windows always install the provider. */
export function useOptionalWorkspaceSocket(): WorkspaceSocketContextValue | null {
  return useContext(WorkspaceSocketContext);
}
