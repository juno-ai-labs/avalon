import { safeParseSocketEvent, isUnknownSocketEvent } from "@rally/contracts";
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
import { retainConversationChildren } from './conversation-cache';
import { useLocalCacheScope } from './local-cache-scope';
import { retainQueryData } from './retain-query-data';
import { isSocketTicketRequestTimeoutError } from './socket-ticket-request';

type WorkstreamControlSocketApi = Pick<RallyApi, 'getWorkstreamControlSocketTicket'>;
const HEARTBEAT_MS = 50_000;
const PONG_TIMEOUT_MS = 15_000;

export type WorkstreamChildDirectory = Pick<WorkstreamControlMetadata, 'privateChildren' | 'privateChildrenWaterline' | 'stateVersion'>;

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
    appearance: metadata.appearance,
    objective: metadata.description,
    // Full snapshots must overwrite nullable fields too. Omitting a field here
    // would preserve an old value after another client cleared it.
    emailAddress: metadata.emailAddress ?? undefined,
    createdByUserId: metadata.createdByUserId ?? undefined,
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
    appearance: metadata.appearance,
      objective: metadata.description,
      emailAddress: metadata.emailAddress ?? undefined,
      createdByUserId: metadata.createdByUserId ?? undefined,
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
  const localCacheScope = useLocalCacheScope();
  const [generatedSocketLeaseId] = useState(() => socketLeaseId ?? uuidV7());
  const resolvedSocketLeaseId = socketLeaseId ?? generatedSocketLeaseId;
  const initialReasonRef = useRef(initialReason);
  initialReasonRef.current = initialReason;
  useEffect(() => {
    if (!api || !enabled) return;
    const releaseData = retainQueryData(queryClient, [['workstream-children', workstreamId]]);
    let stopped = false;
    /**
     * The children the local cache was last told to keep. The control
     * socket is the authority for which private children this reader may
     * still open, so a child that leaves its roster leaves the disk too; the
     * comparison keeps a metadata frame that changed nothing about the roster
     * from scanning the store again.
     */
    let retainedChildren: string | null = null;
    let accessRevoked = false;
    let socket: RealtimeSocket | null = null;
    let activeTicketAbort: AbortController | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let connecting = false;
    let attempt = 0;
    let startedOnce = false;
    let protocolWarningReported = false;
    const socketTelemetry = realtimeSocketTelemetry('workstream_control');
    const isOffline = (): boolean => navigator.onLine === false;
    const clearBackgroundCount = (): void => {
      queryClient.setQueryData(['workstream-background-agents', workstreamId], null);
    };
    clearBackgroundCount();

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
      queryClient.setQueryData(['workstream-background-agents', workstreamId], metadata.backgroundAgentCount ?? null);
      const state = metadataState(metadata);
      const applied = applyVersionedWorkstreamState(queryClient, {
        workstreamId,
        stateVersion: metadata.stateVersion,
        ...state,
        visible: metadata.viewer.listable,
      });
      if (metadata.viewer.listable || metadata.archivedAt !== null) {
        // This control-owned state may arrive before any feed snapshot. Keep
        // it independent of both the feed detail and paged directory caches.
        queryClient.setQueryData<WorkstreamChildDirectory>(['workstream-children', workstreamId], (current) => {
          const incoming = metadata.stateVersion;
          const stored = current?.stateVersion;
          if (stored && (incoming.authorityGeneration < stored.authorityGeneration
            || (incoming.authorityGeneration === stored.authorityGeneration
              && (metadata.privateChildrenWaterline ?? incoming.viewerWaterline)
                < (current?.privateChildrenWaterline ?? stored.viewerWaterline)))) return current;
          return { privateChildren: metadata.privateChildren, privateChildrenWaterline: metadata.privateChildrenWaterline, stateVersion: incoming };
        });
        // Prune from the roster the guard above accepted, which may be the
        // one already held rather than this frame's: a stale frame that lists
        // fewer children must not take a still-authorized child off the disk.
        const accepted = queryClient.getQueryData<WorkstreamChildDirectory>(['workstream-children', workstreamId]);
        if (localCacheScope !== null && accepted?.privateChildren) {
          const listed = accepted.privateChildren.map((child) => child.substreamId).sort();
          const roster = listed.join(',');
          if (roster !== retainedChildren) {
            retainedChildren = roster;
            void retainConversationChildren(localCacheScope, workstreamId, new Set(listed));
          }
        }
      }
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
      const ticketAbort = new AbortController();
      activeTicketAbort = ticketAbort;
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
        const ticket = await api.getWorkstreamControlSocketTicket(
          workstreamId,
          operationId,
          ticketAbort.signal,
        );
        if (stopped) return;
        // See `workspace-socket.tsx`: an offline transition during the ticket
        // request is invisible to the offline handler, because there was no
        // socket to close.
        if (isOffline()) {
          clearBackgroundCount();
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
            const decoded: unknown = JSON.parse(String(messageEvent.data));
            if (isUnknownSocketEvent(decoded, WorkstreamControlSocketEventSchema.shape.type)) return;
            const event = safeParseSocketEvent(WorkstreamControlSocketEventSchema, decoded);
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
            clearBackgroundCount();
            socketTelemetry.disconnected({ attempts: attempt, retrying: false, cause: 'access_revoked' });
            evictCachedWorkstream(queryClient, workstreamId);
            return;
          }
          if (!stopped) {
            clearBackgroundCount();
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
      } catch (error) {
        if (!stopped) {
          clearBackgroundCount();
          socketTelemetry.disconnected({
            attempts: attempt,
            retrying: !isOffline(),
            cause: isOffline()
              ? 'offline'
              : isSocketTicketRequestTimeoutError(error) ? 'ticket_timeout' : 'ticket_failed',
          });
        }
        scheduleReconnect();
      } finally {
        if (activeTicketAbort === ticketAbort) activeTicketAbort = null;
        connecting = false;
      }
    };
    const online = (): void => {
      clearReconnect();
      void connect();
    };
    const offline = (): void => {
      clearBackgroundCount();
      clearReconnect();
      clearHeartbeat();
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      if (socket) socketTelemetry.willClose('offline');
      socket?.close();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    void connect();
    return () => {
      stopped = true;
      releaseData();
      clearBackgroundCount();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      clearReconnect();
      clearHeartbeat();
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      socket?.close();
    };
  }, [api, enabled, localCacheScope, queryClient, resolvedSocketLeaseId, workstreamId]);
}
