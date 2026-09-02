import {
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  WorkstreamSocketCommandResultSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  type AgentCompactionState,
  type ActiveStreamCheckpoint,
  type ClientSocketEvent,
  type PersonalSocketEvent,
  type ServerSocketEvent,
  type PendingTranscriptInput,
  type WorkstreamTranscriptSnapshot,
  type WorkstreamMessageAdmissionReceipt,
  type TranscriptRange,
  type TranscriptRangeResult,
} from '@rally/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  mapElicitation,
  mapParticipant,
  mapResource,
  mapToolInvocation,
  mapWorkstreamDetail,
  normalizeHarnessStatus,
  type RallyApi,
  type MentionIdentity,
} from './api';
import { elicitationMessageId } from './elicitation';
import { startPerfTrace, type PerfTrace } from './perf-trace';
import { realtimeSocketTelemetry, reportWorkstreamSocketStarted } from './socket-telemetry';
import {
  createRealtimeSocket,
  REALTIME_SOCKET_CLOSED,
  REALTIME_SOCKET_CONNECTING,
  REALTIME_SOCKET_OPEN,
  type RealtimeSocket,
  type RealtimeSocketHandshakePhaseEvent,
} from './realtime-socket';
import { advanceStreamReveal, applyRevealedText, flushStreamReveal } from './streaming-reveal';
import {
  reportTelemetryProductIntent,
  type WorkstreamSocketStartReason,
  uuidV7,
  workstreamFeedOpenAttemptId,
  workstreamFeedSourceQueryKey,
  workstreamSocketSnapshotGenerationQueryKey,
} from './telemetry';
import {
  createElicitationMessage,
  createTextMessage,
  createToolEventMessage,
  mergeRealtimeTranscriptActivity,
  mergeRealtimeTranscriptTurn,
  mergeCanonicalTranscriptSnapshot,
  mergeTranscriptRange,
  mapTranscriptOverlayMessages,
  pendingTranscriptInputOverlay,
  orderedTranscriptMessages,
  reconcileAuthoritativeTranscriptOverlays,
  removeTranscriptOverlay,
  replaceTranscriptOverlay,
  transcriptOverlaysQueryKey,
  transcriptOverlaysWithoutCanonicalMatch,
  type TranscriptOverlay,
  type TranscriptOverlayIdentity,
  upsertTranscriptOverlay,
  upsertTranscriptMessage,
} from './transcript';
import type { HarnessStatus, BlockDashboard, BlockDashboardPreference, Message, WorkstreamDetail, WorkstreamSummary } from './types';
import { withDerivedUnread } from './workstream-state-store';
import { evictCachedWorkstream, setCachedWorkstreams, WORKSTREAMS_QUERY_KEY } from './workstreams-cache';
import { useWorkstreamSocketResumeState, type StreamCursor } from './workstream-socket-resume';
import { useWorkstreamControlSocket } from './use-workstream-control-socket';

export type { StreamCursor } from './workstream-socket-resume';

export type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
export type WorkstreamMessageDeliveryMode = 'steer' | 'queue';

/** The exact API capability the realtime cache reconciler is allowed to use. */
export type WorkstreamSocketApi = Pick<
  RallyApi,
  'getSocketTicket' | 'getWorkstreamControlSocketTicket' | 'getWorkstream' | 'messageMentionPayload'
  // Read, not called: which arriving turns are the reader's own.
  | 'viewerUserId'
>;

export interface CreateWorkstreamMessageInput {
  text: string;
  clientId: string;
  mentions?: MentionIdentity[];
  confirmedParticipantUserIds?: string[];
  attachmentIds?: string[];
  runMode?: WorkstreamMessageDeliveryMode;
}

export interface WorkstreamSocketConnection {
  state: SocketState;
  /** The workstream handler can admit sends to the room-socket queue. The painted
   * telemetry milestone is reported separately after the consuming UI commits. */
  sendReady: boolean;
  /** Legacy telemetry field name; this now reports the message-carrying room socket. */
  workspaceSocketState: 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
  activeCompaction: AgentCompactionState | null;
  createMessage(input: CreateWorkstreamMessageInput): Promise<AcceptedWorkstreamTurn>;
  loadTranscriptRange(input: {
    snapshotId: string;
    range: TranscriptRange;
    resumeAfterEventSequence: number;
  }): Promise<TranscriptRangeResult>;
  /** Ask the admitted room to replace local base state with one canonical frame. */
  requestSnapshot(): void;
}

export type AcceptedWorkstreamTurn = WorkstreamMessageAdmissionReceipt['turn']
  & Pick<WorkstreamMessageAdmissionReceipt, 'deliveryState'>;

type CreateMessageSocketCommand = Extract<ClientSocketEvent, { type: 'create_message' }>;

interface PendingMessageCommand {
  command: CreateMessageSocketCommand;
  resolve: (turn: AcceptedWorkstreamTurn) => void;
  reject: (error: Error) => void;
}

const HEARTBEAT_BASE_MS = 45_000;
const HEARTBEAT_JITTER_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
const TRANSCRIPT_RANGE_TIMEOUT_MS = 15_000;
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

  const placement = (message: Message): number => message.realtimeOrder?.placement === 'before_anchor'
    ? 0
    : message.realtimeOrder?.placement === 'after_anchor'
      ? 2
      : 1;
  const aPlacement = placement(a);
  const bPlacement = placement(b);
  if (aPlacement !== bPlacement) return aPlacement - bPlacement;

  const aRealtimeSequence = a.realtimeOrder?.eventSequence;
  const bRealtimeSequence = b.realtimeOrder?.eventSequence;
  if (aRealtimeSequence !== undefined && bRealtimeSequence !== undefined && aRealtimeSequence !== bRealtimeSequence) {
    return aRealtimeSequence - bRealtimeSequence;
  }
  if (a.sequenceNumber !== b.sequenceNumber) return a.sequenceNumber - b.sequenceNumber;
  // Wall clocks are metadata, never ordering authority. When two overlays
  // share every explicit position, stable identity is the deterministic tie.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  return event.turnId;
}

