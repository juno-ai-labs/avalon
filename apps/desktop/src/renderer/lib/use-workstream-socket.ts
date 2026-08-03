import { ServerSocketEventSchema, type ServerSocketEvent } from '@avalon/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  mapElicitation,
  mapMessage,
  mapParticipant,
  mapResource,
  mapSuggestion,
  mapToolInvocation,
  mapViewer,
  mapWorkstreamDetail,
  normalizeHarnessStatus,
  type AvalonApi,
} from './api';
import type { Message, WorkstreamDetail } from './types';

export type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

const HEARTBEAT_BASE_MS = 45_000;
const HEARTBEAT_JITTER_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
export const SOCKET_STABLE_CONNECTION_MS = 30_000;

export function socketHeartbeatDelay(random = Math.random): number {
  return HEARTBEAT_BASE_MS + Math.floor(random() * HEARTBEAT_JITTER_MS);
}

export function socketReconnectDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  // Equal jitter prevents a reconnect herd while retaining a useful minimum.
  return Math.floor(ceiling / 2 + random() * ceiling / 2);
}

function compareMessages(a: Message, b: Message): number {
  const aAnchor = a.realtimeOrder?.anchorSequenceNumber ?? a.sequenceNumber;
  const bAnchor = b.realtimeOrder?.anchorSequenceNumber ?? b.sequenceNumber;
  if (aAnchor !== bAnchor) return aAnchor - bAnchor;

  const aPlacement = a.realtimeOrder?.placement === 'before_anchor' ? 0 : 1;
  const bPlacement = b.realtimeOrder?.placement === 'before_anchor' ? 0 : 1;
  if (aPlacement !== bPlacement) return aPlacement - bPlacement;

  const aRealtimeSequence = a.realtimeOrder?.eventSequence;
  const bRealtimeSequence = b.realtimeOrder?.eventSequence;
  if (aRealtimeSequence !== undefined && bRealtimeSequence !== undefined && aRealtimeSequence !== bRealtimeSequence) {
    return aRealtimeSequence - bRealtimeSequence;
  }
  if (a.sequenceNumber !== b.sequenceNumber) return a.sequenceNumber - b.sequenceNumber;
  const createdDifference = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (Number.isFinite(createdDifference) && createdDifference !== 0) return createdDifference;
  return a.id.localeCompare(b.id);
}

export function nextTranscriptSequence(messages: Message[] | undefined): number {
  return (messages ?? []).reduce(
    (maximum, message) => Math.max(
      maximum,
      message.realtimeOrder?.anchorSequenceNumber ?? message.sequenceNumber,
    ),
    0,
  ) + 1;
}

function activeStreamAnchor(messages: Message[] | undefined): number | undefined {
  return [...(messages ?? [])]
    .reverse()
    .find((message) => message.streaming && message.authorType === 'agent')
    ?.realtimeOrder?.anchorSequenceNumber;
}

export function orderTranscript(messages: Message[]): Message[] {
  return [...messages].sort(compareMessages);
}

function isSameLogicalMessage(left: Message, right: Message): boolean {
  if (left.id === right.id) return true;
  if (left.clientMessageId && (
    left.clientMessageId === right.id
    || left.clientMessageId === right.clientMessageId
  )) return true;
  return Boolean(right.clientMessageId && right.clientMessageId === left.id);
}

export function insertMessage(messages: Message[] | undefined, message: Message): Message[] {
  const existing = messages ?? [];
  return orderTranscript([
    ...existing.filter((candidate) => !isSameLogicalMessage(candidate, message)),
    message,
  ]);
}

/**
 * A REST refresh replaces canonical transcript rows, but realtime tool updates
 * do not share the D1 message sequence domain. Retain those blocks until a
 * canonical tool row with the same invocation arrives, anchored before the
 * final assistant row for the turn.
 */
