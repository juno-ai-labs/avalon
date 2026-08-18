import {
  HyperSightBlockSocketEventSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  type HyperSight,
  type HyperSightBlockRun,
} from '@avalon/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { AvalonApi } from './api';

type HyperSightBlockSocketApi = Pick<AvalonApi, 'getHyperSightBlockSocketTicket'>;
const HEARTBEAT_MS = 50_000;
const PONG_TIMEOUT_MS = 15_000;
const STABLE_CONNECTION_MS = 10_000;

export type HyperSightBlockConnectionState =
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
export function useHyperSightBlockSockets(
  api: HyperSightBlockSocketApi | null,
  workstreamId: string,
  blockIds: readonly string[],
  enabled: boolean,
): Readonly<Record<string, HyperSightBlockConnectionState>> {
  const queryClient = useQueryClient();
  const [connectionStates, setConnectionStates] = useState<Readonly<Record<string, HyperSightBlockConnectionState>>>({});
  const blockKey = [...blockIds].sort().join('\u0000');
  useEffect(() => {
    if (!api || !enabled || blockKey.length === 0) {
      setConnectionStates({});
      return;
    }
    let stopped = false;
    const connections = new Map<string, BlockConnection>();
    const streamRevisions = new Map<string, { blockRunId: string; revision: number }>();
    const updateConnectionState = (blockId: string, state: HyperSightBlockConnectionState): void => {
      setConnectionStates((current) => current[blockId] === state
        ? current
        : { ...current, [blockId]: state });
    };

    const applyRun = (blockId: string, run: HyperSightBlockRun | null): void => {
      queryClient.setQueryData<HyperSight>(['hypersight', workstreamId], (current) => {
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
      queryClient.setQueryData<HyperSight>(['hypersight', workstreamId], (current) => {
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
      try {
        const ticket = await api.getHyperSightBlockSocketTicket(workstreamId, blockId);
        if (stopped || !connections.has(blockId)) return;
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
              if (!stopped && connection.socket === socket && socket.readyState === WebSocket.OPEN) socket.close();
            }, PONG_TIMEOUT_MS);
          }, HEARTBEAT_MS);
        };
        const scheduleReconnect = (): void => {
          if (stopped || connection.revoked || connection.reconnectTimer !== null || navigator.onLine === false) return;
          connection.attempt += 1;
          connection.reconnectTimer = window.setTimeout(() => {
            connection.reconnectTimer = null;
            void connect(blockId);
          }, reconnectDelay(connection.attempt));
        };
        socket.addEventListener('open', () => {
          if (stopped || connection.socket !== socket) return;
          const subscribe = (): void => {
            if (!stopped && connection.socket === socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'subscribe' }));
            }
          };
          if (connection.attempt > 0) {
            // Refresh the parent projection first, then let the block-agent
            // snapshot replace it with any newer in-flight checkpoint.
            void queryClient.refetchQueries({ queryKey: ['hypersight', workstreamId], exact: true })
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
            const event = HyperSightBlockSocketEventSchema.safeParse(JSON.parse(String(message.data)));
            if (!event.success || event.data.blockId !== blockId) return;
            updateConnectionState(blockId, 'connected');
            if (event.data.type === 'hypersight_block_stream_checkpoint') {
              applyStreamCheckpoint(blockId, event.data.blockRunId, event.data.streamCheckpoint);
            } else {
              applyRun(blockId, event.data.run);
              if (event.data.type === 'hypersight_block_snapshot' && event.data.run) {
                applyStreamCheckpoint(blockId, event.data.run.id, event.data.streamCheckpoint);
              }
            }
          } catch {
            // Reconnect provides a complete block-agent snapshot.
          }
        });
        socket.addEventListener('close', (event) => {
          if (connection.socket !== socket) return;
          clearTimers(connection);
          connection.socket = null;
          if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            connection.revoked = true;
            updateConnectionState(blockId, 'revoked');
            return;
          }
          updateConnectionState(blockId, navigator.onLine === false ? 'offline' : 'reconnecting');
          scheduleReconnect();
        });
        socket.addEventListener('error', () => socket.close());
      } catch {
        connection.attempt += 1;
        if (browserIsOffline()) {
          updateConnectionState(blockId, 'offline');
          return;
        }
        updateConnectionState(blockId, 'reconnecting');
        connection.reconnectTimer = window.setTimeout(() => {
          connection.reconnectTimer = null;
          void connect(blockId);
        }, reconnectDelay(connection.attempt));
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
        connecting: false,
        revoked: false,
      });
      void connect(blockId);
    }
    const online = (): void => {
      for (const [blockId, connection] of connections) {
        updateConnectionState(blockId, connection.attempt === 0 ? 'connecting' : 'reconnecting');
        void connect(blockId);
      }
    };
    const offline = (): void => {
      for (const [blockId, connection] of connections) {
        updateConnectionState(blockId, 'offline');
        clearTimers(connection);
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
