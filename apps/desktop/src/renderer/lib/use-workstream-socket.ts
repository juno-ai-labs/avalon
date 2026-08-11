import {
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  type PersonalSocketEvent,
  type ServerSocketEvent,
} from '@avalon/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  mapElicitation,
  mapMessage,
  messagesWithTransientBlocks,
  mapParticipant,
  mapResource,
  mapSuggestion,
  mapToolInvocation,
  mapViewer,
  mapWorkstreamDetail,
  normalizeHarnessStatus,
  type AvalonApi,
} from './api';
import { elicitationMessageId } from './elicitation';
import {
  createElicitationMessage,
  createTextMessage,
  createToolEventMessage,
  isSameLogicalMessage,
  removeTranscriptMessage,
  upsertTranscriptMessage,
} from './transcript';
import type { HarnessStatus, HyperSight, HyperSightPreference, Message, WorkstreamDetail, WorkstreamSummary } from './types';
import { WORKSTREAMS_QUERY_KEY } from './use-workstreams-query';

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

export function insertMessage(messages: Message[] | undefined, message: Message): Message[] {
  return orderTranscript(upsertTranscriptMessage(messages, message));
}

type StreamingSocketEvent = Extract<
  ServerSocketEvent,
  { type: 'stream_started' | 'stream_delta' }
>;

export interface StreamCursor {
  readonly turnId: string;
  readonly epoch: number;
  readonly streamSeq: number;
  readonly seenTurnIds: ReadonlySet<string>;
  readonly turnStartText: string;
  readonly roomSequence: number;
  readonly completed: boolean;
}

function streamingMessageId(event: StreamingSocketEvent): string {
  return event.messageId;
}

/**
 * Applies a model stream frame independently of room replay ordering. Bind can
 * retry a turn or switch routes after already emitting text, so room sequence
 * de-duplication alone is insufficient: a newer epoch must replace only that
 * turn's prior attempt and repeated chunks must not be appended twice. Bind
 * assigns a new turn ID after tool execution; that is a continuation of the
 * same assistant message, not an implicit reset.
 */
