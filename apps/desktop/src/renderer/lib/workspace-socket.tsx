import { WorkspaceConversationViewEventSchema, type WorkspaceConversationViewEvent } from '@rally/contracts/conversation-view';
import {
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceActivityListEventSchema,
  WorkspaceCanvasListEventSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspacePresenceEventSchema,
  WorkspaceResourceVersionsEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkstreamIdSchema,
  type Region,
  type WorkstreamId,
  type WorkspaceSidebar,
  type WorkspaceSocketClientEvent,
  type WorkspaceSyncTopic,
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
import { mapAutomationSummary, type RallyApi } from './api';
import { retainConversationParents } from './conversation-cache';
import { useLocalCacheScope } from './local-cache-scope';
import { applyPushedOrganizationUsage, organizationUsageQueryKey } from './organization-usage';
import { desktopBridge } from './platform';
import { SIDEBAR_LIST_QUERY_KEYS, applyVersionedSidebarList } from './sidebar-list-store';
import { applyResourceHeads, followResourceHeads } from './resource-heads';
import { realtimeSocketTelemetry } from './socket-telemetry';
import { reportTelemetryProductIntent, telemetryJourneyDuration, uuidV7 } from './telemetry';
import { CLIENT_FEATURE_FLAGS_QUERY_KEY } from './use-client-feature-flags';
import { memberPreferencesQueryKey } from './use-member-preferences';
import { hydrateCanvasDirectory, mirrorCanvasDirectory } from './canvas-directory-cache';
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

type WorkspaceSocketApi = Pick<RallyApi, 'getWorkspaceSocketTicket'> & Partial<Pick<RallyApi, 'confirmSocketTicket'>>;
export type WorkspaceSocketState = WorkspaceSyncConnectionState;

/**
 * How a window takes part in the Organization-sync relay.
 *
 * - `publish`: the main window. It holds the socket and tells main what it
 *   hears — its connection state and each topic change — and detaches when
 *   it unmounts with no successor.
 * - `consume`: the Settings window. It holds no socket while main reports any
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

/**
 * What the last connect payload established. `generation` counts payloads
 * rather than identifying one: a surface needs to know that a *new* sidebar
 * arrived, not which.
 */
export interface SidebarConnect {
  generation: number;
}

interface WorkspaceSocketContextValue {
  requestConversationView(parentId: string, substreamId: string,
    receive: (event: WorkspaceConversationViewEvent) => void): () => void;
  state: WorkspaceSocketState;
  topicWaterlines: Readonly<Partial<Record<WorkspaceSyncTopic, number>>>;
  presenceUserIdsByWorkstream: Readonly<Record<string, readonly string[]>>;
  setForegroundWorkstreamId(workstreamId: string | null): void;
  /** The last sidebar the server sent unasked, or null before the first one. */
  sidebarConnect: SidebarConnect | null;
  /**
   * Mark all seen: every Activity item recorded until now. Answered by the
   * Activity push; sent only on a subscribed socket this window holds, and a
   * no-op while it has none.
   */
  markAllActivitySeen(): void;
  /**
   * Dial again now rather than at the next backoff step, for a person looking
   * at a list the socket has not delivered. A no-op on an open socket and in a
   * window that relays another window's socket.
   */
  retry(): void;
}

const WorkspaceSocketContext = createContext<WorkspaceSocketContextValue | null>(null);


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
    // The lists themselves are pushed whole by WorkspaceDO, so the topic no
    // longer names them — it carries REST details and the broader Sidekick library.
    automations: [
      ['automation'], ['automation-draft'], ['automation-runs'], ['sidekicks-library'],
    ],
    resources: [['resources'], ['workstream-context']],
    viewer_preferences: [['telemetry-preference'], ['member-preferences']],
    feature_flags: [['feature-flags']],
  };
  for (const queryKey of roots[topic]) void queryClient.invalidateQueries({ queryKey });
}

/**
 * Merge one event's topics into the per-topic waterlines a surface observes.
 *
 * With `authoritative`, for the answer to a socket's `subscribe`, the answer
 * sets the ledger rather than raising it: no topic stays above the object's
 * position now, and every topic it names takes that position. After an object
 * whose log went back, a max would leave the ledger where it was, and a
 * surface keyed on a topic's waterline would never run again for it.
 */