export function mergeCanonicalTranscript(previous: Message[] | undefined, canonical: Message[]): Message[] {
  const canonicalIds = new Set(canonical.map((message) => message.id));
  const canonicalToolIds = new Set(canonical.flatMap((message) => message.toolEvent ? [message.toolEvent.id] : []));
  const realtimeTools = (previous ?? []).filter((message) =>
    message.messageType === 'tool_event'
    && message.realtimeOrder !== undefined
    && !canonicalIds.has(message.id)
    && (!message.toolEvent || !canonicalToolIds.has(message.toolEvent.id)),
  );
  const pendingHumanMessages = (previous ?? []).filter((message) =>
    message.authorType === 'human'
    && message.deliveryState === 'sending'
    && !canonicalIds.has(message.id)
    && !canonical.some((candidate) => isSameLogicalMessage(message, candidate)),
  );
  return orderTranscript([...canonical, ...realtimeTools, ...pendingHumanMessages]);
}

function removeMessage(messages: Message[] | undefined, id: string): Message[] {
  return (messages ?? []).filter((message) => message.id !== id);
}

export function useWorkstreamSocket(api: AvalonApi | null, workstreamId: string, enabled: boolean): SocketState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SocketState>('idle');
  const lastSequence = useRef(0);
  const attempts = useRef(0);

  useEffect(() => {
    lastSequence.current = 0;
    attempts.current = 0;
    if (!api || !enabled) {
      setState('idle');
      return;
    }
    let closedByEffect = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let stabilityTimer: number | null = null;
    let ticketRequestInFlight = false;
    let canonicalResyncInFlight = false;
    let canonicalResyncTarget: number | null = null;
    const isOffline = (): boolean => navigator.onLine === false;

    const syncCanonicalTranscriptAndList = (): void => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', workstreamId], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
      ]);
    };

    const applyEvent = (event: ServerSocketEvent): void => {
      if (event.type === 'resync_required') {
        canonicalResyncTarget = Math.max(canonicalResyncTarget ?? 0, event.latestSequence);
        clearHeartbeat();
        clearStabilityTimer();
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
        else scheduleReconnect();
        return;
      }
      // Once replay history is unavailable, subsequent frames cannot safely be
      // applied on top of stale state. Reconnect only after the direct REST
      // snapshot succeeds, retaining the old cursor across failed attempts.
      if (canonicalResyncTarget !== null) return;
      // Snapshots are valid at sequence zero and may intentionally replace
      // state at the same sequence after an explicit initial subscription.
      if (event.type === 'snapshot') {
        if (event.sequence < lastSequence.current) return;
        lastSequence.current = event.sequence;
      } else {
        if (event.sequence <= lastSequence.current) return;
        lastSequence.current = event.sequence;
      }

      if (event.type === 'snapshot') {
        queryClient.setQueryData(['workstream', workstreamId], mapWorkstreamDetail(event.workstream));
        // A room snapshot intentionally omits transcript history; REST remains canonical.
        syncCanonicalTranscriptAndList();
      } else if (event.type === 'presence_changed') {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? { ...current, viewers: event.viewers.map(mapViewer) } : current,
        );
      } else if (event.type === 'message_created' || event.type === 'stream_completed') {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => insertMessage(current, mapMessage(event.message)));
      } else if (event.type === 'stream_started') {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
          const anchorSequenceNumber = nextTranscriptSequence(current);
          return insertMessage(current, {
            id: event.messageId,
            workstreamId,
            sequenceNumber: anchorSequenceNumber,
            authorType: 'agent',
            messageType: 'text',
            text: '',
            createdAt: event.occurredAt,
            streaming: true,
            realtimeOrder: {
              anchorSequenceNumber,
              eventSequence: event.sequence,
              placement: 'at_anchor',
            },
          });
        });
      } else if (event.type === 'stream_delta') {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
          const existing = (current ?? []).find((message) => message.id === event.messageId);
          if (!existing) {
            const anchorSequenceNumber = nextTranscriptSequence(current);
            return insertMessage(current, {
              id: event.messageId,
              workstreamId,
              sequenceNumber: anchorSequenceNumber,
              authorType: 'agent',
              messageType: 'text',
              text: event.delta,
              createdAt: event.occurredAt,
              streaming: true,
              realtimeOrder: {
                anchorSequenceNumber,
                eventSequence: event.sequence,
                placement: 'at_anchor',
              },
            });
          }
          return (current ?? []).map((message) =>
            message.id === event.messageId
              ? { ...message, text: `${message.text ?? ''}${event.delta}`, streaming: true }
              : message,
          );
        });
      } else if (event.type === 'harness_status_changed') {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? { ...current, harnessStatus: normalizeHarnessStatus(event.status) } : current,
        );
        void queryClient.invalidateQueries({ queryKey: ['workstreams'] });
      } else if (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_failed') {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
          const messageId = `tool-${event.invocation.id}`;
          const existing = (current ?? []).find((message) => message.id === messageId);
          const anchorSequenceNumber = existing?.realtimeOrder?.anchorSequenceNumber
            ?? activeStreamAnchor(current)
            ?? nextTranscriptSequence(current);
          return insertMessage(current, {
            id: messageId,
            workstreamId,
            sequenceNumber: anchorSequenceNumber,
            authorType: 'agent',
            messageType: 'tool_event',
            createdAt: existing?.createdAt ?? event.occurredAt,
            realtimeOrder: {
              anchorSequenceNumber,
              // A completion update must not move the tool below tools that
              // started later in the same turn.
              eventSequence: existing?.realtimeOrder?.eventSequence ?? event.sequence,
              placement: 'before_anchor',
            },
            toolEvent: mapToolInvocation(event.invocation),
          });
        });
      } else if (event.type === 'elicitation_created' || event.type === 'elicitation_answered') {
        const messageId = `elicitation-${event.elicitation.id}`;
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
          if (event.elicitation.status === 'cancelled') return removeMessage(current, messageId);
          return insertMessage(current, {
            id: messageId,
            workstreamId,
            sequenceNumber: event.sequence,
            authorType: 'agent',
            messageType: 'elicitation',
            createdAt: event.elicitation.createdAt,
            elicitation: mapElicitation(event.elicitation),
          });
        });
      } else if (event.type === 'participant_added') {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) => {
          if (!current) return current;
          const participant = mapParticipant(event.participant);
          return {
            ...current,
            participants: current.participants.some((candidate) => candidate.id === participant.id)
              ? current.participants.map((candidate) => candidate.id === participant.id ? participant : candidate)
              : [...current.participants, participant],
          };
        });
      } else if (event.type === 'participant_removed') {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? { ...current, participants: current.participants.filter((participant) => participant.id !== event.userId) } : current,
        );
      } else if (event.type === 'resource_attached' || event.type === 'resource_updated') {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) => {
          if (!current) return current;
          const resource = mapResource(event.resource);
          const exists = current.resources.some((candidate) => candidate.id === resource.id);
          return {
            ...current,
            resources: exists
              ? current.resources.map((candidate) => candidate.id === resource.id ? resource : candidate)
              : [...current.resources, resource],
          };
        });
      } else if (event.type === 'activity_suggestion_created' || event.type === 'activity_suggestion_resolved') {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => insertMessage(current, {
          id: `suggestion-${event.suggestion.id}`,
          workstreamId,
          sequenceNumber: event.sequence,
          authorType: 'system',
          messageType: 'activity_suggestion',
          createdAt: event.suggestion.createdAt,
          activitySuggestion: mapSuggestion(event.suggestion),
        }));
      }
    };

    const clearReconnectTimer = (): void => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const clearHeartbeat = (): void => {
      if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
      if (pongTimer !== null) window.clearTimeout(pongTimer);
      heartbeatTimer = null;
      pongTimer = null;
    };

    const clearStabilityTimer = (): void => {
      if (stabilityTimer !== null) window.clearTimeout(stabilityTimer);
      stabilityTimer = null;
    };

    const scheduleStabilityReset = (target: WebSocket): void => {
      clearStabilityTimer();
      stabilityTimer = window.setTimeout(() => {
        stabilityTimer = null;
        if (closedByEffect || socket !== target || target.readyState !== WebSocket.OPEN) return;
        attempts.current = 0;
      }, SOCKET_STABLE_CONNECTION_MS);
    };

    const scheduleHeartbeat = (target: WebSocket): void => {
      clearHeartbeat();
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null;
        if (closedByEffect || socket !== target || target.readyState !== WebSocket.OPEN) return;
        target.send('ping');
        pongTimer = window.setTimeout(() => {
          pongTimer = null;
          if (closedByEffect || socket !== target || target.readyState !== WebSocket.OPEN) return;
          target.close();
        }, PONG_TIMEOUT_MS);
      }, socketHeartbeatDelay());
    };

    const scheduleReconnect = (): void => {
      if (closedByEffect) return;
      clearReconnectTimer();
      attempts.current += 1;
      if (isOffline()) {
        setState('unavailable');
        return;
      }
      setState('reconnecting');
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, socketReconnectDelay(attempts.current));
    };

    const connect = async (): Promise<void> => {
      if (
        closedByEffect
        || ticketRequestInFlight
        || canonicalResyncInFlight
        || socket?.readyState === WebSocket.CONNECTING
        || socket?.readyState === WebSocket.OPEN
      ) return;
      if (isOffline()) {
        setState('unavailable');
        return;
      }
      clearReconnectTimer();
      if (canonicalResyncTarget !== null) {
        canonicalResyncInFlight = true;
        try {
          const targetSequence = canonicalResyncTarget;
          const [canonicalWorkstream, canonicalMessages, canonicalWorkstreams] = await Promise.all([
            api.getWorkstream(workstreamId),
            api.getMessages(workstreamId),
            api.getWorkstreams(),
          ]);
          if (closedByEffect) return;
          queryClient.setQueryData(['workstream', workstreamId], canonicalWorkstream);
          queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
            mergeCanonicalTranscript(current, canonicalMessages));
          queryClient.setQueryData(['workstreams'], canonicalWorkstreams);
          lastSequence.current = Math.max(lastSequence.current, targetSequence);
          if (canonicalResyncTarget === targetSequence) canonicalResyncTarget = null;
        } catch {
          scheduleReconnect();
          return;
        } finally {
          canonicalResyncInFlight = false;
        }
        // A newer resync target can arrive only from the socket being closed,
        // but handle it defensively before issuing another one-time ticket.
        if (canonicalResyncTarget !== null) {
          scheduleReconnect();
          return;
        }
      }
      ticketRequestInFlight = true;
      setState(attempts.current === 0 ? 'connecting' : 'reconnecting');
      try {
        const socketTicket = await api.getSocketTicket(workstreamId);
        if (closedByEffect) return;
        if (isOffline()) {
          scheduleReconnect();
          return;
        }
        const nextSocket = new WebSocket(socketTicket.url);
        socket = nextSocket;
        nextSocket.addEventListener('open', () => {
          if (closedByEffect || socket !== nextSocket) return;
          setState('connected');
          nextSocket.send(JSON.stringify({ type: 'subscribe', afterSequence: lastSequence.current }));
          scheduleStabilityReset(nextSocket);
          scheduleHeartbeat(nextSocket);
        });
        nextSocket.addEventListener('message', (messageEvent) => {
          if (closedByEffect || socket !== nextSocket) return;
          if (String(messageEvent.data) === 'pong') {
            scheduleHeartbeat(nextSocket);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(String(messageEvent.data));
            const event = ServerSocketEventSchema.safeParse(parsed);
            if (event.success) applyEvent(event.data);
          } catch {
            // Invalid frames are ignored; canonical REST state remains authoritative.
          }
        });
        nextSocket.addEventListener('close', () => {
          if (socket !== nextSocket) return;
          clearHeartbeat();
          clearStabilityTimer();
          socket = null;
          scheduleReconnect();
        });
        nextSocket.addEventListener('error', () => {
          clearHeartbeat();
          clearStabilityTimer();
          try {
            nextSocket.close();
          } catch {
            if (socket === nextSocket) socket = null;
            scheduleReconnect();
          }
        });
      } catch {
        scheduleReconnect();
      } finally {
        ticketRequestInFlight = false;
      }
    };

    const handleOnline = (): void => {
      if (closedByEffect || socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
      clearReconnectTimer();
      void connect();
    };

    const handleOffline = (): void => {
      clearReconnectTimer();
      clearHeartbeat();
      clearStabilityTimer();
      setState('unavailable');
      socket?.close();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    void connect();
    return () => {
      closedByEffect = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearReconnectTimer();
      clearHeartbeat();
      clearStabilityTimer();
      socket?.close();
    };
  }, [api, enabled, queryClient, workstreamId]);

  return state;
}