export function applyStreamingSocketEvent(
  messages: Message[] | undefined,
  event: StreamingSocketEvent,
  workstreamId: string,
  cursors: Map<string, StreamCursor>,
): Message[] {
  const messageId = streamingMessageId(event);
  const cursor = cursors.get(messageId);
  if (cursor) {
    if (event.sequence <= cursor.roomSequence) return messages ?? [];
    if (cursor.completed) return messages ?? [];
    if (event.turnId === cursor.turnId) {
      if (event.epoch < cursor.epoch) return messages ?? [];
      if (event.epoch === cursor.epoch) {
        if (event.streamSeq <= cursor.streamSeq) return messages ?? [];
      }
    } else if (cursor.seenTurnIds.has(event.turnId)) {
      // Once Bind advances past a tool-using turn, a delayed frame for that
      // earlier turn cannot be allowed to append out of order.
      return messages ?? [];
    }
  }

  const existing = (messages ?? []).find((message) => message.id === messageId);
  const startsNewTurn = !cursor || event.turnId !== cursor.turnId;
  const turnStartText = startsNewTurn ? existing?.text ?? '' : cursor.turnStartText;
  const replacesAttempt = event.reset
    || (!startsNewTurn && event.epoch > cursor.epoch);
  const seenTurnIds = new Set(cursor?.seenTurnIds);
  seenTurnIds.add(event.turnId);
  cursors.set(messageId, {
    turnId: event.turnId,
    epoch: event.epoch,
    streamSeq: event.streamSeq,
    seenTurnIds,
    turnStartText,
    roomSequence: event.sequence,
    completed: false,
  });

  if (event.type === 'stream_started') {
    if (existing) {
      return (messages ?? []).map((message) => message.id === messageId
        ? {
            ...message,
            text: replacesAttempt ? turnStartText : message.text,
            streaming: true,
            realtimeOrder: message.realtimeOrder
              ? { ...message.realtimeOrder, eventSequence: event.sequence }
              : message.realtimeOrder,
          }
        : message);
    }
    const anchorSequenceNumber = nextTranscriptSequence(messages);
    return insertMessage(messages, createTextMessage({
      id: messageId,
      workstreamId,
      sequenceNumber: anchorSequenceNumber,
      authorType: 'agent',
      text: '',
      createdAt: event.occurredAt,
      streaming: true,
      realtimeOrder: {
        anchorSequenceNumber,
        eventSequence: event.sequence,
        placement: 'at_anchor',
      },
    }));
  }

  if (!existing) {
    const anchorSequenceNumber = nextTranscriptSequence(messages);
    return insertMessage(messages, createTextMessage({
      id: messageId,
      workstreamId,
      sequenceNumber: anchorSequenceNumber,
      authorType: 'agent',
      text: event.delta,
      createdAt: event.occurredAt,
      streaming: true,
      realtimeOrder: {
        anchorSequenceNumber,
        eventSequence: event.sequence,
        placement: 'at_anchor',
      },
    }));
  }
  return (messages ?? []).map((message) => message.id === messageId
    ? {
        ...message,
        text: replacesAttempt ? `${turnStartText}${event.delta}` : `${message.text ?? ''}${event.delta}`,
        streaming: true,
        realtimeOrder: message.realtimeOrder
          ? { ...message.realtimeOrder, eventSequence: event.sequence }
          : message.realtimeOrder,
      }
    : message);
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
  const lowestCanonicalSequence = canonical.reduce(
    (lowest, message) => Math.min(lowest, message.sequenceNumber),
    Number.POSITIVE_INFINITY,
  );
  const olderPersistedMessages = (previous ?? []).filter((message) =>
    Number.isFinite(lowestCanonicalSequence)
    && message.realtimeOrder === undefined
    && message.deliveryState !== 'sending'
    && message.sequenceNumber < lowestCanonicalSequence
    && !canonicalIds.has(message.id),
  );
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
  return orderTranscript([...olderPersistedMessages, ...canonical, ...realtimeTools, ...pendingHumanMessages]);
}

/**
 * Once a run is terminal, D1 is the authoritative transcript. Realtime tool
 * rows are intentionally synthetic and can survive a reconnect after their
 * canonical counterparts have already been persisted. Retain only genuinely
 * newer persisted rows and local optimistic sends while replacing that
 * synthetic surface.
 */
export function replaceWithCanonicalTranscript(previous: Message[] | undefined, canonical: Message[]): Message[] {
  const canonicalIds = new Set(canonical.map((message) => message.id));
  const lowestCanonicalSequence = canonical.reduce(
    (lowest, message) => Math.min(lowest, message.sequenceNumber),
    Number.POSITIVE_INFINITY,
  );
  const highestCanonicalSequence = canonical.reduce(
    (highest, message) => Math.max(highest, message.sequenceNumber),
    0,
  );
  const newerPersistedMessages = (previous ?? []).filter((message) =>
    message.realtimeOrder === undefined
    && message.sequenceNumber > highestCanonicalSequence
    && !canonicalIds.has(message.id)
    && !canonical.some((candidate) => isSameLogicalMessage(message, candidate)),
  );
  const olderPersistedMessages = (previous ?? []).filter((message) =>
    Number.isFinite(lowestCanonicalSequence)
    && message.realtimeOrder === undefined
    && message.deliveryState !== 'sending'
    && message.sequenceNumber < lowestCanonicalSequence
    && !canonicalIds.has(message.id),
  );
  const pendingHumanMessages = (previous ?? []).filter((message) =>
    message.authorType === 'human'
    && message.deliveryState === 'sending'
    && !canonicalIds.has(message.id)
    && !canonical.some((candidate) => isSameLogicalMessage(message, candidate)),
  );
  return orderTranscript([...olderPersistedMessages, ...canonical, ...newerPersistedMessages, ...pendingHumanMessages]);
}

