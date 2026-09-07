import {
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceProjectSnapshotEventSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspacePresenceEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  WorkstreamIdSchema,
  type WorkstreamId,
  type WorkspaceSidebar,
  type WorkspaceSocketClientEvent,
  type WorkspaceSyncTopic,
  type WorkspaceWorkstreamPageEvent,
} from '@rally/contracts';
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
import { uuidV7 } from './telemetry';
import { desktopBridge } from './platform';
import { CLIENT_FEATURE_FLAGS_QUERY_KEY } from './use-client-feature-flags';
import type { WorkstreamSummary } from './types';
import {
  applyVersionedWorkstreamState,
  applyWorkspaceWorkstreamFields,
  workstreamSummaryState,
} from './workstream-state-store';
import {
  applyVersionedNotePage,
  applyVersionedProjectSnapshot,
  applyVersionedSidebarList,
} from './sidebar-list-store';
import { realtimeSocketTelemetry } from './socket-telemetry';
import { mergeCachedWorkstreamPage, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

type ListWorkstreamsCommand = Extract<WorkspaceSocketClientEvent, { type: 'list_workstreams' }>;
type WorkspaceSocketApi = Pick<RallyApi, 'getWorkspaceSocketTicket'>;
export type WorkspaceSocketState = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

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
  /** The note list's own next page, tracked separately: two lists, two cursors. */
  notesNextCursor: string | null;
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
}

const WorkspaceSocketContext = createContext<WorkspaceSocketContextValue | null>(null);
const HEARTBEAT_MS = 50_000;
const PONG_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 120_000;

function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

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
      ['connector-catalog'],
      ['github-repository-access'],
      ['workspace-onboarding'],
    ],
    connector_oauth_attempts: [],
    terminal_policy: [['terminal-workspace-settings']],
    digest_schedule: [['digest-schedule']],
    // The lists themselves are pushed whole by WorkspaceDO, so the topic no
    // longer names them — it carries the detail surfaces REST still serves.
    automations: [['automation'], ['automation-draft']],
    notes: [['note']],
    // Project state is carried by the connect snapshot and every later project
    // push. This legacy topic can arrive during rolling deployment, but it must
    // never turn the socket into news followed by a REST read.
    projects: [],
    resources: [['resources'], ['workstream-context']],
    activity: [['work-opportunities']],
    work_opportunities: [['work-opportunities']],
    workstream_directory: [WORKSTREAMS_QUERY_KEY],
    viewer_preferences: [['telemetry-preference']],
    feature_flags: [['feature-flags']],
  };
  for (const queryKey of roots[topic]) void queryClient.invalidateQueries({ queryKey });
}

/**
 * Write one directory page into the shared caches and return its rows.
 *
 * Shared by the paged answer and the sidebar batch, which carry the same page
 * body and must land in the ledger the same way: a row is only as fresh as its
 * own common/viewer waterline, so the cached copy wins whenever it is newer
 * than the page that just arrived. Returning the cached row rather than the
 * one off the wire is what keeps a page from walking back a state the direct
 * WorkstreamDO socket already advanced.
 */
function applyDirectoryPage(
  queryClient: ReturnType<typeof useQueryClient>,
  page: Pick<WorkspaceWorkstreamPageEvent, 'items' | 'stateVersions' | 'directoryWaterline' | 'nextCursor'>,
): WorkstreamPage {
  const versions = new Map(page.stateVersions.map((version) => [version.workstreamId, version]));
  const items = page.items.map(mapWorkstreamSummary).map((workstream) => {
    const version = versions.get(workstream.id);
    if (!version) return workstream;
    applyVersionedWorkstreamState(queryClient, {
      workstreamId: workstream.id,
      stateVersion: version,
      ...workstreamSummaryState(workstream),
      visible: true,
    });
    applyWorkspaceWorkstreamFields(queryClient, workstream.id, {
      pinPosition: workstream.pinPosition,
    }, page.directoryWaterline);
    return queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
      ?.find((item) => item.id === workstream.id) ?? workstream;
  });
  return { items, nextCursor: page.nextCursor };
}

