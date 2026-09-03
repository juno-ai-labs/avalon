import {
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamControlSocketEventSchema,
  type WorkstreamControlMetadata,
} from '@rally/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { logWarn } from '../../common/logger';
import { normalizeHarnessStatus, type RallyApi } from './api';
import type { WorkstreamSummary } from './types';
import { applyVersionedWorkstreamState } from './workstream-state-store';
import { realtimeSocketTelemetry, reportWorkstreamSocketStarted } from './socket-telemetry';
import {
  createRealtimeSocket,
  REALTIME_SOCKET_CONNECTING,
  REALTIME_SOCKET_OPEN,
  type RealtimeSocket,
} from './realtime-socket';
import {
  type WorkstreamSocketStartReason,
  uuidV7,
  workstreamFeedOpenAttemptId,
} from './telemetry';
import { evictCachedWorkstream } from './workstreams-cache';

type WorkstreamControlSocketApi = Pick<RallyApi, 'getWorkstreamControlSocketTicket'>;
const HEARTBEAT_MS = 50_000;
const PONG_TIMEOUT_MS = 15_000;

function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

function metadataState(metadata: WorkstreamControlMetadata): {
  common: Partial<WorkstreamSummary>;
  viewer: Partial<WorkstreamSummary>;
  seed: WorkstreamSummary;
} {
  const manual = metadata.viewer.manualUnreadFromSequenceNumber;
  const seen = metadata.viewer.readThroughSequenceNumber;
  const latest = metadata.latestAttentionSequenceNumber;
  const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
  const common: Partial<WorkstreamSummary> = {
    id: metadata.id,
    title: metadata.title,
    titleStatus: metadata.titleStatus,
    objective: metadata.description,
    // Full snapshots must overwrite nullable fields too. Omitting a field here
    // would preserve an old value after another client cleared it.
    emailAddress: metadata.emailAddress ?? undefined,
    origin: metadata.originType,
    createdByUserId: metadata.createdByUserId ?? undefined,
    automationSubscriptionId: metadata.automationSubscriptionId ?? undefined,
    automationRunId: metadata.automationRunId ?? undefined,
    plannedFor: metadata.plannedFor ?? undefined,
    harnessStatus: normalizeHarnessStatus(metadata.harnessStatus),
    latestAttentionSequenceNumber: latest,
    lastActivityAt: metadata.lastActivityAt,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    archivedAt: metadata.archivedAt ?? undefined,
    scope: metadata.scope,
    systemKind: metadata.systemKind ?? undefined,
    nextPendingWakeup: metadata.nextPendingWakeup,
    // The sidebar's subtitle is the standing description. `preview` is a
    // legacy WorkstreamDO field and is empty for newly created object-owned
    // work streams; letting the direct socket copy it here makes the subtitle
    // disappear only while that work stream is open.
    preview: metadata.description,
  };
  const viewer: Partial<WorkstreamSummary> = {
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: metadata.viewer.manualUnreadGeneration,
    hasUnread: firstUnread !== null,
    youAreMentioned: metadata.viewer.youAreMentioned,
    unseen: metadata.viewer.unseen,
    firstUnreadSequenceNumber: firstUnread,
  };
  return {
    common,
    viewer,
    seed: {
      id: metadata.id,
      title: metadata.title,
      titleStatus: metadata.titleStatus,
      objective: metadata.description,
      emailAddress: metadata.emailAddress ?? undefined,
      origin: metadata.originType,
      createdByUserId: metadata.createdByUserId ?? undefined,
      automationSubscriptionId: metadata.automationSubscriptionId ?? undefined,
      automationRunId: metadata.automationRunId ?? undefined,
      plannedFor: metadata.plannedFor ?? undefined,
      harnessStatus: normalizeHarnessStatus(metadata.harnessStatus),
      latestAttentionSequenceNumber: latest,
      readThroughSequenceNumber: seen,
      manualUnreadFromSequenceNumber: manual,
      manualUnreadGeneration: metadata.viewer.manualUnreadGeneration,
      hasUnread: firstUnread !== null,
      youAreMentioned: metadata.viewer.youAreMentioned,
      unseen: metadata.viewer.unseen,
      firstUnreadSequenceNumber: firstUnread,
      lastActivityAt: metadata.lastActivityAt,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archivedAt: metadata.archivedAt ?? undefined,
      scope: metadata.scope,
      systemKind: metadata.systemKind ?? undefined,
      nextPendingWakeup: metadata.nextPendingWakeup,
      pinPosition: null,
      participantUserIds: [],
      participantExtraCount: 0,
      preview: metadata.description,
    },
  };
}

