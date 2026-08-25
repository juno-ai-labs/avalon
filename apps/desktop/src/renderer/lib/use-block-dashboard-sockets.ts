import {
  BlockDashboardBlockSocketEventSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  type BlockDashboard,
  type BlockDashboardBlockRun,
} from '@rally/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { logWarn } from '../../common/logger';
import type { RallyApi } from './api';
import { realtimeSocketTelemetry, type RealtimeSocketTelemetry } from './socket-telemetry';

type BlockDashboardBlockSocketApi = Pick<RallyApi, 'getBlockDashboardBlockSocketTicket'>;
const HEARTBEAT_MS = 50_000;
const PONG_TIMEOUT_MS = 15_000;
const STABLE_CONNECTION_MS = 10_000;

export type BlockDashboardBlockConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'revoked';

interface BlockConnection {
  socket: WebSocket | null;
  reconnectTimer: number | null;
  heartbeatTimer: number | null;
  pongTimer: number | null;
  stabilityTimer: number | null;
  attempt: number;
  telemetry: RealtimeSocketTelemetry;
  connecting: boolean;
  revoked: boolean;
}

function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

function browserIsOffline(): boolean {
  return navigator.onLine === false;
}

/** Connect the selected work stream directly to each configured HyperSight block agent. */
export function useBlockDashboardSockets(
  api: BlockDashboardBlockSocketApi | null,
  workstreamId: string,
  blockIds: readonly string[],
  enabled: boolean,
): Readonly<Record<string, BlockDashboardBlockConnectionState>> {
  const queryClient = useQueryClient();
  const [connectionStates, setConnectionStates] = useState<Readonly<Record<string, BlockDashboardBlockConnectionState>>>({});
  const blockKey = [...blockIds].sort().join('\u0000');
  useEffect(() => {
    if (!api || !enabled || blockKey.length === 0) {
      setConnectionStates({});
      return;
    }
    let stopped = false;
    let protocolWarningReported = false;
    const connections = new Map<string, BlockConnection>();
    const streamRevisions = new Map<string, { blockRunId: string; revision: number }>();
    const updateConnectionState = (blockId: string, state: BlockDashboardBlockConnectionState): void => {
      setConnectionStates((current) => current[blockId] === state
        ? current
        : { ...current, [blockId]: state });
    };

    const applyRun = (blockId: string, run: BlockDashboardBlockRun | null): void => {
      queryClient.setQueryData<BlockDashboard>(['block-dashboard', workstreamId], (current) => {
        if (!current) return current;
        return {
          ...current,
          blocks: current.blocks.map((block) => {
            if (block.id !== blockId) return block;
            if (run && current.versionId !== run.configurationVersionId) return block;
            if (run && block.latestRun
              && block.latestRun.id !== run.id
              && block.latestRun.triggerSequence > run.triggerSequence) return block;
            return { ...block, latestRun: run };
          }),
        };
      });
    };

    const applyStreamCheckpoint = (
      blockId: string,
      blockRunId: string,
      checkpoint: { roomSequence: number; text: string } | null,
    ): void => {
      if (!checkpoint) {
        streamRevisions.delete(blockId);
        return;
      }
      const previous = streamRevisions.get(blockId);
      if (previous?.blockRunId === blockRunId && previous.revision >= checkpoint.roomSequence) return;
      streamRevisions.set(blockId, { blockRunId, revision: checkpoint.roomSequence });
      queryClient.setQueryData<BlockDashboard>(['block-dashboard', workstreamId], (current) => {
        if (!current) return current;
        return {
          ...current,
          blocks: current.blocks.map((block) => block.id === blockId
            && block.latestRun?.id === blockRunId
            && (block.latestRun.status === 'queued' || block.latestRun.status === 'running')
            ? { ...block, latestRun: { ...block.latestRun, status: 'running', markdown: checkpoint.text } }
            : block),
        };
      });
    };

    const clearTimers = (connection: BlockConnection): void => {
      if (connection.reconnectTimer !== null) window.clearTimeout(connection.reconnectTimer);
      if (connection.heartbeatTimer !== null) window.clearTimeout(connection.heartbeatTimer);
      if (connection.pongTimer !== null) window.clearTimeout(connection.pongTimer);
      if (connection.stabilityTimer !== null) window.clearTimeout(connection.stabilityTimer);
      connection.reconnectTimer = null;
      connection.heartbeatTimer = null;
      connection.pongTimer = null;
      connection.stabilityTimer = null;
    };

    const connect = async (blockId: string): Promise<void> => {
      const connection = connections.get(blockId);
      if (!connection || stopped || connection.revoked || connection.connecting) return;
      if (navigator.onLine === false) {
        updateConnectionState(blockId, 'offline');
        return;
      }
      if (connection.socket?.readyState === WebSocket.CONNECTING
        || connection.socket?.readyState === WebSocket.OPEN) return;
      connection.connecting = true;
      updateConnectionState(blockId, connection.attempt === 0 ? 'connecting' : 'reconnecting');
      if (connection.reconnectTimer !== null) window.clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
      const scheduleReconnect = (): void => {
        if (stopped || connection.revoked || connection.reconnectTimer !== null || navigator.onLine === false) return;
        connection.attempt += 1;
        connection.reconnectTimer = window.setTimeout(() => {
          connection.reconnectTimer = null;
          void connect(blockId);
        }, reconnectDelay(connection.attempt));
      };
      try {
        const ticket = await api.getBlockDashboardBlockSocketTicket(workstreamId, blockId);
        if (stopped || !connections.has(blockId)) return;
        // See `workspace-socket.tsx`: an offline transition during the ticket
        // request is invisible to the offline handler, because there was no
        // socket to close.
        if (browserIsOffline()) {
          connection.telemetry.disconnected({
            attempts: connection.attempt,
            retrying: false,
            cause: 'offline',
          });
          updateConnectionState(blockId, 'offline');
          return;
        }
        const socket = new WebSocket(ticket.url, ticket.protocols);
        connection.socket = socket;
        const scheduleHeartbeat = (): void => {
          if (connection.heartbeatTimer !== null) window.clearTimeout(connection.heartbeatTimer);
          if (connection.pongTimer !== null) window.clearTimeout(connection.pongTimer);
          connection.heartbeatTimer = window.setTimeout(() => {
            connection.heartbeatTimer = null;
            if (stopped || connection.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
            socket.send('ping');
            connection.pongTimer = window.setTimeout(() => {
              connection.pongTimer = null;
              if (stopped || connection.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
              connection.telemetry.willClose('heartbeat_timeout');
              socket.close();
            }, PONG_TIMEOUT_MS);
          }, HEARTBEAT_MS);
        };
        socket.addEventListener('open', () => {
          if (stopped || connection.socket !== socket) return;
          // Before the stability timer resets the counter below.
          connection.telemetry.connected(connection.attempt);
          const subscribe = (): void => {
            if (!stopped && connection.socket === socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'subscribe' }));
            }
          };
          if (connection.attempt > 0) {
            // Refresh the parent projection first, then let the block-agent
            // snapshot replace it with any newer in-flight checkpoint.
            void queryClient.refetchQueries({ queryKey: ['block-dashboard', workstreamId], exact: true })
              .finally(subscribe);
          } else {
            subscribe();
          }
          connection.stabilityTimer = window.setTimeout(() => {
            connection.stabilityTimer = null;
            if (!stopped && connection.socket === socket && socket.readyState === WebSocket.OPEN) {
              connection.attempt = 0;
            }
          }, STABLE_CONNECTION_MS);
          scheduleHeartbeat();
        });
        socket.addEventListener('message', (message) => {
          if (stopped || connection.socket !== socket) return;
          if (String(message.data) === 'pong') {
            scheduleHeartbeat();
            return;
          }
          try {
            const event = BlockDashboardBlockSocketEventSchema.safeParse(JSON.parse(String(message.data)));
            if (!event.success || event.data.blockId !== blockId) {
              if (!protocolWarningReported) {
                protocolWarningReported = true;
                logWarn(
                  'rally',
                  'Ignored invalid BlockDashboardAgent socket event',
                  event.success ? 'block_id_mismatch' : event.error.issues,
                );
              }
              return;
            }
            updateConnectionState(blockId, 'connected');
            if (event.data.type === 'block_dashboard_block_stream_checkpoint') {
              applyStreamCheckpoint(blockId, event.data.blockRunId, event.data.streamCheckpoint);
            } else {
              applyRun(blockId, event.data.run);
              if (event.data.type === 'block_dashboard_block_snapshot' && event.data.run) {
                applyStreamCheckpoint(blockId, event.data.run.id, event.data.streamCheckpoint);
              }
            }
          } catch (error) {
            // Reconnect provides a complete block-agent snapshot.
            if (!protocolWarningReported) {
              protocolWarningReported = true;
              logWarn(
                'rally',
                'Ignored unreadable BlockDashboardAgent socket event',
                error instanceof Error ? error.message : 'unknown',
              );
            }
          }
        });
        socket.addEventListener('close', (event) => {
          if (connection.socket !== socket) return;
          clearTimers(connection);
          connection.socket = null;
          if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            connection.revoked = true;
            connection.telemetry.disconnected({
              attempts: connection.attempt,
              retrying: false,
              cause: 'access_revoked',
            });
            updateConnectionState(blockId, 'revoked');
            return;
          }
          if (!stopped) {
            connection.telemetry.disconnected({
              attempts: connection.attempt,
              retrying: !browserIsOffline(),
            });
          }
          updateConnectionState(blockId, navigator.onLine === false ? 'offline' : 'reconnecting');
          scheduleReconnect();
        });
        socket.addEventListener('error', () => {
          // See `use-workstream-socket.ts`: the pending cause belongs to this
          // block's connection rather than to one of its sockets.
          if (stopped || connection.socket !== socket) return;
          connection.telemetry.willClose('transport_error');
          socket.close();
        });
      } catch {
        if (!stopped) {
          connection.telemetry.disconnected({
            attempts: connection.attempt,
            retrying: !browserIsOffline(),
            cause: 'ticket_failed',
          });
        }
        if (browserIsOffline()) {
          updateConnectionState(blockId, 'offline');
          return;
        }
        updateConnectionState(blockId, 'reconnecting');
        scheduleReconnect();
      } finally {
        connection.connecting = false;
      }
    };

    const configuredBlockIds = blockKey.split('\u0000');
    setConnectionStates(Object.fromEntries(configuredBlockIds.map((blockId) => [
      blockId,
      navigator.onLine === false ? 'offline' : 'connecting',
    ])));
    for (const blockId of configuredBlockIds) {
      connections.set(blockId, {
        socket: null,
        reconnectTimer: null,
        heartbeatTimer: null,
        pongTimer: null,
        stabilityTimer: null,
        attempt: 0,
        telemetry: realtimeSocketTelemetry('block_dashboard'),
        connecting: false,
        revoked: false,
      });
      void connect(blockId);
    }
    const online = (): void => {
      for (const [blockId, connection] of connections) {
        if (connection.socket?.readyState === WebSocket.OPEN
          || connection.socket?.readyState === WebSocket.CONNECTING) continue;
        updateConnectionState(blockId, connection.attempt === 0 ? 'connecting' : 'reconnecting');
        void connect(blockId);
      }
    };
    const offline = (): void => {
      for (const [blockId, connection] of connections) {
        updateConnectionState(blockId, 'offline');
        clearTimers(connection);
        if (connection.socket) connection.telemetry.willClose('offline');
        connection.socket?.close();
      }
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      stopped = true;
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      for (const connection of connections.values()) {
        clearTimers(connection);
        connection.socket?.close();
      }
    };
  }, [api, blockKey, enabled, queryClient, workstreamId]);
  return connectionStates;
}