/** One persistent Electron connection to the current workspace's WorkspaceDO. */
export function WorkspaceSocketProvider({
  api,
  children,
  onAccessRevoked,
  workspaceId,
}: PropsWithChildren<{
  api: WorkspaceSocketApi;
  onAccessRevoked?: () => void;
  workspaceId: string;
}>): React.JSX.Element {
  const queryClient = useQueryClient();
  const [state, setState] = useState<WorkspaceSocketState>('connecting');
  const [topicWaterlines, setTopicWaterlines] = useState<Partial<Record<WorkspaceSyncTopic, number>>>({});
  const [sidebarConnect, setSidebarConnect] = useState<SidebarConnect | null>(null);
  const [presenceUserIdsByWorkstream, setPresenceUserIdsByWorkstream] = useState<Record<string, readonly string[]>>({});
  const foregroundWorkstreamIdRef = useRef<WorkstreamId | null>(null);
  const reportPresenceRef = useRef<() => void>(() => undefined);
  const listWorkstreamsRef = useRef<WorkspaceSocketContextValue['listWorkstreams']>(
    () => Promise.reject(new ApiError(
      'The workspace is not connected.',
      409,
      'workspace_socket_unavailable',
    )),
  );

  useEffect(() => {
    let stopped = false;
    let permanentlyClosed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let connecting = false;
    let attempt = 0;
    const socketTelemetry = realtimeSocketTelemetry('workspace');
    const isOffline = (): boolean => navigator.onLine === false;
    let lastWaterline = -1;
    let presenceRevision = 0;
    const pendingDirectoryRequests = new Map<string, PendingDirectoryRequest>();
    let subscribed = false;
    let applicationForegrounded = false;
    let applicationFocusObservation = 0;
    let windowForegrounded = document.visibilityState === 'visible' && document.hasFocus();

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
    const initialApplicationFocusObservation = applicationFocusObservation;
    void bridge.getApplicationForegroundState().then((foregrounded) => {
      if (stopped || applicationFocusObservation !== initialApplicationFocusObservation) return;
      applicationForegrounded = foregrounded;
      sendPresence();
    }).catch(() => undefined);
    const stopApplicationFocus = bridge.onApplicationForegroundChanged((foregrounded) => {
      applicationFocusObservation += 1;
      applicationForegrounded = foregrounded;
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
    const clearHeartbeat = (): void => {
      if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
      if (pongTimer !== null) window.clearTimeout(pongTimer);
      heartbeatTimer = null;
      pongTimer = null;
    };
    const scheduleHeartbeat = (target: WebSocket): void => {
      clearHeartbeat();
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null;
        if (stopped || socket !== target || target.readyState !== WebSocket.OPEN) return;
        target.send('ping');
        pongTimer = window.setTimeout(() => {
          pongTimer = null;
          if (stopped || socket !== target || target.readyState !== WebSocket.OPEN) return;
          socketTelemetry.willClose('heartbeat_timeout');
          target.close();
        }, PONG_TIMEOUT_MS);
      }, HEARTBEAT_MS);
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
      const page = applyDirectoryPage(queryClient, sidebar.workstreams);
      const returned = new Set(page.items.map((workstream) => workstream.id));
      const unaccountedFor = (queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [])
        .some((workstream) => !returned.has(workstream.id));
      const wholeDirectory = page.nextCursor === null;
      if (wholeDirectory) setCachedWorkstreams(queryClient, () => page.items);
      else mergeCachedWorkstreamPage(queryClient, page.items);
      applyVersionedSidebarList(
        queryClient,
        'automations',
        sidebar.automations.waterline,
        sidebar.automations.items.map(mapAutomationSummary),
      );
      applyVersionedNotePage(
        queryClient,
        sidebar.notes.waterline,
        sidebar.notes.items,
        sidebar.notes.nextCursor,
      );
      if (sidebar.projects) applyVersionedProjectSnapshot(queryClient, sidebar.projects);
      setSidebarConnect((current) => ({
        generation: (current?.generation ?? 0) + 1,
        nextCursor: page.nextCursor,
        notesNextCursor: sidebar.notes.nextCursor ?? null,
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
    const scheduleReconnect = (): void => {
      if (stopped || permanentlyClosed || reconnectTimer !== null) return;
      if (navigator.onLine === false) {
        setState('unavailable');
        return;
      }
      attempt += 1;
      setState('reconnecting');
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, reconnectDelay(attempt));
    };
    const connect = async (): Promise<void> => {
      if (stopped || permanentlyClosed || connecting) return;
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
      if (navigator.onLine === false) {
        setState('unavailable');
        return;
      }
      connecting = true;
      clearReconnect();
      setState(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const ticket = await api.getWorkspaceSocketTicket();
        if (stopped) return;
        // Going offline while the ticket was in flight left the offline handler
        // nothing to close, so this is where that transition is noticed at all.
        // Dialling anyway would fail and be recorded as a transport error,
        // which is the one reading this event exists to keep apart from
        // "the desktop lost its network".
        if (isOffline()) {
          socketTelemetry.disconnected({ attempts: attempt, retrying: false, cause: 'offline' });
          setState('unavailable');
          return;
        }
        const next = new WebSocket(ticket.url, ticket.protocols);
        socket = next;
        next.addEventListener('open', () => {
          if (stopped || socket !== next) return;
          socketTelemetry.connected(attempt);
          attempt = 0;
          setState('connected');
          next.send(JSON.stringify({
            type: 'subscribe',
            afterWaterline: Math.max(0, lastWaterline),
          }));
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
          const sync = WorkspaceSocketSyncEventSchema.safeParse(decoded);
          if (sync.success) {
            if (!subscribed) {
              subscribed = true;
              sendPresence();
            }
            if (sync.data.featureFlags) {
              queryClient.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, sync.data.featureFlags);
              void desktopBridge().observeClientFeatureFlags(sync.data.featureFlags).catch(() => undefined);
            }
            // Before the waterline guard, not after. The sidebar rides on the
            // answer to `subscribe`, and a resume where no topic moved carries
            // the waterline the client already has — so a guard that ran first
            // would drop the state this event exists to deliver.
            const directoryNeedsReconciling = sync.data.sidebar
              ? applyConnectedSidebar(sync.data.sidebar)
              : false;
            if (sync.data.waterline <= lastWaterline) return;
            lastWaterline = sync.data.waterline;
            setTopicWaterlines((current) => {
              const nextWaterlines = { ...current };
              for (const topic of sync.data.topics) nextWaterlines[topic] = sync.data.waterline;
              return nextWaterlines;
            });
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
              invalidateTopic(queryClient, topic);
            }
            return;
          }
          const presence = WorkspacePresenceEventSchema.safeParse(decoded);
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
          const featureFlags = WorkspaceFeatureFlagsEventSchema.safeParse(decoded);
          if (featureFlags.success) {
            queryClient.setQueryData(CLIENT_FEATURE_FLAGS_QUERY_KEY, featureFlags.data.flags);
            void desktopBridge().observeClientFeatureFlags(featureFlags.data.flags).catch(() => undefined);
            return;
          }
          const workstreamPage = WorkspaceWorkstreamPageEventSchema.safeParse(decoded);
          if (workstreamPage.success) {
            const entry = pendingDirectoryRequests.get(workstreamPage.data.requestId);
            if (!entry) return;
            pendingDirectoryRequests.delete(workstreamPage.data.requestId);
            window.clearTimeout(entry.timeout);
            entry.resolve(applyDirectoryPage(queryClient, workstreamPage.data));
            return;
          }
          const workstreamState = WorkspaceWorkstreamStateEventSchema.safeParse(decoded);
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
            if (applied.commonApplied) {
              void queryClient.invalidateQueries({
                queryKey: ['terminal-workstream', workstreamState.data.workstreamId],
                exact: true,
              });
            }
            return;
          }
          const sidebarList = WorkspaceSidebarListEventSchema.safeParse(decoded);
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
            } else {
              applyVersionedNotePage(
                queryClient,
                sidebarList.data.waterline,
                sidebarList.data.items,
                sidebarList.data.nextCursor,
              );
            }
            return;
          }
          const projectSnapshot = WorkspaceProjectSnapshotEventSchema.safeParse(decoded);
          if (projectSnapshot.success) {
            applyVersionedProjectSnapshot(queryClient, projectSnapshot.data.projects);
            return;
          }
        });
        next.addEventListener('close', (event) => {
          if (socket !== next) return;
          clearHeartbeat();
          subscribed = false;
          socket = null;
          setPresenceUserIdsByWorkstream({});
          const accessRevoked = event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE;
          const permanentError = accessRevoked
            ? new ApiError(
              'You can no longer access this workspace.',
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
          socketTelemetry.willClose('transport_error');
          next.close();
        });
      } catch {
        if (!stopped) {
          socketTelemetry.disconnected({
            attempts: attempt,
            retrying: !isOffline(),
            cause: 'ticket_failed',
          });
        }
        scheduleReconnect();
      } finally {
        connecting = false;
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
          'The work-stream directory could not be loaded. Try again.',
          0,
          'workspace_directory_timeout',
        ));
      }, COMMAND_TIMEOUT_MS);
      pendingDirectoryRequests.set(requestId, { command, resolve, reject, timeout });
      sendPendingDirectoryRequests();
      void connect();
    });

    const online = (): void => {
      clearReconnect();
      void connect();
    };
    const offline = (): void => {
      clearReconnect();
      clearHeartbeat();
      if (socket) socketTelemetry.willClose('offline');
      setState('unavailable');
      setPresenceUserIdsByWorkstream({});
      rejectPendingDirectoryRequests(new ApiError(
        'The work-stream directory cannot be loaded while offline.',
        0,
        'workspace_directory_offline',
      ));
      socket?.close();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    void connect();
    return () => {
      stopped = true;
      listWorkstreamsRef.current = () => Promise.reject(new ApiError(
        'The workspace is no longer connected.',
        409,
        'workspace_socket_closed',
      ));
      rejectPendingDirectoryRequests(new ApiError(
        'The workspace closed while loading the directory.',
        409,
        'workspace_socket_closed',
      ));
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', observeWindowFocus);
      window.removeEventListener('blur', observeWindowFocus);
      document.removeEventListener('visibilitychange', observeWindowFocus);
      stopApplicationFocus();
      reportPresenceRef.current = () => undefined;
      subscribed = false;
      clearReconnect();
      clearHeartbeat();
      socket?.close();
    };
  }, [api, onAccessRevoked, queryClient, workspaceId]);

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
  }, []);
  const value = useMemo(
    () => ({
      state,
      topicWaterlines,
      presenceUserIdsByWorkstream,
      setForegroundWorkstreamId,
      listWorkstreams,
      sidebarConnect,
    }),
    [
      listWorkstreams,
      presenceUserIdsByWorkstream,
      setForegroundWorkstreamId,
      sidebarConnect,
      state,
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
