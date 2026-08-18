import {
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceSocketSyncEventSchema,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  WorkstreamSocketCommandResultSchema,
  type WorkspaceSocketClientEvent,
  type WorkspaceSyncTopic,
} from '@avalon/contracts';
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
import { ApiError, mapMessage, mapWorkstreamSummary, type AvalonApi } from './api';
import { uuidV7 } from './telemetry';
import type { Message, WorkstreamSummary } from './types';
import {
  applyVersionedWorkstreamState,
  applyWorkspaceWorkstreamFields,
  workstreamSummaryState,
} from './workstream-state-store';
import { WORKSTREAMS_QUERY_KEY } from './workstreams-cache';

type CreateMessageCommand = Extract<WorkspaceSocketClientEvent, { type: 'create_message' }>;
type ListWorkstreamsCommand = Extract<WorkspaceSocketClientEvent, { type: 'list_workstreams' }>;
type WorkspaceSocketApi = Pick<AvalonApi, 'getWorkspaceSocketTicket'>;
export type WorkspaceSocketState = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

interface PendingCommand {
  command: CreateMessageCommand;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timeout: number;
}

interface PendingWorkstreamPage {
  command: ListWorkstreamsCommand;
  resolve: (page: { items: WorkstreamSummary[]; nextCursor: string | null }) => void;
  reject: (error: Error) => void;
  timeout: number;
}

interface WorkspaceSocketContextValue {
  state: WorkspaceSocketState;
  topicWaterlines: Readonly<Partial<Record<WorkspaceSyncTopic, number>>>;
  createMessage(command: CreateMessageCommand): Promise<Message>;
  listWorkstreams(input: {
    limit: number;
    before?: string;
    includeSystem: boolean;
  }): Promise<{ items: WorkstreamSummary[]; nextCursor: string | null }>;
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
    workspace_profile: [['workspace'], ['workspace-onboarding']],
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
    automations: [['automations'], ['automation'], ['automation-draft']],
    notes: [['notes'], ['note']],
    resources: [['resources'], ['workstream-context']],
    activity: [['work-opportunities']],
    work_opportunities: [['work-opportunities']],
    workstream_directory: [WORKSTREAMS_QUERY_KEY],
    viewer_preferences: [['telemetry-preference'], ['block-dashboard-preference']],
    feature_flags: [['feature-flags']],
  };
  for (const queryKey of roots[topic]) void queryClient.invalidateQueries({ queryKey });
}

