import {
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamControlSocketEventSchema,
  type HyperSight,
  type HyperSightPreference,
  type WorkstreamControlMetadata,
} from '@avalon/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { normalizeHarnessStatus, type AvalonApi } from './api';
import type { WorkstreamDetail, WorkstreamSummary } from './types';
import { setCachedWorkstreams } from './workstreams-cache';

type WorkstreamControlSocketApi = Pick<AvalonApi, 'getWorkstreamControlSocketTicket'>;
const HEARTBEAT_MS = 50_000;
const PONG_TIMEOUT_MS = 15_000;

function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

function metadataPatch(metadata: WorkstreamControlMetadata): Partial<WorkstreamSummary> {
  const manual = metadata.viewer.manualUnreadFromSequenceNumber;
  const seen = metadata.viewer.readThroughSequenceNumber;
  const latest = metadata.latestAttentionSequenceNumber;
  const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
  return {
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
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: metadata.viewer.manualUnreadGeneration,
    hasUnread: firstUnread !== null,
    youAreMentioned: metadata.viewer.youAreMentioned,
    firstUnreadSequenceNumber: firstUnread,
    lastActivityAt: metadata.lastActivityAt,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    archivedAt: metadata.archivedAt ?? undefined,
    scope: metadata.scope,
    systemKind: metadata.systemKind ?? undefined,
    nextPendingWakeup: metadata.nextPendingWakeup,
  };
}

/** Keep WorkstreamDO-owned metadata coherent independently of the agent feed. */
export function useWorkstreamControlSocket(
  api: WorkstreamControlSocketApi | null,
  workstreamId: string,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!api || !enabled) return;
    let stopped = false;
    let accessRevoked = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let connecting = false;
    let attempt = 0;
    let revision = -1;

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
      if (metadata.id !== workstreamId || metadata.revision < revision) return;
      revision = metadata.revision;
      const patch = metadataPatch(metadata);
      queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
        current ? { ...current, ...patch } : current);
      setCachedWorkstreams(queryClient, (current) => {
        if (!metadata.viewer.listable) return current?.filter((item) => item.id !== workstreamId);
        return current?.map((item) => item.id === workstreamId ? { ...item, ...patch } : item);
      });
    };
    const connect = async (): Promise<void> => {
      if (stopped || accessRevoked || connecting) return;
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
      if (navigator.onLine === false) return;
      connecting = true;
      clearReconnect();
      try {
        const ticket = await api.getWorkstreamControlSocketTicket(workstreamId);
        if (stopped) return;
        const next = new WebSocket(ticket.url, ticket.protocols);
        socket = next;
        next.addEventListener('open', () => {
          if (stopped || socket !== next) return;
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
            if (!event.success) return;
            if (event.data.type === 'workstream_metadata') {
              applyMetadata(event.data.metadata);
            } else if (event.data.type === 'hypersight_configuration_updated') {
              queryClient.setQueryData<HyperSight>(['hypersight', workstreamId], event.data.hypersight);
            } else if (event.data.type === 'hypersight_preference_updated') {
              queryClient.setQueryData<HyperSightPreference>(
                ['hypersight-preference', workstreamId],
                event.data.preference,
              );
            } else {
              const run = event.data.run;
              queryClient.setQueryData<HyperSight>(['hypersight', workstreamId], (current) => {
                if (!current || current.versionId !== run.configurationVersionId) return current;
                return {
                  ...current,
                  blocks: current.blocks.map((block) => {
                    if (block.id !== run.blockId) return block;
                    if (block.latestRun
                      && block.latestRun.id !== run.id
                      && block.latestRun.triggerSequence > run.triggerSequence) return block;
                    return { ...block, latestRun: run };
                  }),
                };
              });
            }
          } catch {
            // A reconnect always returns a complete authoritative metadata snapshot.
          }
        });
        next.addEventListener('close', (event) => {
          if (socket !== next) return;
          clearHeartbeat();
          socket = null;
          if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            accessRevoked = true;
            setCachedWorkstreams(queryClient, (current) => current?.filter((item) => item.id !== workstreamId));
            queryClient.removeQueries({ queryKey: ['workstream', workstreamId], exact: true });
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
    const online = (): void => {
      clearReconnect();
      void connect();
    };
    const offline = (): void => {
      clearReconnect();
      clearHeartbeat();
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
  }, [api, enabled, queryClient, workstreamId]);
}
