import {
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  type ActiveStreamCheckpoint,
  type WorkspaceSocketClientEvent,
  type PersonalSocketEvent,
  type ServerSocketEvent,
} from '@avalon/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  mapElicitation,
  mapMessage,
  messagesWithTransientBlocks,
  mapParticipant,
  mapResource,
  mapToolInvocation,
  mapViewer,
  mapWorkstreamDetail,
  normalizeHarnessStatus,
  type AvalonApi,
  type MentionIdentity,
} from './api';
import { elicitationMessageId } from './elicitation';
import { reportTelemetryProductIntent, uuidV7 } from './telemetry';
import {
  createElicitationMessage,
  createTextMessage,
  createToolEventMessage,
  isSameLogicalMessage,
  removeTranscriptMessage,
  upsertTranscriptMessage,
} from './transcript';
import type { HarnessStatus, HyperSight, HyperSightPreference, Message, WorkstreamDetail, WorkstreamSummary } from './types';
import { mergeCachedWorkstreamPage, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import { useWorkstreamSocketResumeState, type StreamCursor } from './workstream-socket-resume';
import { useWorkspaceSocket } from './workspace-socket';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';

export type { StreamCursor } from './workstream-socket-resume';

export type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

/** The exact API capability the realtime cache reconciler is allowed to use. */
export type WorkstreamSocketApi = Pick<
  AvalonApi,
  'getMessages' | 'getSocketTicket' | 'getWorkstreamControlSocketTicket' | 'getWorkstream' | 'getWorkstreams' | 'messageMentionPayload'
>;

export interface CreateWorkstreamMessageInput {
  text: string;
  clientId: string;
  mentions?: MentionIdentity[];
  confirmedParticipantUserIds?: string[];
  attachmentIds?: string[];
}

export interface WorkstreamSocketConnection {
  state: SocketState;
  createMessage(input: CreateWorkstreamMessageInput): Promise<Message>;
}

type CreateMessageSocketCommand = Extract<WorkspaceSocketClientEvent, { type: 'create_message' }>;

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
 * Install the exact accumulated text carried by an initial room snapshot. The
 * cursor lands with the text, so replayed overlap is ignored while the first
 * genuinely newer chunk appends in place to the same transcript row.
 */
export function applyActiveStreamCheckpoints(
  messages: Message[] | undefined,
  checkpoints: readonly ActiveStreamCheckpoint[],
  workstreamId: string,
  cursors: Map<string, StreamCursor>,
): Message[] {
  let nextMessages = messages ?? [];
  for (const checkpoint of checkpoints) {
    const cursor = cursors.get(checkpoint.messageId);
    if (cursor && cursor.roomSequence > checkpoint.roomSequence) continue;
    cursors.set(checkpoint.messageId, {
      turnId: checkpoint.turnId,
      epoch: checkpoint.epoch,
      streamSeq: checkpoint.streamSeq,
      seenTurnIds: new Set(checkpoint.seenTurnIds),
      turnStartText: checkpoint.text.slice(0, checkpoint.turnStartOffset),
      roomSequence: checkpoint.roomSequence,
      completed: false,
    });

    const existing = nextMessages.find((message) => message.id === checkpoint.messageId);
    if (existing) {
      if (
        existing.text === checkpoint.text
        && existing.streaming === true
        && existing.realtimeOrder?.eventSequence === checkpoint.roomSequence
      ) continue;
      nextMessages = nextMessages.map((message) => message.id === checkpoint.messageId
        ? {
            ...message,
            text: checkpoint.text,
            streaming: true,
            realtimeOrder: message.realtimeOrder
              ? { ...message.realtimeOrder, eventSequence: checkpoint.roomSequence }
              : message.realtimeOrder,
          }
        : message);
      continue;
    }

    const anchorSequenceNumber = nextTranscriptSequence(nextMessages);
    nextMessages = insertMessage(nextMessages, createTextMessage({
      id: checkpoint.messageId,
      workstreamId,
      sequenceNumber: anchorSequenceNumber,
      authorType: 'agent',
      text: checkpoint.text,
      createdAt: checkpoint.createdAt,
      streaming: true,
      realtimeOrder: {
        anchorSequenceNumber,
        eventSequence: checkpoint.roomSequence,
        placement: 'at_anchor',
      },
    }));
  }
  return nextMessages;
}

/**
 * A REST refresh replaces canonical transcript rows, but an active assistant
 * stream and realtime tool updates do not yet exist in D1. Retain both until
 * their canonical rows arrive. In particular, the streaming row must survive
 * the refresh a socket handoff triggers: removing and recreating it makes the
 * response visibly pop and loses the prefix that replayed deltas append to.
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
  const streamingAgentMessages = (previous ?? []).filter((message) =>
    message.authorType === 'agent'
    && message.streaming === true
    && !canonicalIds.has(message.id),
  );
  const pendingHumanMessages = (previous ?? []).filter((message) =>
    message.authorType === 'human'
    && message.deliveryState === 'sending'
    && !canonicalIds.has(message.id)
    && !canonical.some((candidate) => isSameLogicalMessage(message, candidate)),
  );
  const realtimeMessages = [
    ...realtimeTools,
    ...streamingAgentMessages,
    ...pendingHumanMessages,
  ];
  const canonicalById = new Map(canonical.map((message) => [message.id, message]));
  const settledRealtimeAnchors = new Map<number, number>();
  for (const message of previous ?? []) {
    const canonicalMessage = canonicalById.get(message.id);
    if (message.realtimeOrder && canonicalMessage) {
      settledRealtimeAnchors.set(
        message.realtimeOrder.anchorSequenceNumber,
        canonicalMessage.sequenceNumber,
      );
    }
  }
  const anchorsThatMustFollowCanonical = new Set(
    [...streamingAgentMessages, ...pendingHumanMessages]
      .flatMap((message) => message.realtimeOrder ? [message.realtimeOrder.anchorSequenceNumber] : []),
  );
  const firstRealtimeAnchor = [...anchorsThatMustFollowCanonical].reduce(
    (lowest, anchor) => Math.min(lowest, anchor),
    Number.POSITIVE_INFINITY,
  );
  const canonicalBoundary = nextTranscriptSequence([...olderPersistedMessages, ...canonical]);
  const anchorShift = Number.isFinite(firstRealtimeAnchor)
    ? Math.max(0, canonicalBoundary - firstRealtimeAnchor)
    : 0;
  const reanchoredRealtimeMessages = anchorShift === 0 && settledRealtimeAnchors.size === 0
    ? realtimeMessages
    : realtimeMessages.map((message) => message.realtimeOrder
      ? {
          ...message,
          realtimeOrder: {
            ...message.realtimeOrder,
            anchorSequenceNumber: settledRealtimeAnchors.get(message.realtimeOrder.anchorSequenceNumber)
              ?? (anchorsThatMustFollowCanonical.has(message.realtimeOrder.anchorSequenceNumber)
                ? message.realtimeOrder.anchorSequenceNumber + anchorShift
                : message.realtimeOrder.anchorSequenceNumber),
          },
        }
      : message);
  return orderTranscript([
    ...olderPersistedMessages,
    ...canonical,
    ...reanchoredRealtimeMessages,
  ]);
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

export function runMayStillEmitRealtime(status: WorkstreamDetail['harnessStatus']): boolean {
  return status === 'running' || status === 'scheduled';
}

export function reconcileCanonicalTranscript(
  previous: Message[] | undefined,
  canonical: Message[],
  harnessStatus: WorkstreamDetail['harnessStatus'],
): Message[] {
  return runMayStillEmitRealtime(harnessStatus)
    ? mergeCanonicalTranscript(previous, canonical)
    : replaceWithCanonicalTranscript(previous, canonical);
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
  setCachedWorkstreams(queryClient, (current) =>
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
  api: WorkstreamSocketApi | null,
  workstreamId: string,
  enabled: boolean,
): WorkstreamSocketConnection {
  const queryClient = useQueryClient();
  const { createMessage: createWorkspaceMessage } = useWorkspaceSocket();
  useWorkstreamControlSocket(api, workstreamId, enabled);
  const resumeState = useWorkstreamSocketResumeState(workstreamId);
  const [state, setState] = useState<SocketState>('idle');
  const attempts = useRef(0);
  const createMessageRef = useRef<(input: CreateWorkstreamMessageInput) => Promise<Message>>(
    () => Promise.reject(new ApiError(
      'The work stream is not ready to receive messages.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const createMessage = useCallback(
    (input: CreateWorkstreamMessageInput): Promise<Message> => createMessageRef.current(input),
    [],
  );

  useEffect(() => {
    attempts.current = 0;
    if (!api || !enabled) {
      setState('idle');
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The work stream is not ready to receive messages.',
        409,
        'workstream_socket_unavailable',
      ));
      return;
    }
    let closedByEffect = false;
    // Separate from `closedByEffect`, which means this hook is tearing down. The
    // work stream is still on screen here; it is the reader who is no longer in
    // it, and nothing should dial back until the effect re-runs on a work stream
    // they can read.
    let accessRevoked = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let stabilityTimer: number | null = null;
    let ticketRequestInFlight = false;
    let canonicalResyncInFlight = false;
    let canonicalResyncTarget: number | null = null;
    let canonicalResyncActiveStreams: readonly ActiveStreamCheckpoint[] = [];
    let canonicalReconcileGeneration = 0;
    const streamCursors = resumeState.streamCursors;
    const isOffline = (): boolean => navigator.onLine === false;

    createMessageRef.current = async (input): Promise<Message> => {
      const mentions = await api.messageMentionPayload(
        workstreamId,
        input.text,
        input.mentions,
      );
      if (closedByEffect || accessRevoked) {
        throw new ApiError(
          'The work stream is no longer available.',
          409,
          'workstream_socket_unavailable',
        );
      }
      const operationId = uuidV7();
      reportTelemetryProductIntent({ kind: 'run_requested', entrypoint: 'composer', operationId });
      const command: CreateMessageSocketCommand = {
        type: 'create_message',
        workstreamId,
        substreamId: '0',
        operationId,
        payload: {
          text: input.text,
          clientMessageId: input.clientId,
          mentions,
          confirmedParticipantUserIds: input.confirmedParticipantUserIds ?? [],
          attachmentIds: input.attachmentIds ?? [],
        },
      };
      return createWorkspaceMessage(command);
    };

    const syncHyperSightQueries = (): Promise<unknown> => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hypersight', workstreamId], exact: true }),
      queryClient.invalidateQueries({ queryKey: ['hypersight-preference', workstreamId], exact: true }),
    ]);

    const reconcileCanonicalState = async (): Promise<void> => {
      const generation = ++canonicalReconcileGeneration;
      const sequenceAtStart = resumeState.lastSequence;
      try {
        const [canonicalWorkstream, canonicalMessagePage, canonicalWorkstreamPage] = await Promise.all([
          api.getWorkstream(workstreamId),
          api.getMessages(workstreamId),
          api.getWorkstreams(),
        ]);
        const canonicalMessages = messagesWithTransientBlocks(canonicalMessagePage, canonicalWorkstream);
        if (closedByEffect || generation !== canonicalReconcileGeneration) return;
        if (resumeState.lastSequence > sequenceAtStart) {
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
        mergeCachedWorkstreamPage(queryClient, canonicalWorkstreamPage.items);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
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
        canonicalResyncActiveStreams = event.reason === 'history_unavailable'
          ? event.activeStreams
          : [];
        if (canonicalResyncActiveStreams.length > 0) {
          queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
            applyActiveStreamCheckpoints(current, canonicalResyncActiveStreams, workstreamId, streamCursors));
        }
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
        if (event.sequence < resumeState.lastSequence) return;
        resumeState.lastSequence = event.sequence;
        streamCursors.clear();
      } else {
        if (event.sequence <= resumeState.lastSequence) return;
        resumeState.lastSequence = event.sequence;
      }

      if (event.type === 'snapshot') {
        queryClient.setQueryData(['workstream', workstreamId], mapWorkstreamDetail(event.workstream));
        const downloaded = event.messageFeed.items.map(mapMessage);
        queryClient.setQueryData<Message[]>(['messages', workstreamId],
          applyActiveStreamCheckpoints(downloaded, event.activeStreams, workstreamId, streamCursors));
        // The direct socket snapshot is canonical for the newest page. REST is
        // now used only to page older history or recover after resync_required.
        queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
        void syncHyperSightQueries();
      } else if (event.type === 'presence_changed') {
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? { ...current, viewers: event.viewers.map(mapViewer) } : current,
        );
      } else if (event.type === 'message_created') {
        const message = mapMessage(event.message);
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => insertMessage(current, message));
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? advanceWorkstreamAttention(current, message) : current);
        setCachedWorkstreams(queryClient, (current) =>
          current?.map((workstream) => workstream.id === workstreamId
            ? advanceWorkstreamAttention(workstream, message)
            : workstream));
      } else if (event.type === 'workstream_renamed') {
        // Avalon names a work stream a moment after it is created, and a
        // participant can rename one at any time. Both arrive here, and both
        // have to reach the header and the sidebar row without a refetch.
        // Whichever status the event carries, the title has stopped being a
        // placeholder, so the skeleton comes down — including when naming
        // failed and the line taken from the request is what stands. It is
        // `automatic` when a later pass may still improve on the name and
        // `settled` when nothing will change it again; the event says which,
        // and neither is a reason to keep waiting.
        const renamed = { title: event.title, titleStatus: event.titleStatus };
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? { ...current, ...renamed } : current);
        setCachedWorkstreams(queryClient, (current) =>
          current?.map((workstream) => workstream.id === workstreamId
            ? { ...workstream, ...renamed }
            : workstream));
      } else if (event.type === 'workstream_scope_changed') {
        // Whoever this change excluded has already been disconnected by the
        // room, so everyone still here may read it and only needs the lock on
        // their sidebar row and the header they are reading to agree.
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
          current ? { ...current, scope: event.scope } : current);
        setCachedWorkstreams(queryClient, (current) =>
          current?.map((workstream) => workstream.id === workstreamId
            ? { ...workstream, scope: event.scope }
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
        setCachedWorkstreams(queryClient, (current) =>
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

    /**
     * The room closed this socket because the reader may no longer see the work
     * stream — it went private without them, or they were taken out of it.
     *
     * Reconnecting is the one thing that must not happen: the ticket request
     * behind it now answers 404, and the generic close path would retry that
     * forever while the transcript already fetched stayed on screen. Dropping
     * the cached work stream instead lets the screen's existing "could not be
     * opened" state take over, and takes the sidebar row with it rather than
     * waiting for the list poll to notice.
     */
    const handleAccessRevoked = (): void => {
      accessRevoked = true;
      resumeState.lastSequence = 0;
      streamCursors.clear();
      clearReconnectTimer();
      setState('unavailable');
      queryClient.removeQueries({ queryKey: ['messages', workstreamId], exact: true });
      setCachedWorkstreams(queryClient, (current) =>
        current?.filter((workstream) => workstream.id !== workstreamId));
      queryClient.removeQueries({ queryKey: ['workstream', workstreamId], exact: true });
    };

    const scheduleReconnect = (): void => {
      if (closedByEffect || accessRevoked) return;
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
          const [canonicalWorkstream, canonicalMessagePage, canonicalWorkstreamPage] = await Promise.all([
            api.getWorkstream(workstreamId),
            api.getMessages(workstreamId),
            api.getWorkstreams(),
          ]);
          const canonicalMessages = messagesWithTransientBlocks(canonicalMessagePage, canonicalWorkstream);
          if (closedByEffect) return;
          queryClient.setQueryData(['workstream', workstreamId], canonicalWorkstream);
          const mayStillEmitRealtime = runMayStillEmitRealtime(canonicalWorkstream.harnessStatus);
          const validatedActiveStreams = mayStillEmitRealtime
            ? canonicalResyncActiveStreams.filter((checkpoint) =>
                checkpoint.harnessRunId === canonicalWorkstream.latestHarnessRunId)
            : [];
          queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
            const canonicalTranscript = replaceWithCanonicalTranscript(current, canonicalMessages);
            streamCursors.clear();
            return applyActiveStreamCheckpoints(
              canonicalTranscript,
              validatedActiveStreams,
              workstreamId,
              streamCursors,
            );
          });
          mergeCachedWorkstreamPage(queryClient, canonicalWorkstreamPage.items);
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ['workstream-context', workstreamId] }),
            syncHyperSightQueries(),
          ]);
          resumeState.lastSequence = Math.max(resumeState.lastSequence, targetSequence);
          if (canonicalResyncTarget === targetSequence) {
            canonicalResyncTarget = null;
            canonicalResyncActiveStreams = [];
          }
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
        const nextSocket = new WebSocket(socketTicket.url, socketTicket.protocols);
        socket = nextSocket;
        nextSocket.addEventListener('open', () => {
          if (closedByEffect || socket !== nextSocket) return;
          const isReconnect = attempts.current > 0 || resumeState.lastSequence > 0;
          setState('connected');
          nextSocket.send(JSON.stringify({ type: 'subscribe', afterSequence: resumeState.lastSequence }));
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
            if (personalEvent.success) {
              applyPersonalEvent(personalEvent.data);
              return;
            }
          } catch {
            // Invalid frames are ignored; canonical REST state remains authoritative.
          }
        });
        nextSocket.addEventListener('close', (closeEvent) => {
          if (socket !== nextSocket) return;
          clearHeartbeat();
          clearStabilityTimer();
          socket = null;
          if (closeEvent.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            handleAccessRevoked();
            return;
          }
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
      if (closedByEffect || accessRevoked) return;
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
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
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The work stream is no longer available.',
        409,
        'workstream_socket_unavailable',
      ));
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearReconnectTimer();
      clearHeartbeat();
      clearStabilityTimer();
      socket?.close();
    };
  }, [api, createWorkspaceMessage, enabled, queryClient, resumeState, workstreamId]);

  return { state, createMessage };
}