/**
 * Applies a model stream frame independently of room replay ordering. Bind can
 * retry a turn or switch routes after already emitting text, so room sequence
 * de-duplication alone is insufficient: a newer epoch must replace only that
 * turn's prior attempt and repeated chunks must not be appended twice. Bind
 * assigns a new turn ID after tool execution; that is a new participant-visible
 * model turn and therefore a new row. Keeping the run's stream ID
 * here was what moved later narration above tools that had already completed.
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
  if (!cursor) {
    let closedPriorTurn = false;
    for (const [priorTurnId, prior] of cursors) {
      if (priorTurnId === messageId || prior.streamId !== event.streamId || prior.completed) continue;
      cursors.set(priorTurnId, {
        ...prior,
        completed: true,
        revealed: prior.receivedText.length,
      });
      closedPriorTurn = true;
    }
    if (closedPriorTurn) {
      messages = (messages ?? []).map((message) => {
        const prior = cursors.get(message.id);
        return prior?.streamId === event.streamId && prior.completed
          ? { ...message, text: prior.receivedText, streaming: false }
          : message;
      });
    }
  }
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
  const startsNewTurn = !cursor;
  // The received whole, never the cache's revealed prefix: a turn boundary or a
  // retry is positioned in what the wire delivered, not in what pacing has let
  // the reader see so far. A message with no cursor yet holds canonical text,
  // which is complete by definition.
  const previousReceived = cursor?.receivedText ?? existing?.text ?? '';
  const turnStartText = startsNewTurn ? '' : cursor.turnStartText;
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
    streamId: event.streamId,
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
      transcriptTurnId: event.turnId,
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
      transcriptTurnId: event.turnId,
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
    const messageId = checkpoint.turnId;
    const checkpointText = checkpoint.text.slice(checkpoint.turnStartOffset);
    const cursor = cursors.get(messageId);
    if (cursor && cursor.roomSequence > checkpoint.roomSequence) continue;
    cursors.set(messageId, {
      streamId: checkpoint.streamId,
      turnId: checkpoint.turnId,
      epoch: checkpoint.epoch,
      streamSeq: checkpoint.streamSeq,
      seenTurnIds: new Set(checkpoint.seenTurnIds),
      turnStartText: '',
      roomSequence: checkpoint.roomSequence,
      completed: false,
      // A checkpoint is an arrival, not a stream: someone opening a work
      // stream mid-turn gets the accumulated text at once, and pacing begins
      // with the first live delta after it.
      receivedText: checkpointText,
      revealed: checkpointText.length,
      lastRevealAt: null,
    });

    const existing = nextMessages.find((message) => message.id === messageId);
    if (existing) {
      if (
        existing.text === checkpointText
        && existing.streaming === true
        && existing.realtimeOrder?.eventSequence === checkpoint.roomSequence
      ) continue;
      nextMessages = nextMessages.map((message) => message.id === messageId
        ? {
            ...message,
            text: checkpointText,
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
      id: messageId,
      transcriptTurnId: checkpoint.turnId,
      workstreamId,
      sequenceNumber: anchorSequenceNumber,
      authorType: 'agent',
      text: checkpointText,
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

function runMayStillEmitRealtime(status: WorkstreamDetail['harnessStatus']): boolean {
  return status === 'running' || status === 'scheduled';
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

/**
 * Move a work stream's attention state forward for one arriving canonical turn,
 * ahead of the viewer state the room will publish for it.
 *
 * The one thing it must not get wrong is the reader's own turn. A message is
 * read by the person who wrote it — the room says so, advancing that author's
 * `seen_attention_ordinal` to their own message in the same write that stores
 * it — and this runs a beat before that state arrives. Guessing "unread" in the
 * gap is not a harmless early guess: it is corrected within a few hundred
 * milliseconds, and what a person sees in those milliseconds is an **Unread
 * messages** divider drawn above the message they just sent, and their own
 * sidebar dot lighting for it. So the waterline is advanced here rather than
 * waited for.
 *
 * **The manual mark is deliberately left alone.** The room clears it in that
 * same write, and this function does not, because it cannot tell a mark that
 * predates the turn from one made after it. `markUnread` stores
 * `manual_unread_from_ordinal = latest`, which for a turn the reader just sent
 * is that turn's own ordinal, so no ordinal comparison separates the two; the
 * ordering lives in `manualUnreadGeneration`, and a turn frame does not carry
 * the generation it was written under. A delayed or replayed own turn — this
 * client reconnecting, or the same account marking the stream unread on another
 * device — would therefore erase a newer decision the room is still honouring.
 * Leaving it costs nothing the flash cared about: a mark is null on an ordinary
 * send, and when it is not, the reader asked for that divider and the room's own
 * viewer state is what clears it.
 *
 * **`youAreMentioned` goes with the waterline**, because the room derives it as
 * `latest_mention_attention_ordinal > seen_attention_ordinal` rather than
 * storing it: the write that advances the author's own seen ordinal past a
 * mention clears the flag too. Leaving it set would defeat the point of the
 * rule — `mentioned` outranks `unread` in `MARKER_PRECEDENCE` and puts the row
 * in **Needs attention** — so the reader's own reply would swap one wrongly lit
 * dot for a louder one. Unlike the manual mark this *can* be fenced honestly:
 * it is cleared only when the arriving turn is the newest attention event this
 * client knows of, so a mention that landed after it survives a replay.
 *
 * `viewerUserId` is null before sign-in, when nothing is anybody's own message.
 */