function withTopicWaterline(
  current: Partial<Record<WorkspaceSyncTopic, number>>,
  topics: readonly WorkspaceSyncTopic[],
  waterline: number,
  { authoritative = false }: { authoritative?: boolean } = {},
): Partial<Record<WorkspaceSyncTopic, number>> {
  const next = { ...current };
  if (authoritative) {
    for (const topic of Object.keys(next) as WorkspaceSyncTopic[]) next[topic] = Math.min(next[topic] ?? 0, waterline);
    for (const topic of topics) next[topic] = waterline;
    return next;
  }
  for (const topic of topics) next[topic] = Math.max(waterline, next[topic] ?? 0);
  return next;
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
  const markAllActivitySeenRef = useRef<() => void>(() => undefined);
  const markAllActivitySeen = useCallback((): void => markAllActivitySeenRef.current(), []);
  const retryRef = useRef<() => void>(() => undefined);
  const retry = useCallback((): void => retryRef.current(), []);

  useEffect(() => {
    if (!ownSocket) return;
    const releaseData = retainQueryData(queryClient, [
      SIDEBAR_LIST_QUERY_KEYS.automations, SIDEBAR_LIST_QUERY_KEYS.canvases, SIDEBAR_LIST_QUERY_KEYS.activity,
      CLIENT_FEATURE_FLAGS_QUERY_KEY,
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
    let subscribed = false;
    /** Whether any socket of this provider has had its `subscribe` answered. */
    let hadSubscribed = false;
    let conversationViewsAvailable = false;
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
    markAllActivitySeenRef.current = () => {
      if (!subscribed || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'activity_mark_all_seen' } satisfies WorkspaceSocketClientEvent));
    };
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
     * The Sidekick list moved: the surfaces it feeds refetch. The change that
     * matters most to an open automation page is one the page cannot see
     * otherwise: its chat submitting a revision, or a run finishing. No HTTP
     * request of the desktop's is in play then, so no sync topic follows; the
     * list is the one signal, whether it came as a push or, for one missed
     * while the socket was away, in the answer to the next `subscribe`.
     */
    const sidekickListMoved = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['automation'] });
      void queryClient.invalidateQueries({ queryKey: ['automation-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['sidekicks-library'] });
      // Relayed as the `automations` topic it amounts to, so a consuming
      // window that reads these surfaces and not the list hears it without a
      // socket of its own.
      publishTopics(['automations'], Math.max(lastWaterline, 0));
    };
    /**
     * The sidebar rides on the answer to `subscribe`: the Sidekicks list, the
     * Canvases list and the Activity page, each applied through the versioned
     * receiver so a later push and this payload are ordered against one
     * ledger. The answer is authoritative over that ledger: it is what the
     * object holds now, read after every push an earlier socket delivered.
     */
    const applyConnectedSidebar = (sidebar: WorkspaceSidebar): void => {
      const authoritative = { authoritative: true };
      const sidekicksMoved = applyVersionedSidebarList(
        queryClient,
        'automations',
        sidebar.automations.waterline,
        sidebar.automations.items.map(mapAutomationSummary),
        authoritative,
      );
      if (sidebar.canvases) {
        applyVersionedSidebarList(queryClient, 'canvases', sidebar.canvases.waterline, sidebar.canvases.items, authoritative);
      }
      if (sidebar.activity) {
        applyVersionedSidebarList(queryClient, 'activity', sidebar.activity.waterline,
          { unseenCount: sidebar.activity.unseenCount, items: sidebar.activity.items }, authoritative);
      }
      // A reconnect's answer that moved the list stands in for the pushes the
      // socket missed while it was away. The first answer this window hears
      // has nothing to stand in for: whatever it loaded, it loaded just now.
      if (sidekicksMoved && hadSubscribed) sidekickListMoved();
      // The lists are the bound on the conversation cache: a conversation
      // stays on disk for as long as its Canvas or Sidekick is listed.
      if (localCacheScope !== null) {
        void retainConversationParents(localCacheScope, new Set([
          ...sidebar.automations.items.map((automation) => automation.id),
          ...(sidebar.canvases?.items ?? []).map((canvas) => canvas.id),
        ]));
      }
      setSidebarConnect((current) => ({ generation: (current?.generation ?? 0) + 1 }));
    };
    /** What every end of a socket's life resets, whoever ended it. */
    const releaseSocket = (): void => {
      clearSocketTimers();
      subscribed = false;
      conversationViewsAvailable = false;
      socket = null;
      setPresenceUserIdsByWorkstream({});
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
    retryRef.current = () => {
      if (stopped || permanentlyClosed || socket?.readyState === WebSocket.OPEN) return;
      suspended = false;
      clearReconnect();
      void connect();
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
          setState('connected');
          next.send(JSON.stringify({
            type: 'subscribe',
            afterWaterline: Math.max(0, lastWaterline),
            diagnosticAttemptId,
          }));
          reportHandshake(diagnosticAttemptId, 'subscribe_sent');
          // Subscribing is answered with the whole sidebar, so a reconnect
          // reconverges from that payload rather than from a refetch.
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
            // The first sync on a socket is the answer to its `subscribe`:
            // the object sends nothing else to a socket until it has answered.
            const answersSubscribe = !subscribed;
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
            if (sync.data.sidebar) applyConnectedSidebar(sync.data.sidebar);
            // A plan-change push is not replayed: an open meter reads again.
            if (sync.data.sidebar) {
              void queryClient.invalidateQueries({ queryKey: organizationUsageQueryKey(localCacheScope) });
              publishTopics(['usage'], Math.max(lastWaterline, sync.data.waterline));
            }
            if (answersSubscribe) hadSubscribed = true;
            if (sync.data.sidebar && !firstSidebarApplied) {
              firstSidebarApplied = true;
              if (syncTimer !== null) window.clearTimeout(syncTimer);
              syncTimer = null;
              attempt = 0;
              reportHandshake(diagnosticAttemptId, 'sync_applied');
              api.confirmSocketTicket?.(ticket);
            }
            // The answer, like its sidebar, is the object's position now. One
            // below what this window holds means the object's log went back,
            // and keeping the old cursor would drop every live event until
            // the log climbed past it, and ask the next resume for history
            // the object never had.
            if (!answersSubscribe && sync.data.waterline <= lastWaterline) return;
            const moved = sync.data.waterline !== lastWaterline;
            lastWaterline = sync.data.waterline;
            if (!moved && sync.data.topics.length === 0) return;
            setTopicWaterlines((current) => withTopicWaterline(current, sync.data.topics, sync.data.waterline,
              { authoritative: answersSubscribe }));
            // Every topic, `initial` and `history_unavailable` included: those
            // name everything because this socket cannot say what moved while
            // it was away, and neither can a window relying on it.
            if (sync.data.topics.length > 0) publishTopics(sync.data.topics, sync.data.waterline);
            for (const topic of sync.data.topics) invalidateTopic(queryClient, topic);
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
          const canvasList = safeParseSocketEvent(WorkspaceCanvasListEventSchema, decoded);
          if (canvasList.success) {
            applyVersionedSidebarList(queryClient, 'canvases', canvasList.data.waterline, canvasList.data.items);
            return;
          }
          const activityList = safeParseSocketEvent(WorkspaceActivityListEventSchema, decoded);
          if (activityList.success) {
            applyVersionedSidebarList(queryClient, 'activity', activityList.data.waterline,
              { unseenCount: activityList.data.unseenCount, items: activityList.data.items });
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
              // Pushed whenever an automation's own row changes.
              sidekickListMoved();
            }
            return;
          }
          const usage = safeParseSocketEvent(WorkspaceUsageEventSchema, decoded);
          if (usage.success) {
            // A plan change moved the Organization's quota and overage.
            applyPushedOrganizationUsage(queryClient, localCacheScope, usage.data.usage);
            publishTopics(['usage'], lastWaterline);
            return;
          }
          const resourceVersions = safeParseSocketEvent(WorkspaceResourceVersionsEventSchema, decoded);
          if (resourceVersions.success) {
            // A resource some conversation holds has a new version: every
            // preview open on it moves to the new head.
            applyResourceHeads(queryClient, resourceVersions.data.resources);
            return;
          }
          // Nothing above claimed this message, and until now that ended the
          // handler in silence. A message whose `type` no schema here knows is
          // the ordinary forward-compatible case and stays silent; one whose
          // `type` a schema *did* match and whose body it then rejected is a
          // contract skew between two of our own components, and dropping it
          // without a word is how a desktop built ahead of its API would show
          // an empty sidebar with nothing anywhere saying why.
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
              ['workspace_canvas_list', 'canvas list', canvasList],
              ['workspace_activity_list', 'activity list', activityList],
              ['workspace_sidebar_list', 'sidebar list', sidebarList],
              ['workspace_resource_versions', 'resource versions', resourceVersions],
              ['workspace_usage', 'usage', usage],
            ],
          );
        });
        next.addEventListener('close', (event) => {
          if (socket !== next) return;
          releaseSocket();
          const accessRevoked = event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE;
          const permanent = accessRevoked
            || event.code === WORKSPACE_SOCKET_SESSION_INACTIVE_CODE
            || event.code === WORKSPACE_SOCKET_INVALID_MESSAGE_CODE;
          if (permanent) {
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
    const canvasCacheMirror = localCacheScope === null ? null : mirrorCanvasDirectory(queryClient, localCacheScope);
    if (localCacheScope !== null) void hydrateCanvasDirectory(queryClient, localCacheScope, () => !stopped);
    void connect();
    return () => {
      stopped = true;
      canvasCacheMirror?.stop();
      releaseData();
      sendConversationViewRequestsRef.current = () => undefined;
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      stopPowerState();
      window.removeEventListener('focus', observeWindowFocus);
      window.removeEventListener('blur', observeWindowFocus);
      document.removeEventListener('visibilitychange', observeWindowFocus);
      stopApplicationFocus();
      reportPresenceRef.current = () => undefined;
      markAllActivitySeenRef.current = () => undefined;
      retryRef.current = () => undefined;
      clearReconnect();
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      const retired = socket;
      releaseSocket();
      retired?.close();
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
      for (const topic of topics) invalidateTopic(queryClient, topic);
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
  }, []);
  const exposedState: WorkspaceSocketState = ownSocket ? state : relayedState;
  const value = useMemo(
    () => ({
      state: exposedState,
      topicWaterlines,
      presenceUserIdsByWorkstream,
      setForegroundWorkstreamId,
      sidebarConnect,
      requestConversationView,
      markAllActivitySeen,
      retry,
    }),
    [
      markAllActivitySeen,
      retry,
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
