import {
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  SubstreamDirectSocketEventSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  type AgentCompactionState,
  type ActiveStreamCheckpoint,
  type WorkspaceSocketClientEvent,
  type PersonalSocketEvent,
  type ServerSocketEvent,
} from '@rally/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
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
  type RallyApi,
  type MentionIdentity,
} from './api';
import { elicitationMessageId } from './elicitation';
import { startPerfTrace, type PerfTrace } from './perf-trace';
import { realtimeSocketTelemetry, reportWorkstreamSocketStarted } from './socket-telemetry';
import { advanceStreamReveal, applyRevealedText, flushStreamReveal } from './streaming-reveal';
import {
  reportTelemetryProductIntent,
  type WorkstreamSocketStartReason,
  uuidV7,
  workstreamFeedOpenAttemptId,
  workstreamFeedSourceQueryKey,
  workstreamRecoveryFeedQueryKey,
  workstreamSocketSnapshotGenerationQueryKey,
} from './telemetry';
import {
  appendDismissedSuggestionId,
  createElicitationMessage,
  createTextMessage,
  createToolEventMessage,
  dismissedSuggestionIdsQueryKey,
  isSameLogicalMessage,
  removeTranscriptMessage,
  upsertTranscriptMessage,
  visibleTranscriptMessages,
} from './transcript';
import type { HarnessStatus, BlockDashboard, BlockDashboardPreference, Message, MessagePage, WorkstreamDetail, WorkstreamSummary } from './types';
import { evictCachedWorkstream, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import { useWorkstreamSocketResumeState, type StreamCursor } from './workstream-socket-resume';
import { useWorkspaceSocket } from './workspace-socket';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';

export type { StreamCursor } from './workstream-socket-resume';

export type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

/** The exact API capability the realtime cache reconciler is allowed to use. */
export type WorkstreamSocketApi = Pick<
  RallyApi,
  'getMessages' | 'getSocketTicket' | 'getWorkstreamControlSocketTicket' | 'getWorkstream' | 'messageMentionPayload'
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
  /** The workstream handler can admit sends to the workspace queue. The painted
   * telemetry milestone is reported separately after the consuming UI commits. */
  sendReady: boolean;
  workspaceSocketState: 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
  activeCompaction: AgentCompactionState | null;
  createMessage(input: CreateWorkstreamMessageInput): Promise<Message>;
  loadMessagePage(input: LoadWorkstreamMessagePageInput): Promise<MessagePage>;
  /** Ask the admitted room to replace local base state with one canonical frame. */
  requestSnapshot(): void;
}

export type LoadWorkstreamMessagePageInput =
  | { before: string; limit?: number }
  | { after: string; limit?: number };

type CreateMessageSocketCommand = Extract<WorkspaceSocketClientEvent, { type: 'create_message' }>;

const HEARTBEAT_BASE_MS = 45_000;
const HEARTBEAT_JITTER_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_TIMEOUT_MS = 15_000;
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
 *
 * With `paced` set, the frame's text lands in the cursor's `receivedText` and
 * the transcript keeps showing the revealed prefix — the animation-frame loop
 * in `streaming-reveal.ts` is what grows it. Without it (the document is
 * hidden, or a caller predates pacing) the whole received text is revealed at
 * once, which is the pre-pacing behavior.
 */