/**
 * A canonical request can race a newer socket frame. In that case the cached
 * version wins for duplicate identities and every unmatched realtime row
 * survives until the immediately-following canonical retry completes. The
 * shared upsert makes one monotonic exception: a cached open elicitation cannot
 * replace an answered canonical elicitation.
 */
export function mergeCanonicalTranscriptAfterConcurrentEvent(
  previous: Message[] | undefined,
  canonical: Message[],
): Message[] {
  return (previous ?? []).reduce(
    (merged, message) => insertMessage(merged, message),
    orderTranscript(canonical),
  );
}

function runMayStillEmitRealtime(status: WorkstreamDetail['harnessStatus']): boolean {
  return status === 'running' || status === 'scheduled';
}

/**
 * A harness status change is pushed, not polled, so both views of it take the
 * pushed value in one write: the open work stream's header reads the detail
 * query and its sidebar row reads the list query. Invalidating the list instead
 * would put a REST round trip between the two, and the header would pulse blue
 * over a sidebar dot that had not caught up yet — for as long as the refetch
 * took, and indefinitely if it raced with a poll that had already been issued.
 */
export function applyHarnessStatus(
  queryClient: QueryClient,
  workstreamId: string,
  harnessStatus: HarnessStatus,
): void {
  queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
    current && current.harnessStatus !== harnessStatus ? { ...current, harnessStatus } : current);
  queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
    current?.map((workstream) => workstream.id === workstreamId && workstream.harnessStatus !== harnessStatus
      ? { ...workstream, harnessStatus }
      : workstream));
}

function advanceWorkstreamAttention<T extends WorkstreamSummary>(
  workstream: T,
  message: Message,
): T {
  if (message.messageType === 'tool_event' || message.realtimeOrder !== undefined) return workstream;
  const latestAttentionSequenceNumber = Math.max(
    workstream.latestAttentionSequenceNumber,
    message.sequenceNumber,
  );
  if (latestAttentionSequenceNumber === workstream.latestAttentionSequenceNumber) return workstream;
  const hasUnread = workstream.manualUnreadFromSequenceNumber !== null
    || latestAttentionSequenceNumber > workstream.readThroughSequenceNumber;
  return {
    ...workstream,
    latestAttentionSequenceNumber,
    hasUnread,
    firstUnreadSequenceNumber: workstream.manualUnreadFromSequenceNumber
      ?? (hasUnread
        ? Math.min(latestAttentionSequenceNumber, workstream.readThroughSequenceNumber + 1)
        : null),
    lastActivityAt: message.createdAt > workstream.lastActivityAt
      ? message.createdAt
      : workstream.lastActivityAt,
  };
}