/** Keep WorkstreamDO-owned metadata coherent independently of the agent feed. */
export function useWorkstreamControlSocket(
  api: WorkstreamControlSocketApi | null,
  workstreamId: string,
  enabled: boolean,
  initialReason: Exclude<WorkstreamSocketStartReason, 'reconnect'> = 'active_workstream',
  socketLeaseId?: string,
): void {
  const queryClient = useQueryClient();
  const [generatedSocketLeaseId] = useState(() => socketLeaseId ?? uuidV7());
  const resolvedSocketLeaseId = socketLeaseId ?? generatedSocketLeaseId;
  const initialReasonRef = useRef(initialReason);
  initialReasonRef.current = initialReason;
  useEffect(() => {
    if (!api || !enabled) return;
    let stopped = false;
    let accessRevoked = false;
    let socket: RealtimeSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let connecting = false;
    let attempt = 0;
    let startedOnce = false;
    let protocolWarningReported = false;
    const socketTelemetry = realtimeSocketTelemetry('workstream_control');
    const isOffline = (): boolean => navigator.onLine === false;

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
    const scheduleHeartbeat = (target: RealtimeSocket): void => {
      clearHeartbeat();
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null;
        if (stopped || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
        target.send('ping');
        pongTimer = window.setTimeout(() => {
          pongTimer = null;
          if (stopped || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
          socketTelemetry.willClose('heartbeat_timeout');
          target.close();
        }, PONG_TIMEOUT_MS);
      }, HEARTBEAT_MS);
    };
    const scheduleReconnect = (): void => {
      if (stopped || accessRevoked || reconnectTimer !== null) return;
      if (navigator.onLine === false) return;
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, reconnectDelay(attempt));
    };
    const applyMetadata = (metadata: WorkstreamControlMetadata): void => {
      if (metadata.id !== workstreamId) return;
      const state = metadataState(metadata);
      const applied = applyVersionedWorkstreamState(queryClient, {
        workstreamId,
        stateVersion: metadata.stateVersion,
        ...state,
        visible: metadata.viewer.listable,
      });
      if (applied.commonApplied) {
        void queryClient.invalidateQueries({ queryKey: ['terminal-workstream', workstreamId], exact: true });
      }
    };
    const connect = async (): Promise<void> => {
      if (stopped || accessRevoked || connecting) return;
      if (socket?.readyState === REALTIME_SOCKET_CONNECTING || socket?.readyState === REALTIME_SOCKET_OPEN) return;
      if (navigator.onLine === false) return;
      connecting = true;
      clearReconnect();
      const operationId = uuidV7();
      reportWorkstreamSocketStarted(
        workstreamId,
        resolvedSocketLeaseId,
        'workstream_control',
        startedOnce ? 'reconnect' : initialReasonRef.current,
        attempt,
        operationId,
        workstreamFeedOpenAttemptId(workstreamId),
      );
      startedOnce = true;
      try {
        const ticket = await api.getWorkstreamControlSocketTicket(workstreamId, operationId);
        if (stopped) return;
        // See `workspace-socket.tsx`: an offline transition during the ticket
        // request is invisible to the offline handler, because there was no
        // socket to close.
        if (isOffline()) {
          socketTelemetry.disconnected({ attempts: attempt, retrying: false, cause: 'offline' });
          return;
        }
        const next = createRealtimeSocket('workstream_control', ticket.url, ticket.protocols);
        socket = next;
        next.addEventListener('open', () => {
          if (stopped || socket !== next) return;
          socketTelemetry.connected(attempt);
          attempt = 0;
          next.send(JSON.stringify({ type: 'subscribe' }));
          scheduleHeartbeat(next);
        });
        next.addEventListener('message', (messageEvent) => {
          if (stopped || socket !== next) return;
          if (String(messageEvent.data) === 'pong') {
            scheduleHeartbeat(next);
            return;
          }
          try {
            const event = WorkstreamControlSocketEventSchema.safeParse(JSON.parse(String(messageEvent.data)));
            if (!event.success) {
              if (!protocolWarningReported) {
                protocolWarningReported = true;
                logWarn('rally', 'Ignored invalid WorkstreamDO socket event', event.error.issues);
              }
              return;
            }
            if (event.data.type === 'workstream_metadata') {
              applyMetadata(event.data.metadata);
            }
          } catch (error) {
            // A reconnect always returns a complete authoritative metadata snapshot.
            if (!protocolWarningReported) {
              protocolWarningReported = true;
              logWarn(
                'rally',
                'Ignored unreadable WorkstreamDO socket event',
                error instanceof Error ? error.message : 'unknown',
              );
            }
          }
        });
        next.addEventListener('close', (event) => {
          if (socket !== next) return;
          clearHeartbeat();
          socket = null;
          if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            accessRevoked = true;
            socketTelemetry.disconnected({ attempts: attempt, retrying: false, cause: 'access_revoked' });
            evictCachedWorkstream(queryClient, workstreamId);
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
    const online = (): void => {
      clearReconnect();
      void connect();
    };
    const offline = (): void => {
      clearReconnect();
      clearHeartbeat();
      if (socket) socketTelemetry.willClose('offline');
      socket?.close();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    void connect();
    return () => {
      stopped = true;
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      clearReconnect();
      clearHeartbeat();
      socket?.close();
    };
  }, [api, enabled, queryClient, resolvedSocketLeaseId, workstreamId]);
}