/** One persistent Electron connection to the current workspace's WorkspaceDO. */
export function WorkspaceSocketProvider({
  api,
  children,
  workspaceId,
}: PropsWithChildren<{ api: WorkspaceSocketApi; workspaceId: string }>): React.JSX.Element {
  const queryClient = useQueryClient();
  const [state, setState] = useState<WorkspaceSocketState>('connecting');
  const [topicWaterlines, setTopicWaterlines] = useState<Partial<Record<WorkspaceSyncTopic, number>>>({});
  const createMessageRef = useRef<(command: CreateMessageCommand) => Promise<Message>>(
    () => Promise.reject(new ApiError(
      'The workspace is not connected.',
      409,
      'workspace_socket_unavailable',
    )),
  );
  const listWorkstreamsRef = useRef<WorkspaceSocketContextValue['listWorkstreams']>(
    () => Promise.reject(new ApiError(
      'The workspace is not connected.',
      409,
      'workspace_socket_unavailable',
    )),
  );

  useEffect(() => {
    let stopped = false;
    let accessRevoked = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let connecting = false;
    let attempt = 0;
    let lastWaterline = -1;
    const pending = new Map<string, PendingCommand>();
    const pendingWorkstreamPages = new Map<string, PendingWorkstreamPage>();

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
          if (!stopped && socket === target && target.readyState === WebSocket.OPEN) target.close();
        }, PONG_TIMEOUT_MS);
      }, HEARTBEAT_MS);
    };
    const sendPending = (): void => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      for (const entry of pending.values()) socket.send(JSON.stringify(entry.command));
      for (const entry of pendingWorkstreamPages.values()) socket.send(JSON.stringify(entry.command));
    };
    const rejectPending = (error: Error): void => {
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timeout);
        entry.reject(error);
      }
      pending.clear();
      for (const entry of pendingWorkstreamPages.values()) {
        window.clearTimeout(entry.timeout);
        entry.reject(error);
      }
      pendingWorkstreamPages.clear();
    };
    const scheduleReconnect = (): void => {
      if (stopped || accessRevoked || reconnectTimer !== null) return;
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
      if (stopped || accessRevoked || connecting) return;
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
        const next = new WebSocket(ticket.url, ticket.protocols);
        socket = next;
        next.addEventListener('open', () => {
          if (stopped || socket !== next) return;
          attempt = 0;
          setState('connected');
          next.send(JSON.stringify({
            type: 'subscribe',
            afterWaterline: Math.max(0, lastWaterline),
          }));
          // Work-stream state pushes intentionally carry only the latest row,
          // not a replay log. A reconnect therefore reloads any directory that
          // was already resident; per-row waterlines discard an older page if
          // the direct WorkstreamDO socket has advanced the shared cache.
          if (queryClient.getQueryData(WORKSTREAMS_QUERY_KEY) !== undefined) {
            void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
          }
          sendPending();
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
            if (sync.data.waterline <= lastWaterline) return;
            lastWaterline = sync.data.waterline;
            setTopicWaterlines((current) => {
              const nextWaterlines = { ...current };
              for (const topic of sync.data.topics) nextWaterlines[topic] = sync.data.waterline;
              return nextWaterlines;
            });
            for (const topic of sync.data.topics) invalidateTopic(queryClient, topic);
            return;
          }
          const workstreamPage = WorkspaceWorkstreamPageEventSchema.safeParse(decoded);
          if (workstreamPage.success) {
            const entry = pendingWorkstreamPages.get(workstreamPage.data.requestId);
            if (!entry) return;
            pendingWorkstreamPages.delete(workstreamPage.data.requestId);
            window.clearTimeout(entry.timeout);
            const versions = new Map(workstreamPage.data.stateVersions.map((version) => [
              version.workstreamId,
              version,
            ]));
            const items = workstreamPage.data.items.map(mapWorkstreamSummary).map((workstream) => {
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
              }, workstreamPage.data.directoryWaterline);
              return queryClient.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY)
                ?.find((item) => item.id === workstream.id) ?? workstream;
            });
            entry.resolve({
              items,
              nextCursor: workstreamPage.data.nextCursor,
            });
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
          const result = WorkstreamSocketCommandResultSchema.safeParse(decoded);
          if (!result.success) return;
          const entry = pending.get(result.data.clientMessageId);
          if (!entry) return;
          pending.delete(result.data.clientMessageId);
          window.clearTimeout(entry.timeout);
          if (result.data.type === 'client_command_succeeded') {
            entry.resolve(mapMessage(result.data.message));
          } else {
            entry.reject(new ApiError(
              result.data.error.message,
              result.data.error.status,
              result.data.error.code,
              result.data.error.details,
            ));
          }
        });
        next.addEventListener('close', (event) => {
          if (socket !== next) return;
          clearHeartbeat();
          socket = null;
          if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            accessRevoked = true;
            setState('unavailable');
            rejectPending(new ApiError(
              'You can no longer access this workspace.',
              403,
              'workspace_access_revoked',
            ));
            return;
          }
          scheduleReconnect();
        });
        next.addEventListener('error', () => next.close());
      } catch {
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    };

    createMessageRef.current = (command): Promise<Message> => new Promise((resolve, reject) => {
      const clientMessageId = command.payload.clientMessageId;
      const timeout = window.setTimeout(() => {
        pending.delete(clientMessageId);
        reject(new ApiError(
          'The message could not be confirmed. Try sending it again.',
          0,
          'workspace_socket_command_timeout',
        ));
      }, COMMAND_TIMEOUT_MS);
      pending.set(clientMessageId, { command, resolve, reject, timeout });
      sendPending();
      void connect();
    });
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
        pendingWorkstreamPages.delete(requestId);
        reject(new ApiError(
          'The work-stream directory could not be loaded. Try again.',
          0,
          'workspace_directory_timeout',
        ));
      }, COMMAND_TIMEOUT_MS);
      pendingWorkstreamPages.set(requestId, { command, resolve, reject, timeout });
      sendPending();
      void connect();
    });

    const online = (): void => {
      clearReconnect();
      void connect();
    };
    const offline = (): void => {
      clearReconnect();
      clearHeartbeat();
      setState('unavailable');
      socket?.close();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    void connect();
    return () => {
      stopped = true;
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The workspace is no longer connected.',
        409,
        'workspace_socket_closed',
      ));
      listWorkstreamsRef.current = () => Promise.reject(new ApiError(
        'The workspace is no longer connected.',
        409,
        'workspace_socket_closed',
      ));
      rejectPending(new ApiError(
        'The workspace closed before the message was confirmed.',
        409,
        'workspace_socket_closed',
      ));
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      clearReconnect();
      clearHeartbeat();
      socket?.close();
    };
  }, [api, queryClient, workspaceId]);

  const createMessage = useCallback(
    (command: CreateMessageCommand): Promise<Message> => createMessageRef.current(command),
    [],
  );
  const listWorkstreams = useCallback<WorkspaceSocketContextValue['listWorkstreams']>(
    (input) => listWorkstreamsRef.current(input),
    [],
  );
  const value = useMemo(
    () => ({ state, topicWaterlines, createMessage, listWorkstreams }),
    [createMessage, listWorkstreams, state, topicWaterlines],
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