export function useWorkstreamSocket(
  api: AvalonApi | null,
  workstreamId: string,
  enabled: boolean,
): SocketState {
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
    let canonicalReconcileGeneration = 0;
    const streamCursors = new Map<string, StreamCursor>();
    const isOffline = (): boolean => navigator.onLine === false;

    const syncHyperSightQueries = (): Promise<unknown> => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hypersight', workstreamId], exact: true }),
      queryClient.invalidateQueries({ queryKey: ['hypersight-preference', workstreamId], exact: true }),
    ]);

    const syncCanonicalTranscriptAndList = (): void => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', workstreamId], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['workstream-context', workstreamId] }),
        queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
        syncHyperSightQueries(),
      ]);
    };

    const reconcileCanonicalState = async (): Promise<void> => {
      const generation = ++canonicalReconcileGeneration;
      const sequenceAtStart = lastSequence.current;
      try {
        const [canonicalWorkstream, canonicalMessagePage, canonicalWorkstreams] = await Promise.all([
          api.getWorkstream(workstreamId),
          api.getMessages(workstreamId),
          api.getWorkstreams(),
        ]);
        const canonicalMessages = messagesWithTransientBlocks(canonicalMessagePage, canonicalWorkstream);
        if (closedByEffect || generation !== canonicalReconcileGeneration) return;
        if (lastSequence.current > sequenceAtStart) {
          queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
            mergeCanonicalTranscriptAfterConcurrentEvent(current, canonicalMessages));
          // The detail and list snapshots may be stale too. Keep the socket's
          // newer cache state, then reconcile all three resources again from a
          // sequence boundary that includes the frame which just landed.
          void reconcileCanonicalState();
          return;
        }
        const mayStillEmitRealtime = runMayStillEmitRealtime(canonicalWorkstream.harnessStatus);
        queryClient.setQueryData(['workstream', workstreamId], canonicalWorkstream);
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
          mayStillEmitRealtime
            ? mergeCanonicalTranscript(current, canonicalMessages)
            : replaceWithCanonicalTranscript(current, canonicalMessages));
        queryClient.setQueryData(WORKSTREAMS_QUERY_KEY, canonicalWorkstreams);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workstream-context', workstreamId] }),
          syncHyperSightQueries(),
        ]);
        if (!mayStillEmitRealtime) streamCursors.clear();
      } catch {
        // The socket replay remains usable. A later terminal frame, reconnect,
        // or ordinary query refresh will retry the authoritative reconciliation.
      }
    };

    const applyPersonalEvent = (event: PersonalSocketEvent): void => {
      if (event.type === 'hypersight_preference_updated') {
        queryClient.setQueryData<HyperSightPreference>(
          ['hypersight-preference', workstreamId],
          event.preference,
        );
      }
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
        streamCursors.clear();
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
      } else if (event.type === 'message_created') {
        const message = mapMessage(event.message);
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => insertMessage(current, message));
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? advanceWorkstreamAttention(current, message) : current);
        queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
          current?.map((workstream) => workstream.id === workstreamId
            ? advanceWorkstreamAttention(workstream, message)
            : workstream));
      } else if (event.type === 'stream_completed') {
        const cursor = streamCursors.get(event.message.id);
        if (cursor) {
          streamCursors.set(event.message.id, {
            ...cursor,
            roomSequence: event.sequence,
            completed: true,
          });
        }
        const message = mapMessage(event.message);
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
          insertMessage(current, message));
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? advanceWorkstreamAttention(current, message) : current);
        queryClient.setQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY, (current) =>
          current?.map((workstream) => workstream.id === workstreamId
            ? advanceWorkstreamAttention(workstream, message)
            : workstream));
      } else if (event.type === 'stream_started' || event.type === 'stream_delta') {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
          applyStreamingSocketEvent(current, event, workstreamId, streamCursors));
      } else if (event.type === 'harness_status_changed') {
        applyHarnessStatus(queryClient, workstreamId, normalizeHarnessStatus(event.status));
        if (
          event.status === 'running'
          || event.status === 'needs_input'
          || event.status === 'completed'
          || event.status === 'failed'
          || event.status === 'idle'
        ) {
          void reconcileCanonicalState();
        }
      } else if (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_failed') {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
          const messageId = `tool-${event.invocation.id}`;
          const existing = (current ?? []).find((message) => message.id === messageId);
          const anchorSequenceNumber = existing?.realtimeOrder?.anchorSequenceNumber
            ?? activeStreamAnchor(current)
            ?? nextTranscriptSequence(current);
          return insertMessage(current, createToolEventMessage({
            id: messageId,
            workstreamId,
            sequenceNumber: anchorSequenceNumber,
            authorType: 'agent',
            createdAt: existing?.createdAt ?? event.occurredAt,
            realtimeOrder: {
              anchorSequenceNumber,
              // A completion update must not move the tool below tools that
              // started later in the same turn.
              eventSequence: existing?.realtimeOrder?.eventSequence ?? event.sequence,
              placement: 'before_anchor',
            },
            toolEvent: mapToolInvocation(event.invocation),
          }));
        });
      } else if (event.type === 'elicitation_created' || event.type === 'elicitation_answered') {
        const messageId = elicitationMessageId(event.elicitation.id);
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
          if (event.elicitation.status === 'cancelled') return removeTranscriptMessage(current, messageId);
          return insertMessage(current, createElicitationMessage({
            id: messageId,
            workstreamId,
            sequenceNumber: event.sequence,
            authorType: 'agent',
            createdAt: event.elicitation.createdAt,
            elicitation: mapElicitation(event.elicitation),
          }));
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
        // The detail's pending suggestions are what a transcript rebuild draws
        // its cards from, so a resolution that only reached the transcript
        // would be undone by the next message fetch.
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) => {
          if (!current) return current;
          const remaining = (current.suggestions ?? []).filter((suggestion) => suggestion.id !== event.suggestion.id);
          return {
            ...current,
            // The server lists suggestions newest first, and position in this
            // array decides position in the transcript, so a new one belongs at
            // the head. Appending would make the card jump on the next fetch.
            suggestions: event.suggestion.status === 'pending'
              ? [mapSuggestion(event.suggestion), ...remaining]
              : remaining,
          };
        });
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => insertMessage(current, {
          id: `suggestion-${event.suggestion.id}`,
          workstreamId,
          sequenceNumber: event.sequence,
          authorType: 'system',
          messageType: 'activity_suggestion',
          createdAt: event.suggestion.createdAt,
          activitySuggestion: mapSuggestion(event.suggestion),
        }));
      } else if (event.type === 'hypersight_configuration_updated') {
        queryClient.setQueryData<HyperSight>(['hypersight', workstreamId], event.hypersight);
      } else if (event.type === 'hypersight_block_run_updated') {
        queryClient.setQueryData<HyperSight>(['hypersight', workstreamId], (current) => {
          if (!current || current.versionId !== event.run.configurationVersionId) return current;
          return {
            ...current,
            blocks: current.blocks.map((block) => {
              if (block.id !== event.run.blockId) return block;
              if (
                block.latestRun
                && block.latestRun.id !== event.run.id
                && block.latestRun.triggerSequence > event.run.triggerSequence
              ) return block;
              return { ...block, latestRun: event.run };
            }),
          };
        });
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
          const [canonicalWorkstream, canonicalMessagePage, canonicalWorkstreams] = await Promise.all([
            api.getWorkstream(workstreamId),
            api.getMessages(workstreamId),
            api.getWorkstreams(),
          ]);
          const canonicalMessages = messagesWithTransientBlocks(canonicalMessagePage, canonicalWorkstream);
          if (closedByEffect) return;
          queryClient.setQueryData(['workstream', workstreamId], canonicalWorkstream);
          const mayStillEmitRealtime = runMayStillEmitRealtime(canonicalWorkstream.harnessStatus);
          queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
            mayStillEmitRealtime
              ? mergeCanonicalTranscript(current, canonicalMessages)
              : replaceWithCanonicalTranscript(current, canonicalMessages));
          queryClient.setQueryData(WORKSTREAMS_QUERY_KEY, canonicalWorkstreams);
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['workstream-context', workstreamId] }),
            syncHyperSightQueries(),
          ]);
          streamCursors.clear();
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
          const isReconnect = attempts.current > 0 || lastSequence.current > 0;
          setState('connected');
          nextSocket.send(JSON.stringify({ type: 'subscribe', afterSequence: lastSequence.current }));
          if (isReconnect) void reconcileCanonicalState();
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
            if (event.success) {
              applyEvent(event.data);
              return;
            }
            const personalEvent = PersonalSocketEventSchema.safeParse(parsed);
            if (personalEvent.success) applyPersonalEvent(personalEvent.data);
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