function advanceWorkstreamAttention<T extends WorkstreamSummary>(
  workstream: T,
  message: Message,
  viewerUserId: string | null,
): T {
  if (message.messageType === 'tool_event'
    || message.realtimeOrder !== undefined
    || message.attentionSequenceNumber == null) return workstream;
  const latestAttentionSequenceNumber = Math.max(
    workstream.latestAttentionSequenceNumber,
    message.attentionSequenceNumber,
  );
  const ownTurn = viewerUserId !== null && message.author?.id === viewerUserId;
  const readThroughSequenceNumber = ownTurn
    ? Math.max(workstream.readThroughSequenceNumber, message.attentionSequenceNumber)
    : workstream.readThroughSequenceNumber;
  const youAreMentioned = ownTurn && message.attentionSequenceNumber >= latestAttentionSequenceNumber
    ? false
    : workstream.youAreMentioned;
  if (latestAttentionSequenceNumber === workstream.latestAttentionSequenceNumber
    && readThroughSequenceNumber === workstream.readThroughSequenceNumber
    && youAreMentioned === workstream.youAreMentioned) return workstream;
  return withDerivedUnread({
    ...workstream,
    latestAttentionSequenceNumber,
    readThroughSequenceNumber,
    ...(youAreMentioned === undefined ? {} : { youAreMentioned }),
    lastActivityAt: message.createdAt > workstream.lastActivityAt
      ? message.createdAt
      : workstream.lastActivityAt,
  });
}

function upsertSocketEventOverlay(
  current: readonly TranscriptOverlay[] | undefined,
  identity: TranscriptOverlayIdentity,
  message: Message,
  eventType: string,
  eventSequence: number,
  afterTranscriptSequence: number,
): TranscriptOverlay[] {
  return upsertTranscriptOverlay(current, {
    identity,
    provenance: { source: 'socket_event', eventType, eventSequence },
    position: { afterTranscriptSequence, eventSequence },
    message,
  });
}

export function applyStreamingOverlayEvent(
  overlays: TranscriptOverlay[] | undefined,
  event: StreamingSocketEvent,
  workstreamId: string,
  afterTranscriptSequence: number,
  cursors: Map<string, StreamCursor>,
  options: { paced?: boolean } = {},
): TranscriptOverlay[] {
  const current = overlays ?? [];
  const messages = applyStreamingSocketEvent(
    current.map((overlay) => overlay.message),
    event,
    workstreamId,
    cursors,
    options,
  );
  let next = mapTranscriptOverlayMessages(current, () => messages);
  const streamed = messages.find((message) => message.id === event.turnId);
  if (!streamed) return next;
  const existing = next.find((overlay) =>
    overlay.identity.type === 'assistant_turn'
    && overlay.identity.turnId === event.turnId);
  if (next === current
    && existing
    && (existing.provenance.source === 'stream_event'
      || existing.provenance.source === 'stream_snapshot')
    && existing.provenance.streamId === event.streamId) {
    return current;
  }
  next = upsertTranscriptOverlay(next, {
    identity: { type: 'assistant_turn', turnId: event.turnId },
    provenance: {
      source: 'stream_event',
      streamId: event.streamId,
      eventType: event.type,
      eventSequence: event.sequence,
    },
    position: { afterTranscriptSequence, eventSequence: event.sequence },
    message: streamed,
  });
  return next;
}

export function activeStreamCheckpointOverlays(
  checkpoints: readonly ActiveStreamCheckpoint[],
  workstreamId: string,
  snapshotId: string,
  _afterTranscriptSequence: number,
  cursors: Map<string, StreamCursor>,
): TranscriptOverlay[] {
  const messages = applyActiveStreamCheckpoints([], checkpoints, workstreamId, cursors);
  return checkpoints.flatMap((checkpoint) => {
    const message = messages.find((candidate) => candidate.id === checkpoint.turnId);
    return message ? [{
      identity: { type: 'assistant_turn' as const, turnId: checkpoint.turnId },
      provenance: {
        source: 'stream_snapshot' as const,
        streamId: checkpoint.streamId,
        snapshotId,
      },
      position: {
        afterTranscriptSequence: checkpoint.transcriptSequence - 1,
        eventSequence: checkpoint.roomSequence,
      },
      message,
    }] : [];
  });
}