export function applyStreamingSocketEvent(
  messages: Message[] | undefined,
  event: StreamingSocketEvent,
  workstreamId: string,
  cursors: Map<string, StreamCursor>,
  options: { paced?: boolean } = {},
): Message[] {
  const paced = options.paced ?? false;
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
  // The received whole, never the cache's revealed prefix: a turn boundary or a
  // retry is positioned in what the wire delivered, not in what pacing has let
  // the reader see so far. A message with no cursor yet holds canonical text,
  // which is complete by definition.
  const previousReceived = cursor?.receivedText ?? existing?.text ?? '';
  const turnStartText = startsNewTurn ? previousReceived : cursor.turnStartText;
  const replacesAttempt = event.reset
    || (!startsNewTurn && event.epoch > cursor.epoch);
  const baseText = replacesAttempt ? turnStartText : previousReceived;
  const receivedText = event.type === 'stream_delta' ? `${baseText}${event.delta}` : baseText;
  const previousRevealed = cursor?.revealed ?? previousReceived.length;
  // A replaced attempt clamps the reveal to the turn's start: text the retry
  // retracted disappears immediately rather than being animated away.
  const revealed = paced
    ? Math.min(
        replacesAttempt ? Math.min(previousRevealed, turnStartText.length) : previousRevealed,
        receivedText.length,
      )
    : receivedText.length;
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
    receivedText,
    revealed,
    lastRevealAt: cursor?.lastRevealAt ?? null,
  });
  const visibleText = receivedText.slice(0, revealed);

  if (event.type === 'stream_started') {
    if (existing) {
      return (messages ?? []).map((message) => message.id === messageId
        ? {
            ...message,
            text: replacesAttempt ? visibleText : message.text,
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
      text: visibleText,
      createdAt: event.occurredAt,
      streaming: true,
      realtimeOrder: {
        anchorSequenceNumber,
        eventSequence: event.sequence,
        placement: 'at_anchor',
      },
    }));
  }
  // A paced delta that changes nothing on screen returns the array untouched,
  // so the cache write is a no-op and the wire's cadence stops costing a
  // commit; the reveal loop owns the visible growth. The event-sequence stamp
  // this skips only ever ordered the streaming row against other at-anchor
  // realtime rows, and there are none: tools sort before the anchor by
  // placement, not by sequence.
  if (paced && existing.streaming === true && (existing.text ?? '') === visibleText) {
    return messages ?? [];
  }
  return (messages ?? []).map((message) => message.id === messageId
    ? {
        ...message,
        text: visibleText,
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
      // A checkpoint is an arrival, not a stream: someone opening a work
      // stream mid-turn gets the accumulated text at once, and pacing begins
      // with the first live delta after it.
      receivedText: checkpoint.text,
      revealed: checkpoint.text.length,
      lastRevealAt: null,
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
 * took, and indefinitely if it raced with an older page already in flight.
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
  if (message.messageType === 'tool_event'
    || message.realtimeOrder !== undefined
    || message.attentionSequenceNumber == null) return workstream;
  const latestAttentionSequenceNumber = Math.max(
    workstream.latestAttentionSequenceNumber,
    message.attentionSequenceNumber,
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
  // The pool owns this separately so a hover-warmed control socket survives
  // the later transition that enables the presence-publishing feed.
  controlSocketOwnedExternally = false,
  initialReason: Exclude<WorkstreamSocketStartReason, 'reconnect'> = 'active_workstream',
  socketLeaseId?: string,
): WorkstreamSocketConnection {
  const queryClient = useQueryClient();
  const {
    createMessage: createWorkspaceMessage,
    state: workspaceSocketState,
  } = useWorkspaceSocket();
  const [generatedSocketLeaseId] = useState(() => socketLeaseId ?? uuidV7());
  const resolvedSocketLeaseId = socketLeaseId ?? generatedSocketLeaseId;
  const initialReasonRef = useRef(initialReason);
  initialReasonRef.current = initialReason;
  useWorkstreamControlSocket(
    api,
    workstreamId,
    enabled && !controlSocketOwnedExternally,
    initialReason,
    resolvedSocketLeaseId,
  );
  const resumeState = useWorkstreamSocketResumeState(workstreamId);
  const [state, setState] = useState<SocketState>('idle');
  const [sendReady, setSendReady] = useState(false);
  const [activeCompaction, setActiveCompaction] = useState<AgentCompactionState | null>(null);
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
  const loadMessagePageRef = useRef<(input: LoadWorkstreamMessagePageInput) => Promise<MessagePage>>(
    () => Promise.reject(new ApiError(
      'The work stream is not ready to load messages.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const loadMessagePage = useCallback(
    (input: LoadWorkstreamMessagePageInput): Promise<MessagePage> => loadMessagePageRef.current(input),
    [],
  );
  const requestSnapshotRef = useRef<() => void>(() => undefined);
  const requestSnapshot = useCallback((): void => requestSnapshotRef.current(), []);

  useEffect(() => {
    attempts.current = 0;
    setActiveCompaction(null);
    if (!api || !enabled) {
      setState('idle');
      setSendReady(false);
      requestSnapshotRef.current = () => undefined;
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The work stream is not ready to receive messages.',
        409,
        'workstream_socket_unavailable',
      ));
      loadMessagePageRef.current = () => Promise.reject(new ApiError(
        'The work stream is not ready to load messages.',
        409,
        'workstream_socket_unavailable',
      ));
      return;
    }
    let closedByEffect = false;
    const socketTelemetry = realtimeSocketTelemetry('substream_feed');
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
    /**
     * One outstanding snapshot request at a time. The room answers with a
     * sequenced frame that supersedes whatever prompted the request, so a
     * second request issued while one is in flight can only ask for state the
     * first will already carry.
     */
    let snapshotRequestInFlight = false;
    /**
     * Whether this socket has yet applied a snapshot.
     *
     * Only the first one is an arrival, and only an arrival wants the reader's
     * resume window; a later snapshot is a repair, and a repair that moved the
     * transcript backwards would undo what the reader just watched.
     */
    let initialSnapshotPending = true;
    const pendingMessagePages = new Map<string, {
      timeout: number;
      resolve: (page: MessagePage) => void;
      reject: (error: Error) => void;
    }>();
    const streamCursors = resumeState.streamCursors;
    /**
     * The paced-reveal loop — `docs/streaming-reveal.md`. Wire frames land in
     * the cursors' `receivedText`; this loop grows each streaming message's
     * visible prefix once per animation frame, so the reveal runs at the
     * display's cadence rather than the batcher's. One frame is armed at a
     * time, and only while something is held back.
     */
    let revealFrame: number | null = null;
    const scheduleReveal = (): void => {
      if (revealFrame !== null || closedByEffect) return;
      revealFrame = window.requestAnimationFrame(() => {
        revealFrame = null;
        if (closedByEffect) return;
        const { changed, backlogRemains } = advanceStreamReveal(streamCursors, performance.now());
        if (changed) {
          queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
            applyRevealedText(current, streamCursors));
        }
        if (backlogRemains) scheduleReveal();
      });
    };
    /**
     * Animation frames stop when the window is hidden, so a stream that keeps
     * arriving would pile up behind a paused reveal. Nobody is watching a
     * hidden window: show everything at once, which is also what new frames do
     * while it stays hidden.
     */
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden') return;
      if (flushStreamReveal(streamCursors)) {
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) =>
          applyRevealedText(current, streamCursors));
      }
    };
    /**
     * When this effect began dialling, so an open trace can report how long the
     * work stream was on screen before its first request left. The trace itself
     * cannot cover that: it opens inside `connect`, and everything that delays
     * `connect` — React committing the route, the screen's own queries, a
     * blocked main thread — happens before there is a trace to record it on.
     */
    const effectStartedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
    const isOffline = (): boolean => navigator.onLine === false;
    /** The open in flight, so a superseded attempt still prints its line. */
    let openTrace: PerfTrace | null = null;

    createMessageRef.current = async (input): Promise<Message> => {
      // Keyed by the client message id, which WorkspaceDO records on its own
      // span as `rally.message.client_id`: the command travels over an
      // already-open socket the platform traces as its own invocation, so this
      // is the only value the renderer and the server both hold.
      const trace = startPerfTrace('workstream_message_send', {
        traceId: input.clientId,
        workstreamId,
      });
      trace.annotate({
        clientMessageId: input.clientId,
        textLength: input.text.length,
        attachmentCount: input.attachmentIds?.length ?? 0,
        mentionCount: input.mentions?.length ?? 0,
      });
      try {
        const mentions = await trace.step('resolve_mentions', () => api.messageMentionPayload(
          input.text,
          input.mentions,
        ));
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
        return await trace.step('command_round_trip', () => createWorkspaceMessage(command));
      } finally {
        trace.end();
      }
    };
    // Readiness means the work-stream-specific handler is installed and can
    // hand a command to the workspace queue. The queue owns reconnecting
    // transport, so this intentionally does not wait for either socket to open.
    setSendReady(true);

    const rejectPendingMessagePages = (error: Error): void => {
      for (const pending of pendingMessagePages.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(error);
      }
      pendingMessagePages.clear();
    };

    loadMessagePageRef.current = (input): Promise<MessagePage> => {
      if (closedByEffect || accessRevoked || socket?.readyState !== WebSocket.OPEN) {
        return Promise.reject(new ApiError(
          'The work stream connection is not ready to load messages.',
          409,
          'workstream_socket_unavailable',
        ));
      }
      const requestId = uuidV7();
      const cursor = 'before' in input
        ? { direction: 'before' as const, value: input.before }
        : { direction: 'after' as const, value: input.after };
      return new Promise<MessagePage>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingMessagePages.delete(requestId);
          reject(new ApiError(
            'The message page request timed out.',
            503,
            'message_page_timeout',
          ));
        }, MESSAGE_PAGE_TIMEOUT_MS);
        pendingMessagePages.set(requestId, { timeout, resolve, reject });
        try {
          socket!.send(JSON.stringify({
            type: 'load_message_page',
            requestId,
            limit: input.limit ?? 200,
            cursor,
          }));
        } catch (error) {
          window.clearTimeout(timeout);
          pendingMessagePages.delete(requestId);
          reject(error instanceof Error ? error : new Error('The message page request could not be sent.'));
        }
      });
    };

    // Only the dashboard itself. `block-dashboard-preference` is a cache read
    // with no fetcher behind it — the control socket's boot frame and
    // `block_dashboard_preference_updated` events write it — so invalidating it
    // can never refetch, and leaving the call here would read as a repair path
    // that no longer exists.
    const syncBlockDashboardQueries = (): Promise<unknown> =>
      queryClient.invalidateQueries({ queryKey: ['block-dashboard', workstreamId], exact: true });

    /**
     * Ask the room to re-send canonical state down the socket already open.
     *
     * The room is the authority for both halves a reconciliation needs, and it
     * assembles them at one sequence: the snapshot frame carries the work
     * stream, the newest transcript page, both cursors, and the active-stream
     * checkpoints together. Two REST reads could not do that — they are
     * separately authorized, separately timed, and can straddle a write, so
     * detail and transcript could disagree with each other.
     *
     * Nothing here waits, and nothing retries. A snapshot is ordered against
     * every other frame, so the reply either supersedes what the client holds
     * or is dropped by the same guard that orders the rest of the feed; there
     * is no "did state move while I was asking?" question to answer, and so no
     * condition under which this can re-arm itself.
     */
    const requestCanonicalSnapshot = (): void => {
      if (closedByEffect || accessRevoked || canonicalResyncTarget !== null) return;
      if (snapshotRequestInFlight) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      snapshotRequestInFlight = true;
      try {
        socket.send(JSON.stringify({ type: 'request_snapshot' }));
      } catch {
        // The runtime delivers the close separately, and reconnecting resubscribes.
        snapshotRequestInFlight = false;
      }
    };
    requestSnapshotRef.current = requestCanonicalSnapshot;

    const applyPersonalEvent = (event: PersonalSocketEvent): void => {
      if (event.type === 'block_dashboard_preference_updated') {
        queryClient.setQueryData<BlockDashboardPreference>(
          ['block-dashboard-preference', workstreamId],
          event.preference,
        );
      }
    };

    const applyEvent = (event: ServerSocketEvent): void => {
      if (event.type === 'resync_required') {
        setActiveCompaction(event.activeCompaction);
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
        // Armed only when a close is still coming, and never reported from
        // here. `readyState` flips to CLOSED before the `close` event is
        // dispatched, so a resync frame delivered in the same task batch as an
        // abrupt close reaches this line with a socket that will still notify:
        // reporting here as well would count one drop twice, the second time
        // with the cause already consumed and so labelled as the server's. The
        // other side is the same — a frame arriving after the close listener
        // has run finds `socket` null, and that drop has been reported too. So
        // the close listener makes the single report, and a cause armed with no
        // close to consume it would be left to mislabel the next one.
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          socketTelemetry.willClose('resync_required');
          socket.close();
        } else scheduleReconnect();
        return;
      }
      // Once replay history is unavailable, subsequent frames cannot safely be
      // applied on top of stale state. Reconnect only after the direct REST
      // snapshot succeeds, retaining the old cursor across failed attempts.
      if (canonicalResyncTarget !== null) return;
      // Both answers the room can give a snapshot request release the slot, and
      // both are read before the ordering guard below. A snapshot it drops is
      // still an answer — one a newer frame has already superseded — and an
      // error frame carries the room's current sequence, so the guard would
      // discard it whenever nothing else has moved. Either one left holding the
      // slot would suppress every later reconciliation on this socket.
      const answersSnapshotRequest = snapshotRequestInFlight
        && (event.type === 'snapshot' || event.type === 'error');
      if (answersSnapshotRequest) snapshotRequestInFlight = false;
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
        setActiveCompaction(event.activeCompaction);
        queryClient.setQueryData<number>(
          workstreamSocketSnapshotGenerationQueryKey(workstreamId),
          (current) => (current ?? 0) + 1,
        );
        queryClient.removeQueries({
          queryKey: workstreamRecoveryFeedQueryKey(workstreamId),
          exact: true,
        });
        queryClient.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'socket_snapshot');
        queryClient.setQueryData(['workstream', workstreamId], mapWorkstreamDetail(event.workstream));
        // The resume window is for *arriving* at a work stream, and only then.
        //
        // Every snapshot carries it, including the ones answering a
        // reconciliation or a reconnect, and this branch replaces the transcript
        // wholesale. Read acknowledgement stops while the window is unfocused,
        // so a reader who tabs away during a run keeps a stale first-unread —
        // and the reconciliation that fires when the run completes would then
        // throw away the messages they just watched arrive and put a 20-message
        // window from far behind in their place. Worse, `activeStreams` below
        // appends rows at the newest sequence, which would leave a hole in the
        // middle of a transcript nothing models a hole in.
        //
        // So: resume only on the first snapshot this socket receives, which is
        // the initial subscribe. After that the newest page is what continuity
        // means, and paging back is how a reader reaches anything older.
        const feed = initialSnapshotPending && event.resumeFeed
          ? event.resumeFeed
          : event.messageFeed;
        initialSnapshotPending = false;
        // Restores what the deleted REST reconciliation did and the initial
        // subscribe never has: collapse an elicitation and its durable answer
        // into one row, and synthesise a row for an open elicitation that has
        // no canonical message yet. Without it a question the agent is waiting
        // on vanishes from the transcript the moment the run goes idle.
        const detail = mapWorkstreamDetail(event.workstream);
        const downloaded = messagesWithTransientBlocks(
          feed.items.map(mapMessage),
          detail,
          queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(workstreamId)),
        );
        queryClient.setQueryData<Message[]>(['messages', workstreamId],
          applyActiveStreamCheckpoints(downloaded, event.activeStreams, workstreamId, streamCursors));
        queryClient.setQueryData(['messages-cursor', workstreamId], feed.nextCursor);
        queryClient.setQueryData(['messages-newer-cursor', workstreamId], feed.newerCursor);
        // The direct socket snapshot is canonical for the newest page. REST is
        // now used only to page older history or recover after resync_required.
        queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
        void syncBlockDashboardQueries();
        // Only when this snapshot answers a reconciliation. The context query
        // is not part of a snapshot, so refreshing it is a side effect of
        // repairing drift rather than of receiving canonical state — and doing
        // it on the initial subscription would put a second context read on the
        // open path, which already makes one.
        if (answersSnapshotRequest) {
          void queryClient.invalidateQueries({ queryKey: ['workstream-context', workstreamId] });
        }
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
        // Rally names a work stream a moment after it is created, and a
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
          applyStreamingSocketEvent(current, event, workstreamId, streamCursors, {
            paced: document.visibilityState !== 'hidden',
          }));
        scheduleReveal();
      } else if (event.type === 'harness_status_changed') {
        applyHarnessStatus(queryClient, workstreamId, normalizeHarnessStatus(event.status));
        if (event.status !== 'running') setActiveCompaction(null);
        if (
          event.status === 'running'
          || event.status === 'needs_input'
          || event.status === 'completed'
          || event.status === 'failed'
          || event.status === 'stopped'
          || event.status === 'idle'
        ) {
          requestCanonicalSnapshot();
        }
      } else if (event.type === 'compaction_started') {
        setActiveCompaction(event.compaction);
      } else if (event.type === 'compaction_finished') {
        setActiveCompaction((current) => current
          && current.harnessRunId === event.harnessRunId
          && current.attemptId === event.attemptId
          && current.compactionIndex === event.compactionIndex
          ? null
          : current);
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
        // Detail is what transcript reconstruction uses, so update it together
        // with the synthetic message or a later snapshot would revive a card
        // that has already been resolved.
        queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) => {
          if (!current) return current;
          const remaining = (current.suggestions ?? []).filter((suggestion) => suggestion.id !== event.suggestion.id);
          return {
            ...current,
            suggestions: event.suggestion.status === 'pending'
              ? [mapSuggestion(event.suggestion), ...remaining]
              : remaining,
          };
        });
        if (event.suggestion.status === 'dismissed') {
          queryClient.setQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(workstreamId), (dismissed) =>
            appendDismissedSuggestionId(dismissed, event.suggestion.id));
        }
        queryClient.setQueryData<Message[]>(['messages', workstreamId], (current) => {
          const messageId = `suggestion-${event.suggestion.id}`;
          if (event.suggestion.status === 'dismissed') return removeTranscriptMessage(current, messageId);
          return insertMessage(current, {
            id: messageId,
            workstreamId,
            sequenceNumber: event.sequence,
            authorType: 'system',
            messageType: 'activity_suggestion',
            createdAt: event.suggestion.createdAt,
            activitySuggestion: mapSuggestion(event.suggestion),
          });
        });
      } else if (event.type === 'block_dashboard_configuration_updated') {
        queryClient.setQueryData<BlockDashboard>(['block-dashboard', workstreamId], event.blockDashboard);
      } else if (event.type === 'block_dashboard_block_run_updated') {
        queryClient.setQueryData<BlockDashboard>(['block-dashboard', workstreamId], (current) => {
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
          socketTelemetry.willClose('heartbeat_timeout');
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
     * waiting for a later workspace state event to notice.
     */
    const handleAccessRevoked = (): void => {
      accessRevoked = true;
      resumeState.lastSequence = 0;
      streamCursors.clear();
      setActiveCompaction(null);
      clearReconnectTimer();
      rejectPendingMessagePages(new ApiError(
        'The work stream is no longer available.',
        404,
        'workstream_access_revoked',
      ));
      setState('unavailable');
      evictCachedWorkstream(queryClient, workstreamId);
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
          const [canonicalWorkstream, canonicalMessagePage] = await Promise.all([
            api.getWorkstream(workstreamId),
            api.getMessages(workstreamId),
          ]);
          const canonicalMessages = messagesWithTransientBlocks(
            canonicalMessagePage,
            canonicalWorkstream,
            queryClient.getQueryData<readonly string[]>(dismissedSuggestionIdsQueryKey(workstreamId)),
          );
          if (closedByEffect) return;
          queryClient.setQueryData(['workstream', workstreamId], canonicalWorkstream);
          const mayStillEmitRealtime = runMayStillEmitRealtime(canonicalWorkstream.harnessStatus);
          setActiveCompaction((current) => mayStillEmitRealtime
            && current?.harnessRunId === canonicalWorkstream.latestHarnessRunId
            ? current
            : null);
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
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ['workstream-context', workstreamId] }),
            syncBlockDashboardQueries(),
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
      // Opening a work stream is a ticket, a handshake, a subscribe, and a
      // snapshot, and only the last of those puts the transcript on screen. The
      // trace ends on the frame that answers the subscribe, so its total is what
      // the person waited for. `ticketId` is what the server's upgrade and room
      // spans carry as `rally.socket.ticket_id`, and the request id joins the
      // ticket call itself. Replaced per attempt: a reconnect is a new open.
      const trace = startPerfTrace('workstream_open', { workstreamId });
      openTrace?.end({ outcome: 'superseded' });
      openTrace = trace;
      reportWorkstreamSocketStarted(
        workstreamId,
        resolvedSocketLeaseId,
        'substream_feed',
        attempts.current === 0 ? initialReasonRef.current : 'reconnect',
        attempts.current,
        trace.traceId,
        workstreamFeedOpenAttemptId(workstreamId),
      );
      trace.annotate({
        attempt: attempts.current,
        afterSequence: resumeState.lastSequence,
        // On attempt zero this is dead time nobody has measured: the work
        // stream is on screen and no request has been made yet. On a reconnect
        // it is the age of the effect, and the backoff explains it.
        sinceEffectMs: Math.round(
          ((typeof performance === 'undefined' ? Date.now() : performance.now()) - effectStartedAt) * 10,
        ) / 10,
      });
      try {
        // Called directly rather than through `trace.step`: the socket-ticket
        // lint rule recognizes a ticket only when the awaited call is the
        // declarator's own initializer, and a `mark` on the next line closes
        // exactly the same span.
        const socketTicket = await api.getSocketTicket(workstreamId, '0', trace.traceId);
        trace.mark('socket_ticket');
        trace.annotate({ ticketId: socketTicket.ticketId ?? null });
        if (closedByEffect) {
          trace.end({ outcome: 'cancelled' });
          return;
        }
        if (isOffline()) {
          trace.end({ outcome: 'offline' });
          socketTelemetry.disconnected({ attempts: attempts.current, retrying: false, cause: 'offline' });
          scheduleReconnect();
          return;
        }
        const nextSocket = new WebSocket(socketTicket.url, socketTicket.protocols);
        // Splits the wait between holding a ticket and being connected into the
        // two halves that have opposite fixes. Nothing is awaited between the
        // ticket resolving and this line, so `dial` can only be large if the
        // renderer was not running — a blocked main thread does not let the
        // continuation execute. Everything after it is the handshake itself.
        // Without the split, one `handshake` number covers both and reads as a
        // slow server either way.
        trace.mark('dial');
        socket = nextSocket;
        nextSocket.addEventListener('open', () => {
          if (closedByEffect || socket !== nextSocket) return;
          // Before the stability timer resets the counter: the depth this
          // handshake arrived at is what the event is measuring.
          socketTelemetry.connected(attempts.current);
          setState('connected');
          trace.mark('handshake');
          // A reconnect needs no separate reconciliation. The cursor makes the
          // subscription itself the reconciliation: the room replays what was
          // missed, sends a snapshot when it cannot, and asks for a resync when
          // it can prove neither. Fetching canonical state alongside it raced
          // that answer and paid two REST round trips to arrive at the same
          // place.
          snapshotRequestInFlight = false;
          nextSocket.send(JSON.stringify({ type: 'subscribe', afterSequence: resumeState.lastSequence }));
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
            const directEvent = SubstreamDirectSocketEventSchema.safeParse(parsed);
            if (directEvent.success) {
              const pending = pendingMessagePages.get(directEvent.data.requestId);
              if (!pending) return;
              pendingMessagePages.delete(directEvent.data.requestId);
              window.clearTimeout(pending.timeout);
              if (directEvent.data.type === 'message_page_error') {
                pending.reject(new ApiError(
                  directEvent.data.message,
                  503,
                  directEvent.data.code,
                ));
              } else {
                pending.resolve({
                  items: visibleTranscriptMessages(directEvent.data.page.items.map(mapMessage)),
                  nextCursor: directEvent.data.page.nextCursor,
                  newerCursor: directEvent.data.page.newerCursor,
                });
              }
              return;
            }
            const event = ServerSocketEventSchema.safeParse(parsed);
            if (event.success) {
              if (openTrace === trace) {
                // The first server frame after `subscribe` is the one that
                // fills the screen — a snapshot, a replayed event, or the
                // resync that sends the client to HTTP instead. Which of the
                // three arrived is most of the diagnosis.
                trace.mark('first_frame');
                trace.end({
                  outcome: event.data.type,
                  ...(event.data.type === 'snapshot'
                    ? { messageCount: event.data.messageFeed.items.length }
                    : {}),
                });
                openTrace = null;
              }
              applyEvent(event.data);
              return;
            }
            const personalEvent = PersonalSocketEventSchema.safeParse(parsed);
            if (personalEvent.success) {
              applyPersonalEvent(personalEvent.data);
              return;
            }
          } catch {
            // Invalid frames are ignored; the next object snapshot or requested
            // page remains authoritative and can replace this transport gap.
          }
        });
        nextSocket.addEventListener('close', (closeEvent) => {
          if (socket !== nextSocket) return;
          if (openTrace === trace) {
            trace.end({ outcome: 'closed', closeCode: closeEvent.code });
            openTrace = null;
          }
          clearHeartbeat();
          clearStabilityTimer();
          rejectPendingMessagePages(new ApiError(
            'The work stream connection closed while loading messages.',
            503,
            'workstream_socket_closed',
          ));
          socket = null;
          if (closeEvent.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            socketTelemetry.disconnected({
              attempts: attempts.current,
              retrying: false,
              cause: 'access_revoked',
            });
            handleAccessRevoked();
            return;
          }
          if (!closedByEffect) {
            socketTelemetry.disconnected({ attempts: attempts.current, retrying: !isOffline() });
          }
          scheduleReconnect();
        });
        nextSocket.addEventListener('error', () => {
          // The producer's pending cause belongs to the loop, not to one
          // socket, so an error delivered for a socket this loop has already
          // replaced would arm `transport_error` on the live one and mislabel
          // its next drop. Every other listener here opens with this check.
          if (closedByEffect || socket !== nextSocket) return;
          clearHeartbeat();
          clearStabilityTimer();
          socketTelemetry.willClose('transport_error');
          try {
            nextSocket.close();
          } catch {
            if (socket === nextSocket) socket = null;
            if (!closedByEffect) {
              // Named rather than inherited from the `willClose` two lines up:
              // no close event is coming to consume it, and a later reader
              // moving either line would silently turn this into the server's.
              socketTelemetry.disconnected({
                attempts: attempts.current,
                retrying: !isOffline(),
                cause: 'transport_error',
              });
            }
            scheduleReconnect();
          }
        });
      } catch {
        trace.end({ outcome: 'failed' });
        if (openTrace === trace) openTrace = null;
        if (!closedByEffect) {
          socketTelemetry.disconnected({
            attempts: attempts.current,
            retrying: !isOffline(),
            cause: 'ticket_failed',
          });
        }
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
      if (socket) socketTelemetry.willClose('offline');
      socket?.close();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void connect();
    // The cursors survive this effect — they live in the resume state — so a
    // remount can inherit a reveal already in progress. Without this the held
    // prefix would sit until the next wire frame arrived to restart the loop —
    // and a mount in an already-hidden window cannot wait on an animation
    // frame at all, because none will fire until the window is shown; hidden
    // means nobody is watching, so the inherited backlog shows at once.
    if (document.visibilityState === 'hidden') {
      handleVisibilityChange();
    } else if ([...streamCursors.values()].some(
      (cursor) => !cursor.completed && cursor.revealed < cursor.receivedText.length,
    )) scheduleReveal();
    return () => {
      closedByEffect = true;
      setSendReady(false);
      requestSnapshotRef.current = () => undefined;
      openTrace?.end({ outcome: 'unmounted' });
      openTrace = null;
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The work stream is no longer available.',
        409,
        'workstream_socket_unavailable',
      ));
      loadMessagePageRef.current = () => Promise.reject(new ApiError(
        'The work stream is no longer available.',
        409,
        'workstream_socket_unavailable',
      ));
      rejectPendingMessagePages(new ApiError(
        'The work stream changed while loading messages.',
        409,
        'workstream_socket_unavailable',
      ));
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (revealFrame !== null) {
        window.cancelAnimationFrame(revealFrame);
        revealFrame = null;
      }
      clearReconnectTimer();
      clearHeartbeat();
      clearStabilityTimer();
      socket?.close();
    };
  }, [api, createWorkspaceMessage, enabled, queryClient, resolvedSocketLeaseId, resumeState, workstreamId]);

  return useMemo(
    () => ({
      state,
      sendReady,
      workspaceSocketState,
      activeCompaction,
      createMessage,
      loadMessagePage,
      requestSnapshot,
    }),
    [activeCompaction, createMessage, loadMessagePage, requestSnapshot, sendReady, state, workspaceSocketState],
  );
}