export function detailTranscriptOverlays(
  detail: WorkstreamDetail,
  snapshotId: string,
  afterTranscriptSequence: number,
  eventSequence: number,
): TranscriptOverlay[] {
  const elicitations = (detail.openElicitations ?? []).map((elicitation): TranscriptOverlay => ({
    identity: { type: 'elicitation', elicitationId: elicitation.id },
    provenance: { source: 'socket_snapshot', snapshotId },
    position: { afterTranscriptSequence, eventSequence },
    message: createElicitationMessage({
      id: elicitationMessageId(elicitation.id),
      workstreamId: detail.id,
      sequenceNumber: 0,
      authorType: 'agent',
      createdAt: elicitation.createdAt ?? detail.lastActivityAt,
      elicitation,
    }),
  }));
  return elicitations;
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
  openCommitted = true,
): WorkstreamSocketConnection {
  const queryClient = useQueryClient();
  const [generatedSocketLeaseId] = useState(() => socketLeaseId ?? uuidV7());
  const resolvedSocketLeaseId = socketLeaseId ?? generatedSocketLeaseId;
  const initialReasonRef = useRef(initialReason);
  initialReasonRef.current = initialReason;
  const openCommittedRef = useRef(openCommitted);
  openCommittedRef.current = openCommitted;
  const markOpenedRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (openCommitted) markOpenedRef.current();
  }, [openCommitted]);
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
  const createMessageRef = useRef<(input: CreateWorkstreamMessageInput) => Promise<AcceptedWorkstreamTurn>>(
    () => Promise.reject(new ApiError(
      'The work stream is not ready to receive messages.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const createMessage = useCallback(
    (input: CreateWorkstreamMessageInput): Promise<AcceptedWorkstreamTurn> => createMessageRef.current(input),
    [],
  );
  const loadTranscriptRangeRef = useRef<(input: {
    snapshotId: string;
    range: TranscriptRange;
    resumeAfterEventSequence: number;
  }) => Promise<TranscriptRangeResult>>(() => Promise.reject(new ApiError(
    'The work stream is not ready to load transcript ranges.',
    409,
    'workstream_socket_unavailable',
  )));
  const loadTranscriptRange = useCallback(
    (input: { snapshotId: string; range: TranscriptRange; resumeAfterEventSequence: number }) =>
      loadTranscriptRangeRef.current(input),
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
      loadTranscriptRangeRef.current = () => Promise.reject(new ApiError(
        'The work stream is not ready to load transcript ranges.',
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
    let socket: RealtimeSocket | null = null;
    let markOpenedRequired = false;
    let markOpenedSent = false;
    const markOpened = (): void => {
      if (
        !openCommittedRef.current
        || !markOpenedRequired
        || markOpenedSent
        || socket?.readyState !== REALTIME_SOCKET_OPEN
      ) return;
      socket.send(JSON.stringify({ type: 'mark_opened' }));
      markOpenedSent = true;
    };
    markOpenedRef.current = markOpened;
    const pendingMessageCommands = new Map<string, PendingMessageCommand>();
    const sendPendingMessages = (target: RealtimeSocket | null = socket): void => {
      if (target?.readyState !== REALTIME_SOCKET_OPEN) return;
      for (const pending of pendingMessageCommands.values()) {
        target.send(JSON.stringify(pending.command));
      }
    };
    const rejectPendingMessages = (error: Error): void => {
      for (const pending of pendingMessageCommands.values()) pending.reject(error);
      pendingMessageCommands.clear();
    };
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
    let pendingInputSnapshot: {
      snapshotId: string;
      sequence: number;
      chunkCount: number;
      chunks: Map<number, readonly PendingTranscriptInput[]>;
    } | null = null;
    /**
     * Whether this socket has yet applied a snapshot.
     *
     * Only the first one is an arrival, and only an arrival wants the reader's
     * resume window; a later snapshot is a repair, and a repair that moved the
     * transcript backwards would undo what the reader just watched.
     */
    const pendingTranscriptRanges = new Map<string, {
      snapshotId: string;
      timeout: number;
      resolve: (range: TranscriptRangeResult) => void;
      reject: (error: Error) => void;
    }>();
    const rejectPendingTranscriptRanges = (message: string): void => {
      for (const pending of pendingTranscriptRanges.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(new ApiError(message, 409, 'workstream_socket_unavailable'));
      }
      pendingTranscriptRanges.clear();
    };
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
          queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) =>
            mapTranscriptOverlayMessages(current, (messages) => applyRevealedText(messages, streamCursors)));
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
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) =>
          mapTranscriptOverlayMessages(current, (messages) => applyRevealedText(messages, streamCursors)));
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

    createMessageRef.current = async (input): Promise<AcceptedWorkstreamTurn> => {
      // Keyed by the client message id, which SubstreamAgent records on its own
      // span as `rally.message.client_id`: the command travels over an
      // already-open socket the platform traces as its own invocation, so this
      // is the only value the renderer and the server both hold.
      const operationId = uuidV7();
      const trace = startPerfTrace('workstream_message_send', {
        traceId: input.clientId,
        operationId,
        workstreamId,
      });
      trace.annotate({
        clientMessageId: input.clientId,
        textLength: input.text.length,
        attachmentCount: input.attachmentIds?.length ?? 0,
        mentionCount: input.mentions?.length ?? 0,
        ...(input.runMode ? { runMode: input.runMode } : {}),
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
        reportTelemetryProductIntent({ kind: 'run_requested', entrypoint: 'composer', operationId });
        const command: CreateMessageSocketCommand = {
          type: 'create_message',
          operationId,
          payload: {
            text: input.text,
            clientMessageId: input.clientId,
            mentions,
            confirmedParticipantUserIds: input.confirmedParticipantUserIds ?? [],
            attachmentIds: input.attachmentIds ?? [],
            ...(input.runMode ? { runMode: input.runMode } : {}),
          },
        };
        const message = await trace.step('command_round_trip', () =>
          new Promise<AcceptedWorkstreamTurn>((resolve, reject) => {
            // The durable write is idempotent by clientMessageId. Keep this
            // command across reconnects and resend the same identity: rejecting
            // an ambiguous disconnect would invite the composer to mint a new
            // identity and duplicate an already-accepted message.
            pendingMessageCommands.set(input.clientId, { command, resolve, reject });
            sendPendingMessages();
            void connect();
          }));
        trace.end();
        return message;
      } catch (error) {
        trace.end({ outcome: 'failed' });
        throw error;
      }
    };
    // Readiness means the work-stream-specific handler is installed and can
    // hand a command to the room queue. The queue owns reconnecting
    // transport, so this intentionally does not wait for either socket to open.
    setSendReady(true);

    loadTranscriptRangeRef.current = (input): Promise<TranscriptRangeResult> => {
      if (closedByEffect || accessRevoked || socket?.readyState !== WebSocket.OPEN) {
        return Promise.reject(new ApiError(
          'The work stream connection is not ready to load transcript ranges.',
          409,
          'workstream_socket_unavailable',
        ));
      }
      const requestId = uuidV7();
      return new Promise<TranscriptRangeResult>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingTranscriptRanges.delete(requestId);
          reject(new ApiError('The transcript range request timed out.', 503, 'transcript_range_timeout'));
        }, TRANSCRIPT_RANGE_TIMEOUT_MS);
        pendingTranscriptRanges.set(requestId, {
          snapshotId: input.snapshotId,
          timeout,
          resolve,
          reject,
        });
        try {
          socket!.send(JSON.stringify({
            type: 'load_transcript_range',
            requestId,
            request: input,
          }));
        } catch (error) {
          window.clearTimeout(timeout);
          pendingTranscriptRanges.delete(requestId);
          reject(new ApiError(
            'The work stream connection could not send the transcript range request.',
            409,
            'workstream_socket_unavailable',
            error,
          ));
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
      if (!socket || socket.readyState !== REALTIME_SOCKET_OPEN) return;
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
      if (event.type === 'pending_inputs_snapshot_chunk') {
        const assembly = pendingInputSnapshot;
        if (!assembly
          || assembly.snapshotId !== event.snapshotId
          || assembly.sequence !== event.sequence
          || assembly.chunkCount !== event.chunkCount
          || event.chunkIndex >= event.chunkCount
          || assembly.chunks.has(event.chunkIndex)) return;
        assembly.chunks.set(event.chunkIndex, event.inputs);
        if (assembly.chunks.size !== assembly.chunkCount) return;
        const inputs = Array.from({ length: assembly.chunkCount }, (_, index) =>
          assembly.chunks.get(index) ?? []).flat().sort((left, right) =>
            left.inputSequence - right.inputSequence
              || (left.inputId < right.inputId ? -1 : left.inputId > right.inputId ? 1 : 0));
        const current = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
        );
        if (!current || current.snapshotId !== assembly.snapshotId) {
          pendingInputSnapshot = null;
          return;
        }
        const complete = { ...current, pendingInputs: inputs };
        queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
          complete,
        );
        const canonical = orderedTranscriptMessages(complete, workstreamId);
        queryClient.setQueryData<TranscriptOverlay[]>(
          transcriptOverlaysQueryKey(workstreamId),
          (overlays) => reconcileAuthoritativeTranscriptOverlays(
            canonical,
            overlays,
            [
              ...(overlays ?? []).filter((overlay) =>
                overlay.provenance.source !== 'client_command'
                && overlay.identity.type !== 'client_message'
                && overlay.identity.type !== 'loop_input'),
              ...inputs.map((input) => pendingTranscriptInputOverlay(
                input,
                workstreamId,
                { source: 'socket_snapshot', snapshotId: assembly.snapshotId },
              )),
            ],
          ),
        );
        pendingInputSnapshot = null;
        return;
      }
      if (event.type === 'resync_required') {
        pendingInputSnapshot = null;
        // Range replies are correlated to this exact admitted socket and its
        // snapshot fence. A reconnect cannot answer them, so release callers
        // immediately into their existing retry-after-reconnect path.
        rejectPendingTranscriptRanges(
          'The work stream resynchronized while loading transcript ranges.',
        );
        setActiveCompaction(event.activeCompaction);
        canonicalResyncActiveStreams = event.reason === 'history_unavailable'
          ? event.activeStreams
          : [];
        if (canonicalResyncActiveStreams.length > 0) {
          const snapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
            ['ordered-transcript', workstreamId],
          );
          const streamed = applyActiveStreamCheckpoints(
            [],
            canonicalResyncActiveStreams,
            workstreamId,
            streamCursors,
          );
          queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) =>
            canonicalResyncActiveStreams.reduce((next, checkpoint) => {
              const message = streamed.find((candidate) => candidate.id === checkpoint.turnId);
              return message ? upsertSocketEventOverlay(
                next,
                { type: 'assistant_turn', turnId: checkpoint.turnId },
                message,
                event.type,
                event.sequence,
                snapshot?.snapshotThrough ?? 0,
              ) : next;
            }, current ?? []));
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
        if (socket && socket.readyState !== REALTIME_SOCKET_CLOSED) {
          socketTelemetry.willClose('resync_required');
          socket.close();
        } else scheduleReconnect();
        return;
      }
      // Once replay history is unavailable, subsequent frames cannot safely be
      // applied on top of stale state. Reconnect only after the direct REST
      // snapshot succeeds, retaining the old cursor across failed attempts.
      if (canonicalResyncTarget !== null) return;
      if (event.type === 'transcript_range') {
        const pending = pendingTranscriptRanges.get(event.requestId);
        if (pending) {
          pendingTranscriptRanges.delete(event.requestId);
          window.clearTimeout(pending.timeout);
        }
        const current = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
        );
        if (current?.snapshotId === event.snapshotId
          && (!pending || pending.snapshotId === event.snapshotId)) {
          queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
            ['ordered-transcript', workstreamId],
            mergeTranscriptRange(current, event.result),
          );
          pending?.resolve(event.result);
        } else {
          pending?.reject(new ApiError(
            'The transcript changed while this range was loading.',
            409,
            'transcript_snapshot_changed',
          ));
        }
        return;
      }
      // Both answers the room can give a snapshot request release the slot, and
      // both are read before the ordering guard below. A snapshot it drops is
      // still an answer — one a newer frame has already superseded — and an
      // error frame carries the room's current sequence, so the guard would
      // discard it whenever nothing else has moved. Either one left holding the
      // slot would suppress every later reconciliation on this socket.
      const answersSnapshotRequest = snapshotRequestInFlight
        && (event.type === 'snapshot' || event.type === 'error');
      if (answersSnapshotRequest) snapshotRequestInFlight = false;
      const currentTranscript = event.type === 'snapshot'
        ? queryClient.getQueryData<WorkstreamTranscriptSnapshot>(['ordered-transcript', workstreamId])
        : undefined;
      // Snapshots are valid at sequence zero and may intentionally replace
      // state at the same sequence after an explicit initial subscription.
      if (event.type === 'snapshot') {
        if (event.sequence < resumeState.lastSequence) return;
        // The room sequence can be equal when a requested snapshot races the
        // upsert that prompted it. Transcript event sequence is the canonical
        // fence: an older snapshot must never roll the cache back.
        if (currentTranscript && event.transcript.eventSequence < currentTranscript.eventSequence) return;
        resumeState.lastSequence = event.sequence;
        streamCursors.clear();
      } else {
        if (event.sequence <= resumeState.lastSequence) return;
        resumeState.lastSequence = event.sequence;
      }

      if (event.type === 'snapshot') {
        pendingInputSnapshot = event.pendingInputChunkCount === 0 ? null : {
          snapshotId: event.transcript.snapshotId,
          sequence: event.sequence,
          chunkCount: event.pendingInputChunkCount,
          chunks: new Map(),
        };
        setActiveCompaction(event.activeCompaction);
        queryClient.setQueryData<number>(
          workstreamSocketSnapshotGenerationQueryKey(workstreamId),
          (current) => (current ?? 0) + 1,
        );
        queryClient.setQueryData(workstreamFeedSourceQueryKey(workstreamId), 'socket_snapshot');
        const detail = mapWorkstreamDetail(event.workstream);
        queryClient.setQueryData(['workstream', workstreamId], detail);
        // Only a reconciliation requested on this still-contiguous socket can
        // carry previously loaded ranges across a new snapshot fence. Initial
        // delivery and history-loss recovery have no proof that mutable turns
        // outside the bounded opening ranges did not change, so relabelling an
        // old range with the new snapshot id would make stale lifecycle state
        // look authoritative.
        const transcript = currentTranscript && event.reason === 'reconciliation'
          ? mergeCanonicalTranscriptSnapshot(currentTranscript, event.transcript)
          : event.transcript;
        queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
          transcript,
        );
        const canonical = orderedTranscriptMessages(transcript, workstreamId);
        const snapshotOverlays = [
          ...event.transcript.pendingInputs.map((input) => pendingTranscriptInputOverlay(
            input,
            workstreamId,
            { source: 'socket_snapshot', snapshotId: event.transcript.snapshotId },
          )),
          ...activeStreamCheckpointOverlays(
            event.activeStreams,
            workstreamId,
            event.transcript.snapshotId,
            event.transcript.snapshotThrough,
            streamCursors,
          ),
          ...detailTranscriptOverlays(
            detail,
            event.transcript.snapshotId,
            event.transcript.snapshotThrough,
            event.sequence,
          ),
        ];
        queryClient.setQueryData<TranscriptOverlay[]>(
          transcriptOverlaysQueryKey(workstreamId),
          (current) => reconcileAuthoritativeTranscriptOverlays(
            canonical,
            current,
            event.pendingInputChunkCount === 0
              ? snapshotOverlays
              : [
                  ...snapshotOverlays,
                  ...(current ?? []).filter((overlay) =>
                    overlay.identity.type === 'loop_input'
                    || overlay.identity.type === 'client_message'),
                ],
          ),
        );
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
      } else if (event.type === 'loop_input_upserted') {
        queryClient.setQueryData<TranscriptOverlay[]>(
          transcriptOverlaysQueryKey(workstreamId),
          (current) => replaceTranscriptOverlay(
            current,
            pendingTranscriptInputOverlay(event.input, workstreamId, {
              source: 'socket_event',
              eventType: event.type,
              eventSequence: event.sequence,
            }),
          ),
        );
      } else if (event.type === 'loop_input_removed') {
        queryClient.setQueryData<TranscriptOverlay[]>(
          transcriptOverlaysQueryKey(workstreamId),
          (current) => removeTranscriptOverlay(current, (overlay) =>
            (overlay.identity.type === 'loop_input' && overlay.identity.inputId === event.inputId)
            || (overlay.identity.type === 'client_message' && overlay.identity.turnId === event.inputId)),
        );
      } else if (event.type === 'transcript_turn_upserted') {
        const next = queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
          (current) => current
            ? mergeRealtimeTranscriptTurn(current, event.turn, event.sequence)
            : current,
        );
        if (next) {
          const canonical = orderedTranscriptMessages(next, workstreamId);
          queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) =>
            transcriptOverlaysWithoutCanonicalMatch(canonical, current ?? []));
          const turnMessages = canonical.filter((message) =>
            message.transcriptTurnId === event.turn.turnId);
          // Not `reduce(advanceWorkstreamAttention, …)`: reduce would hand the
          // element index to the third parameter.
          const viewerUserId = api?.viewerUserId ?? null;
          const advance = <T extends WorkstreamSummary>(workstream: T): T =>
            turnMessages.reduce(
              (next, message) => advanceWorkstreamAttention(next, message, viewerUserId),
              workstream,
            );
          queryClient.setQueryData<WorkstreamDetail>(['workstream', workstreamId], (current) =>
            current ? advance(current) : current);
          setCachedWorkstreams(queryClient, (current) => current?.map((workstream) =>
            workstream.id === workstreamId ? advance(workstream) : workstream));
        }
      } else if (event.type === 'transcript_activity_upserted') {
        queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
          (current) => current
            ? mergeRealtimeTranscriptActivity(
                current,
                event.activity,
                event.sequence,
                event.snapshotAtUtc,
              )
            : current,
        );
      } else if (event.type === 'presence_changed') {
        // Legacy feed subscribers represented viewers. Proactive feeds do not:
        // WorkspaceDO foreground presence is the sole current-client source.
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
        const matchingCursors = new Map([...streamCursors].filter(([, cursor]) =>
          cursor.streamId === event.streamId));
        flushStreamReveal(matchingCursors);
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) => {
          const streamIdByMessageId = new Map((current ?? []).flatMap((overlay) => (
            overlay.provenance.source === 'stream_event'
            || overlay.provenance.source === 'stream_snapshot'
              ? [[overlay.message.id, overlay.provenance.streamId] as const]
              : []
          )));
          return mapTranscriptOverlayMessages(current, (messages) => {
            const revealed = applyRevealedText(messages, streamCursors);
            let changed = false;
            const completed = revealed.map((candidate) => {
              const cursor = streamCursors.get(candidate.id);
              if (!candidate.streaming
                || (cursor?.streamId !== event.streamId
                  && streamIdByMessageId.get(candidate.id) !== event.streamId)) return candidate;
              changed = true;
              return { ...candidate, streaming: false };
            });
            return changed ? completed : revealed;
          });
        });
        if (matchingCursors.size === 0) return;
        for (const [turnId, cursor] of streamCursors) {
          if (cursor.streamId === event.streamId) {
            streamCursors.set(turnId, { ...cursor, roomSequence: event.sequence, completed: true });
          }
        }
      } else if (event.type === 'stream_started' || event.type === 'stream_delta') {
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) =>
          applyStreamingOverlayEvent(current, event, workstreamId, event.transcriptSequence - 1, streamCursors, {
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
        const afterTranscriptSequence = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
        )?.snapshotThrough ?? 0;
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) => {
          const messageId = `tool-${event.invocation.id}`;
          const existing = (current ?? []).find((overlay) =>
            overlay.identity.type === 'tool_call'
            && overlay.identity.toolCallId === event.invocation.toolCallId);
          const message = createToolEventMessage({
            id: messageId,
            transcriptTurnId: event.invocation.toolCallId.replace(/:tool:\d+$/u, ''),
            workstreamId,
            sequenceNumber: 0,
            authorType: 'agent',
            createdAt: existing?.message.createdAt ?? event.occurredAt,
            toolEvent: {
              ...mapToolInvocation(event.invocation),
              toolCallId: event.invocation.toolCallId,
            },
          });
          return upsertSocketEventOverlay(
            current,
            { type: 'tool_call', toolCallId: event.invocation.toolCallId },
            message,
            event.type,
            event.sequence,
            afterTranscriptSequence,
          );
        });
      } else if (event.type === 'elicitation_created' || event.type === 'elicitation_answered') {
        const messageId = elicitationMessageId(event.elicitation.id);
        const afterTranscriptSequence = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          ['ordered-transcript', workstreamId],
        )?.snapshotThrough ?? 0;
        queryClient.setQueryData<TranscriptOverlay[]>(transcriptOverlaysQueryKey(workstreamId), (current) => {
          if (event.elicitation.status === 'cancelled') {
            return removeTranscriptOverlay(current, (overlay) => overlay.identity.type === 'elicitation'
              && overlay.identity.elicitationId === event.elicitation.id);
          }
          const message = createElicitationMessage({
            id: messageId,
            workstreamId,
            sequenceNumber: 0,
            authorType: 'agent',
            createdAt: event.elicitation.createdAt,
            elicitation: mapElicitation(event.elicitation),
          });
          return upsertSocketEventOverlay(
            current,
            { type: 'elicitation', elicitationId: event.elicitation.id },
            message,
            event.type,
            event.sequence,
            afterTranscriptSequence,
          );
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

    const scheduleStabilityReset = (target: RealtimeSocket): void => {
      clearStabilityTimer();
      stabilityTimer = window.setTimeout(() => {
        stabilityTimer = null;
        if (closedByEffect || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
        attempts.current = 0;
      }, SOCKET_STABLE_CONNECTION_MS);
    };

    const scheduleHeartbeat = (target: RealtimeSocket): void => {
      clearHeartbeat();
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null;
        if (closedByEffect || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
        target.send('ping');
        pongTimer = window.setTimeout(() => {
          pongTimer = null;
          if (closedByEffect || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
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
        || socket?.readyState === REALTIME_SOCKET_CONNECTING
        || socket?.readyState === REALTIME_SOCKET_OPEN
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
          const canonicalWorkstream = await api.getWorkstream(workstreamId);
          if (closedByEffect) return;
          const { transcript: canonicalTranscript, ...detail } = canonicalWorkstream;
          queryClient.setQueryData(['workstream', workstreamId], detail);
          queryClient.setQueryData(['ordered-transcript', workstreamId], canonicalTranscript);
          const mayStillEmitRealtime = runMayStillEmitRealtime(canonicalWorkstream.harnessStatus);
          setActiveCompaction((current) => mayStillEmitRealtime
            && current?.harnessRunId === canonicalWorkstream.latestHarnessRunId
            ? current
            : null);
          const validatedActiveStreams = mayStillEmitRealtime
            ? canonicalResyncActiveStreams.filter((checkpoint) =>
                checkpoint.harnessRunId === canonicalWorkstream.latestHarnessRunId)
            : [];
          const canonicalMessages = orderedTranscriptMessages(canonicalTranscript, workstreamId);
          streamCursors.clear();
          const authoritativeOverlays = [
            ...canonicalTranscript.pendingInputs.map((input) => pendingTranscriptInputOverlay(
              input,
              workstreamId,
              { source: 'socket_snapshot', snapshotId: canonicalTranscript.snapshotId },
            )),
            ...activeStreamCheckpointOverlays(
              validatedActiveStreams,
              workstreamId,
              canonicalTranscript.snapshotId,
              canonicalTranscript.snapshotThrough,
              streamCursors,
            ),
            ...detailTranscriptOverlays(
              detail,
              canonicalTranscript.snapshotId,
              canonicalTranscript.snapshotThrough,
              canonicalTranscript.eventSequence,
            ),
          ];
          queryClient.setQueryData<TranscriptOverlay[]>(
            transcriptOverlaysQueryKey(workstreamId),
            (current) => reconcileAuthoritativeTranscriptOverlays(
              canonicalMessages,
              current,
              authoritativeOverlays,
            ),
          );
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
      const openingAttemptId = workstreamFeedOpenAttemptId(workstreamId);
      const trace = startPerfTrace('workstream_open', {
        workstreamId,
        ...(openingAttemptId ? { operationId: openingAttemptId } : {}),
        report: openingAttemptId !== undefined,
      });
      openTrace?.end({ outcome: 'superseded' });
      openTrace = trace;
      reportWorkstreamSocketStarted(
        workstreamId,
        resolvedSocketLeaseId,
        'substream_feed',
        attempts.current === 0 ? initialReasonRef.current : 'reconnect',
        attempts.current,
        trace.traceId,
        openingAttemptId,
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
        const speculative = initialReasonRef.current === 'hover_warmup'
          && !openCommittedRef.current;
        // Called directly rather than through `trace.step`: the socket-ticket
        // lint rule recognizes a ticket only when the awaited call is the
        // declarator's own initializer, and a `mark` on the next line closes
        // exactly the same span.
        const socketTicket = await api.getSocketTicket(
          workstreamId,
          '0',
          trace.traceId,
          resumeState.lastSequence,
          speculative,
        );
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
        const nextSocket = createRealtimeSocket('substream_feed', socketTicket.url, socketTicket.protocols);
        markOpenedRequired = speculative;
        markOpenedSent = !speculative;
        // Splits the wait between holding a ticket and being connected into the
        // two halves that have opposite fixes. Nothing is awaited between the
        // ticket resolving and this line, so `dial` can only be large if the
        // renderer was not running — a blocked main thread does not let the
        // continuation execute. Everything after it is the handshake itself.
        // Without the split, one `handshake` number covers both and reads as a
        // slow server either way.
        trace.mark('dial');
        socket = nextSocket;
        let failedRouteCount = 0;
        nextSocket.addEventListener('handshakephase', (
          phaseEvent: RealtimeSocketHandshakePhaseEvent,
        ) => {
          if (closedByEffect || socket !== nextSocket) return;
          const annotation = {
            proxy_resolution: 'pacResolutionMs',
            dns: 'dnsMs',
            tcp: 'tcpMs',
            tls: 'tlsMs',
            edge_upgrade: 'edgeUpgradeMs',
            proxy_connect_tls_edge: 'proxyHandshakeMs',
            route_failed: null,
          }[phaseEvent.phase];
          if (annotation) trace.annotate({ [annotation]: phaseEvent.durationMs });
          if (phaseEvent.phase === 'route_failed') {
            failedRouteCount += 1;
            trace.annotate({ failedRouteCount });
          }
        });
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
          if (!socketTicket.subscriptionBootstrap) {
            nextSocket.send(JSON.stringify({
              type: 'subscribe',
              afterSequence: resumeState.lastSequence,
              publishPresence: false,
            }));
          }
          markOpened();
          sendPendingMessages(nextSocket);
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
            const commandResult = WorkstreamSocketCommandResultSchema.safeParse(parsed);
            if (commandResult.success) {
              const pending = pendingMessageCommands.get(commandResult.data.clientMessageId);
              if (!pending) return;
              pendingMessageCommands.delete(commandResult.data.clientMessageId);
              if (commandResult.data.type === 'client_command_succeeded') {
                pending.resolve({
                  ...commandResult.data.turn,
                  deliveryState: commandResult.data.deliveryState,
                });
              } else {
                pending.reject(new ApiError(
                  commandResult.data.error.message,
                  commandResult.data.error.status,
                  commandResult.data.error.code,
                  commandResult.data.error.details,
                ));
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
                  ...(event.data.type === 'snapshot' ? {
                    messageCount: event.data.transcript.ranges.reduce(
                      (count, range) => count + range.turns.length,
                      event.data.transcript.activeTurns.length,
                    ),
                  } : {}),
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
          rejectPendingTranscriptRanges(
            'The work stream connection closed while loading transcript ranges.',
          );
          pendingInputSnapshot = null;
          socket = null;
          if (closeEvent.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            socketTelemetry.disconnected({
              attempts: attempts.current,
              retrying: false,
              cause: 'access_revoked',
            });
            rejectPendingMessages(new ApiError(
              'You can no longer access this work stream.',
              403,
              'workstream_access_revoked',
            ));
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
            rejectPendingTranscriptRanges(
              'The work stream connection failed while loading transcript ranges.',
            );
            pendingInputSnapshot = null;
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
      if (socket?.readyState === REALTIME_SOCKET_CONNECTING || socket?.readyState === REALTIME_SOCKET_OPEN) return;
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
      markOpenedRef.current = () => undefined;
      openTrace?.end({ outcome: 'unmounted' });
      openTrace = null;
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The work stream is no longer available.',
        409,
        'workstream_socket_unavailable',
      ));
      loadTranscriptRangeRef.current = () => Promise.reject(new ApiError(
        'The work stream is no longer available.',
        409,
        'workstream_socket_unavailable',
      ));
      rejectPendingTranscriptRanges('The work stream changed while loading transcript ranges.');
      rejectPendingMessages(new ApiError(
        'The work stream changed while sending the message.',
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
  }, [api, enabled, queryClient, resolvedSocketLeaseId, resumeState, workstreamId]);

  const workspaceSocketState = state === 'idle' ? 'unavailable' : state;

  return useMemo(
    () => ({
      state,
      sendReady,
      workspaceSocketState,
      activeCompaction,
      createMessage,
      loadTranscriptRange,
      requestSnapshot,
    }),
    [
      activeCompaction,
      createMessage,
      loadTranscriptRange,
      requestSnapshot,
      sendReady,
      state,
      workspaceSocketState,
    ],
  );
}
