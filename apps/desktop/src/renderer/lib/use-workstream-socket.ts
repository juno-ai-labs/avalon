import type { Annotation } from '@rally/contracts';
import { useConversationAdmission } from './conversation-admission';
import { mainReachable, useConversationDirectory } from './conversation-directory';
import { useCachedWorkstreamSummary } from './use-workstreams-query';
import { safeParseSocketEvent } from "@rally/contracts";
import type { WorkstreamAppearancePatch } from '@rally/contracts';
import {
  type ConversationSuggestion,
  ServerSocketEventSchema,
  WorkstreamSocketCommandResultSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  type AgentCompactionState,
  type InferenceDelayState,
  InferenceDelayStateSchema,
  type ActiveStreamCheckpoint,
  type ClientSocketEvent,
  type WorkstreamSocketCommandResult,
  type ServerSocketEvent,
  type PendingTranscriptInput,
  type WorkstreamTranscriptSnapshot,
  type WorkstreamMessageAdmissionReceipt,
  type TranscriptRange,
  type TranscriptRangeResult,
} from '@rally/contracts';
import type { ConversationParentKind } from '@rally/contracts/conversation-parent';
import { SubstreamInitialContextSchema, type SubstreamInitialContext } from '@rally/contracts/substream-creation';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { retainQueryData } from './retain-query-data';
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
import { advanceStreamReveal, applyRevealedText, flushStreamReveal, recordStreamArrival } from './streaming-reveal';
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
  setTranscriptElicitationState,
  transcriptOverlaysQueryKey,
  transcriptOverlaysWithoutCanonicalMatch,
  type TranscriptOverlay,
  type TranscriptOverlayIdentity,
  upsertTranscriptOverlay,
  upsertTranscriptMessage,
} from './transcript';
import type { HarnessStatus, Message, WorkspaceMember, WorkstreamDetail, WorkstreamSummary } from './types';
import { withDerivedUnread } from './workstream-state-store';
import { evictCachedSubstream, patchCachedGeneratedIcon, patchCachedWorkstream, patchCachedWorkstreamAppearance, setCachedWorkstreams, workstreamDetailQueryKey } from './workstreams-cache';
import { useWorkstreamSocketResumeState, type StreamCursor } from './workstream-socket-resume';
import {
  applyBreakoutAppearanceReceipt,
  captureBreakoutAppearanceUpdate,
} from './channel-viewer-state';
import {
  conversationSeededFromLocalCache,
  hydrateConversation,
  mirrorConversation,
  type ConversationCacheKeys,
} from './conversation-cache';
import { useLocalCacheScope } from './local-cache-scope';
import { desktopBridge } from './platform';
import {
  isSocketTicketRequestTimeoutError,
  SocketTicketRequestTimeoutError,
  SOCKET_TICKET_REQUEST_TIMEOUT_MS,
} from './socket-ticket-request';

export type { StreamCursor } from './workstream-socket-resume';

import type { SocketState } from '@rally/ui/lib/types';
export type { SocketState } from '@rally/ui/lib/types';
export type WorkstreamMessageDeliveryMode = 'steer' | 'queue';

/** The exact API capability the realtime cache reconciler is allowed to use. */
export type WorkstreamSocketApi = Pick<
  RallyApi,
  'getSocketTicket' | 'messageMentionPayload'
  // Read, not called: which arriving turns are the reader's own.
  | 'viewerUserId'
> & Partial<Pick<RallyApi, 'confirmSocketTicket'>>;

export interface CreateWorkstreamMessageInput {
  annotations?: Annotation[];
  text: string;
  clientId: string;
  mentions?: MentionIdentity[];
  confirmedParticipantUserIds?: string[];
  attachmentIds?: string[];
  runMode?: WorkstreamMessageDeliveryMode;
}

export interface WorkstreamSocketConnection {
  state: SocketState;
  /** Terminal opening failure shown after the bounded socket attempts expire. */
  openingError?: string;
  /** Starts a fresh bounded opening sequence after a terminal opening failure. */
  retryOpening(): void;
  /** The workstream handler can admit sends to the room-socket queue. The painted
   * telemetry milestone is reported separately after the consuming UI commits. */
  sendReady: boolean;
  /** Legacy telemetry field name; this now reports the message-carrying room socket. */
  workspaceSocketState: 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
  activeInferenceDelays: InferenceDelayState[];
  activeCompaction: AgentCompactionState | null;
  /** The open conversation suggestions, as the room last published them; the surface decides which are visible. */
  suggestions: ConversationSuggestion[];
  createMessage(input: CreateWorkstreamMessageInput): Promise<AcceptedWorkstreamTurn>;
  answerElicitation(
    elicitationId: string,
    answer: string | string[] | null,
    customResponse?: string,
  ): Promise<void>;
  reorderPendingInputs(inputIds: string[]): Promise<{ pendingInputs: PendingTranscriptInput[] }>;
  stopHarness(): Promise<void>;
  setAppearance(appearance: WorkstreamAppearancePatch): Promise<void>;
  retryHarness(): Promise<{ harnessRunId: string }>;
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
type SubstreamMutationCommand = Extract<ClientSocketEvent, { operationId: string }>;
type SuccessfulSubstreamMutation = Extract<WorkstreamSocketCommandResult, {
  type: 'client_command_succeeded';
}>;

interface PendingSubstreamCommand {
  command: SubstreamMutationCommand;
  resolve: (result: SuccessfulSubstreamMutation) => void;
  reject: (error: Error) => void;
  /** The live connection which already received this unresolved command. */
  sentOn: RealtimeSocket | null;
}

const HEARTBEAT_BASE_MS = 45_000;
const HEARTBEAT_JITTER_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
const TRANSCRIPT_RANGE_TIMEOUT_MS = 15_000;
export const SOCKET_STABLE_CONNECTION_MS = 30_000;
export const WORKSTREAM_OPEN_TIMEOUT_BASE_MS = 10_000;
export const WORKSTREAM_OPEN_TIMEOUT_ATTEMPTS = 3;

export function workstreamOpenTimeoutMs(timedOutAttempts: number): number {
  const attemptIndex = Math.min(
    Math.max(0, timedOutAttempts),
    WORKSTREAM_OPEN_TIMEOUT_ATTEMPTS - 1,
  );
  return WORKSTREAM_OPEN_TIMEOUT_BASE_MS * 2 ** attemptIndex;
}

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
    lastRevealAt: !paced || replacesAttempt ? null : cursor?.lastRevealAt ?? null,
    pacing: !paced ? undefined : event.type === 'stream_delta' && event.delta.length > 0
      ? recordStreamArrival(
          replacesAttempt ? undefined : cursor?.pacing,
          event.delta.length,
          receivedText.length - revealed,
          performance.now(),
        )
      : replacesAttempt ? undefined : cursor?.pacing,
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

export function orderedTranscriptQueryKey(
  workstreamId: string,
  substreamId = '0',
): readonly ['ordered-transcript', string]
  | readonly ['substream-ordered-transcript', string, string] {
  return substreamId === '0'
    ? ['ordered-transcript', workstreamId]
    : ['substream-ordered-transcript', workstreamId, substreamId];
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
  substreamId = '0',
): void {
  // `stopRequested` describes the run this status belonged to, so it is cleared
  // with the status rather than left for the canonical snapshot that follows.
  // The window is narrow and self-healing, but it is no longer invisible: the
  // composer dock now says "stopping" in a full sentence while a live run
  // carries the flag, so a fresh run inheriting a stale one would open by
  // announcing a wait nobody asked for.
  queryClient.setQueryData<WorkstreamDetail>(workstreamDetailQueryKey(workstreamId, substreamId), (current) =>
    current && current.harnessStatus !== harnessStatus
      ? { ...current, harnessStatus, stopRequested: false }
      : current);
  if (substreamId !== '0') return;
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
 * rule — `mentioned` outranks `unread` in `MARKER_PRECEDENCE` — so the reader's
 * own reply would swap one wrongly lit dot for a louder one. Unlike the manual
 * mark this *can* be fenced honestly: it is cleared only when the arriving turn
 * is the newest attention event this client knows of, so a mention that landed
 * after it survives a replay.
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

export const substreamInitialContextQueryKey = (parentId: string, substreamId: string) =>
  ['substream-initial-context', parentId, substreamId] as const;

export function useWorkstreamSocket(
  api: WorkstreamSocketApi | null,
  parentId: string,
  enabled: boolean,
  initialReason: Exclude<WorkstreamSocketStartReason, 'reconnect'> = 'active_workstream',
  socketLeaseId?: string,
  openCommitted = true,
  substreamId = '0',
  parentKind: ConversationParentKind = 'workstream',
): WorkstreamSocketConnection {
  // Main of a Channel this person reaches only through some of its
  // conversations is not theirs to open; every Main feed, pooled or direct,
  // passes here.
  const row = useCachedWorkstreamSummary(parentId);
  const conversationDirectory = useConversationDirectory();
  const mainOutOfReach = parentKind === 'workstream' && substreamId === '0'
    && mainReachable(row, conversationDirectory, parentId) === false;
  enabled = enabled && !mainOutOfReach;
  const admissionAllowed = useConversationAdmission();
  const localCacheScope = useLocalCacheScope();
  const effectiveOpenCommitted = openCommitted && admissionAllowed;
  const admissionAllowedRef = useRef(admissionAllowed);
  admissionAllowedRef.current = admissionAllowed;
  const queryClient = useQueryClient();
  const [generatedSocketLeaseId] = useState(() => socketLeaseId ?? uuidV7());
  const resolvedSocketLeaseId = socketLeaseId ?? generatedSocketLeaseId;
  const initialReasonRef = useRef(initialReason);
  initialReasonRef.current = initialReason;
  const openCommittedRef = useRef(effectiveOpenCommitted);
  openCommittedRef.current = effectiveOpenCommitted;
  const markOpenedRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (effectiveOpenCommitted) markOpenedRef.current();
  }, [effectiveOpenCommitted]);
  const resumeState = useWorkstreamSocketResumeState(parentId, substreamId);
  const [state, setState] = useState<SocketState>('idle');
  const [openingError, setOpeningError] = useState<string>();
  const [openingRetryGeneration, setOpeningRetryGeneration] = useState(0);
  const [sendReady, setSendReady] = useState(false);
  const [activeInferenceDelays, setActiveInferenceDelays] = useState<InferenceDelayState[]>(resumeState.activeInferenceDelays);
  const [activeCompaction, setActiveCompaction] = useState<AgentCompactionState | null>(null);
  // From the resume state: a remount that resumes after the cursor replays no
  // snapshot, and the open chips must not vanish until a forced one.
  const [suggestions, setSuggestions] = useState<ConversationSuggestion[]>(resumeState.suggestions);
  const attempts = useRef(0);
  const retryOpening = useCallback((): void => {
    setOpeningError(undefined);
    setOpeningRetryGeneration((current) => current + 1);
  }, []);
  const createMessageRef = useRef<(input: CreateWorkstreamMessageInput) => Promise<AcceptedWorkstreamTurn>>(
    () => Promise.reject(new ApiError(
      'The thread is not ready to receive messages.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const createMessage = useCallback(
    (input: CreateWorkstreamMessageInput): Promise<AcceptedWorkstreamTurn> => createMessageRef.current(input),
    [],
  );
  const answerElicitationRef = useRef<WorkstreamSocketConnection['answerElicitation']>(
    () => Promise.reject(new ApiError(
      'The breakout is not ready to answer questions.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const answerElicitation = useCallback<WorkstreamSocketConnection['answerElicitation']>(
    (...args) => answerElicitationRef.current(...args),
    [],
  );
  const reorderPendingInputsRef = useRef<WorkstreamSocketConnection['reorderPendingInputs']>(
    () => Promise.reject(new ApiError(
      'The breakout is not ready to reorder queued messages.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const reorderPendingInputs = useCallback<WorkstreamSocketConnection['reorderPendingInputs']>(
    (inputIds) => reorderPendingInputsRef.current(inputIds),
    [],
  );
  const setAppearanceRef = useRef<WorkstreamSocketConnection['setAppearance']>(() => Promise.reject(new Error('Thread is not connected')));
  const setAppearance = useCallback<WorkstreamSocketConnection['setAppearance']>((appearance) => setAppearanceRef.current(appearance), []);
  const stopHarnessRef = useRef<WorkstreamSocketConnection['stopHarness']>(
    () => Promise.reject(new ApiError(
      'The breakout is not ready to stop.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const stopHarness = useCallback<WorkstreamSocketConnection['stopHarness']>(
    () => stopHarnessRef.current(),
    [],
  );
  const retryHarnessRef = useRef<WorkstreamSocketConnection['retryHarness']>(
    () => Promise.reject(new ApiError(
      'The breakout is not ready to retry.',
      409,
      'workstream_socket_unavailable',
    )),
  );
  const retryHarness = useCallback<WorkstreamSocketConnection['retryHarness']>(
    () => retryHarnessRef.current(),
    [],
  );
  const loadTranscriptRangeRef = useRef<(input: {
    snapshotId: string;
    range: TranscriptRange;
    resumeAfterEventSequence: number;
  }) => Promise<TranscriptRangeResult>>(() => Promise.reject(new ApiError(
    'The thread is not ready to load transcript ranges.',
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
    setActiveInferenceDelays((current) => current.length === 0 && resumeState.activeInferenceDelays.length === 0 ? current : resumeState.activeInferenceDelays);
    const updateInferenceDelays = (next: InferenceDelayState[]) => {
      resumeState.activeInferenceDelays = next;
      setActiveInferenceDelays((current) => current.length === 0 && next.length === 0 ? current : next);
    };
    setOpeningError(undefined);
    if (!api || !enabled) {
      setState('idle');
      setSendReady(false);
      requestSnapshotRef.current = () => undefined;
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The thread is not ready to receive messages.',
        409,
        'workstream_socket_unavailable',
      ));
      answerElicitationRef.current = () => Promise.reject(new ApiError(
        'The breakout is not ready to answer questions.', 409, 'workstream_socket_unavailable',
      ));
      reorderPendingInputsRef.current = () => Promise.reject(new ApiError(
        'The breakout is not ready to reorder queued messages.', 409, 'workstream_socket_unavailable',
      ));
      setAppearanceRef.current = () => Promise.reject(new ApiError('The thread is not connected.', 409, 'workstream_socket_unavailable'));
      stopHarnessRef.current = () => Promise.reject(new ApiError(
        'The breakout is not ready to stop.', 409, 'workstream_socket_unavailable',
      ));
      retryHarnessRef.current = () => Promise.reject(new ApiError(
        'The breakout is not ready to retry.', 409, 'workstream_socket_unavailable',
      ));
      loadTranscriptRangeRef.current = () => Promise.reject(new ApiError(
        'The thread is not ready to load transcript ranges.',
        409,
        'workstream_socket_unavailable',
      ));
      return;
    }
    const detailQueryKey = workstreamDetailQueryKey(parentId, substreamId);
    const transcriptQueryKey = orderedTranscriptQueryKey(parentId, substreamId);
    const contextQueryKey = substreamInitialContextQueryKey(parentId, substreamId);
    const overlaysQueryKey = transcriptOverlaysQueryKey(parentId, substreamId);
    const feedSourceQueryKey = workstreamFeedSourceQueryKey(parentId, substreamId);
    const releaseData = retainQueryData(queryClient, [
      detailQueryKey, transcriptQueryKey, contextQueryKey, overlaysQueryKey, feedSourceQueryKey,
      workstreamSocketSnapshotGenerationQueryKey(parentId, substreamId),
    ]);
    const localCacheKeys: ConversationCacheKeys = {
      detail: detailQueryKey,
      transcript: transcriptQueryKey,
      initialContext: contextQueryKey,
      feedSource: feedSourceQueryKey,
    };
    /**
     * Whether what the caches hold came off the disk rather than off this or
     * any socket. A seed paints, and that is all it does: it completes no
     * opening, it fences no snapshot, and the composer above it does not send.
     */
    const seededFromLocalCache = (): boolean => conversationSeededFromLocalCache(queryClient, localCacheKeys);
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
    const pendingSubstreamCommands = new Map<string, PendingSubstreamCommand>();
    const sendPendingSubstreamCommands = (target: RealtimeSocket | null = socket): void => {
      if (target?.readyState !== REALTIME_SOCKET_OPEN) return;
      for (const pending of pendingSubstreamCommands.values()) {
        // A command remains pending until its private receipt arrives. An
        // ordinary later command must not replay it onto the same healthy
        // connection, while a reconnect deliberately sends every unresolved
        // command again. Application-foreground recovery is the one explicit
        // same-socket exception: the renderer may have missed the private
        // receipt while suspended, and the original operation ID makes that
        // replay idempotent.
        if (pending.sentOn === target) continue;
        try {
          target.send(JSON.stringify(pending.command));
          pending.sentOn = target;
        } catch {
          // The readyState check and send are not atomic. Preserve every entry
          // for the next connection; the close path owns reconnect scheduling.
          try {
            target.close();
          } catch {
            // A socket which already became terminal has nothing left to close.
          }
          return;
        }
      }
    };
    const rejectPendingSubstreamCommands = (error: Error): void => {
      for (const pending of pendingSubstreamCommands.values()) pending.reject(error);
      pendingSubstreamCommands.clear();
    };
    const submitSubstreamCommand = (
      command: SubstreamMutationCommand,
    ): Promise<SuccessfulSubstreamMutation> => {
      if (accessRevoked) {
        return Promise.reject(new ApiError(
          'You can no longer access this thread.',
          403,
          'workstream_access_revoked',
        ));
      }
      if (openingTerminal) {
        return Promise.reject(new ApiError(
          'The live connection timed out before the breakout command could be sent.',
          408,
          'workstream_socket_open_timeout',
        ));
      }
      // A seed has no fence to address a command against: the run, the
      // elicitation, or the queue on screen is what the room said some
      // launches ago. Every command inherits the gate here, not per control.
      if (seededFromLocalCache()) {
        return Promise.reject(new ApiError(
          'Rally is still connecting to this conversation.',
          409,
          'workstream_feed_seeded',
        ));
      }
      return new Promise((resolve, reject) => {
        pendingSubstreamCommands.set(command.operationId, {
          command,
          resolve,
          reject,
          sentOn: null,
        });
        sendPendingSubstreamCommands();
        void connect();
      });
    };
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongTimer: number | null = null;
    let stabilityTimer: number | null = null;
    let openingTimer: number | null = null;
    let openingTimedOutAttempts = 0;
    let openingTerminal = false;
    const canonicalCachesAvailable = (): boolean =>
      !seededFromLocalCache()
      && queryClient.getQueryData<WorkstreamDetail>(detailQueryKey)?.id === parentId
      && queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
        transcriptQueryKey,
      ) !== undefined
      && (substreamId === '0' || queryClient.getQueryData(contextQueryKey) !== undefined);
    let openingCompleted = canonicalCachesAvailable();
    let connectGeneration = 0;
    let activeTicketAbort: AbortController | null = null;
    let ticketRequestInFlight = false;
    let canonicalResyncTarget: number | null = null;
    let canonicalResyncActiveStreams: readonly ActiveStreamCheckpoint[] = [];
    /**
     * One outstanding snapshot request at a time. The room answers with a
     * sequenced frame that supersedes whatever prompted the request, so a
     * second request issued while one is in flight can only ask for state the
     * first will already carry.
     */
    let snapshotRequestInFlight = false;
    let initialContextSnapshot: {
      snapshotId: string;
      sequence: number;
      chunkCount: number;
      chunks: Map<number, string>;
    } | null = null;
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
      revealFrame = window.requestAnimationFrame((now) => {
        revealFrame = null;
        if (closedByEffect) return;
        const { changed, backlogRemains } = advanceStreamReveal(streamCursors, now);
        if (changed) {
          queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) =>
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
     *
     */
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden') return;
      if (flushStreamReveal(streamCursors)) {
        queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) =>
          mapTranscriptOverlayMessages(current, (messages) => applyRevealedText(messages, streamCursors)));
      }
    };
    /**
     * Electron may suspend this renderer after it sends a command but before
     * the private receipt is processed. Main's application-focus signal is the
     * trustworthy recovery edge: a window can lose and regain application
     * focus without ever becoming document-hidden.
     *
     * Replay only unresolved commands with their original operation IDs,
     * reconcile canonical state, and verify an open transport immediately. A
     * socket which already closed bypasses its background-throttled reconnect
     * timer and starts a fresh attempt now. Retained conversations without a
     * pending command do no foreground work.
     */
    const handleApplicationForegroundChange = (foregrounded: boolean): void => {
      if (!foregrounded) return;
      if (pendingSubstreamCommands.size === 0) return;
      if (socket?.readyState === REALTIME_SOCKET_CONNECTING) return;
      if (socket?.readyState !== REALTIME_SOCKET_OPEN) {
        clearReconnectTimer();
        void connect();
        return;
      }
      for (const pending of pendingSubstreamCommands.values()) pending.sentOn = null;
      sendPendingSubstreamCommands();
      requestCanonicalSnapshot();
      probeHeartbeatNow(socket);
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
      if (!admissionAllowedRef.current) throw new ApiError('Organization setup is still loading.', 409, 'workspace_setup_pending');
      // The operation id correlates the private receipt; the client message id
      // remains the durable write's idempotency key and tracing identity.
      const operationId = uuidV7();
      const trace = startPerfTrace('workstream_message_send', {
        traceId: input.clientId,
        operationId,
        workstreamId: parentId,
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
          queryClient.getQueryData<WorkspaceMember[]>(['workspace-members']),
        ));
        if (closedByEffect || accessRevoked) {
          throw new ApiError(
            'The thread is no longer available.',
            409,
            'workstream_socket_unavailable',
          );
        }
        reportTelemetryProductIntent({ kind: 'run_requested', entrypoint: 'composer', operationId });
        const command: CreateMessageSocketCommand = {
          type: 'create_message',
          operationId,
          payload: {
            ...(input.annotations?.length ? { annotations: input.annotations } : {}),
            text: input.text,
            clientMessageId: input.clientId,
            mentions,
            confirmedParticipantUserIds: input.confirmedParticipantUserIds ?? [],
            attachmentIds: input.attachmentIds ?? [],
            ...(input.runMode ? { runMode: input.runMode } : {}),
          },
        };
        const result = await trace.step('command_round_trip', () => submitSubstreamCommand(command));
        if (result.command !== 'create_message') throw new Error('substream_command_receipt_mismatch');
        trace.end();
        return { ...result.turn, deliveryState: result.deliveryState };
      } catch (error) {
        trace.end({ outcome: 'failed' });
        throw error;
      }
    };
    answerElicitationRef.current = async (elicitationId, answer, customResponse): Promise<void> => {
      const result = await submitSubstreamCommand({
        type: 'answer_elicitation',
        operationId: uuidV7(),
        elicitationId,
        payload: answer === null
          ? { skipped: true }
          : { answer, ...(customResponse ? { customResponse } : {}) },
      });
      if (result.command !== 'answer_elicitation') throw new Error('substream_command_receipt_mismatch');
    };
    reorderPendingInputsRef.current = async (inputIds) => {
      const result = await submitSubstreamCommand({
        type: 'reorder_pending_inputs',
        operationId: uuidV7(),
        inputIds,
      });
      if (result.command !== 'reorder_pending_inputs') throw new Error('substream_command_receipt_mismatch');
      return { pendingInputs: result.pendingInputs };
    };
    // Keep queued choices bound to this addressed connection, even if the
    // header unmounts or the direct hook is later reused for another room.
    let appearanceQueue = Promise.resolve();
    setAppearanceRef.current = (appearance) => {
      const command = { type: 'set_workstream_appearance' as const, operationId: uuidV7(), appearance };
      const result = appearanceQueue.then(async () => {
        if (closedByEffect) throw new ApiError('The thread is no longer available.', 409, 'workstream_socket_unavailable');
        const breakoutUpdate = substreamId === '0'
          ? null
          : captureBreakoutAppearanceUpdate(queryClient, parentId, substreamId, appearance);
        const submitted = submitSubstreamCommand(command);
        // Read after the submit, which starts a connection attempt when none is
        // open and bumps the generation as it does.
        const sentOnGeneration = connectGeneration;
        const receipt = await submitted;
        if (receipt.command !== 'set_workstream_appearance') throw new Error('substream_command_receipt_mismatch');
        // The sidebar row has no preview of its own and the projection that
        // would update it is several hops away; the header keeps the picker's
        // preview, so only the row is written. The receipt is the commit —
        // on the connection that carried the command. A receipt that arrives
        // after a reconnect answers a resend, and the room answers a resend of
        // an already committed operation from its receipt without publishing
        // anything, so it may describe a value another client has since
        // replaced and whose newer state this client already holds. The
        // reconnect's snapshot carries the current value, so the patch is
        // simply not needed there, and applying it could put the older choice
        // back with nothing left to correct it.
        if (sentOnGeneration === connectGeneration) {
          if (substreamId === '0') {
            patchCachedWorkstreamAppearance(queryClient, parentId, appearance);
          } else {
            // A Breakout is listed by its parent rather than in the top-level
            // Channel directory. The receipt is its durable commit, so move
            // that one row immediately while the child-to-parent projection
            // follows and eventually replaces the whole versioned roster.
            applyBreakoutAppearanceReceipt(queryClient, parentId, substreamId, breakoutUpdate!);
          }
        }
      });
      appearanceQueue = result.catch(() => undefined);
      return result;
    };
    stopHarnessRef.current = async (): Promise<void> => {
      const result = await submitSubstreamCommand({ type: 'stop_harness', operationId: uuidV7() });
      if (result.command !== 'stop_harness') throw new Error('substream_command_receipt_mismatch');
    };
    retryHarnessRef.current = async () => {
      const result = await submitSubstreamCommand({ type: 'retry_harness', operationId: uuidV7() });
      if (result.command !== 'retry_harness') throw new Error('substream_command_receipt_mismatch');
      return { harnessRunId: result.harnessRunId };
    };
    // Readiness means the work-stream-specific handler is installed and can
    // hand a command to the room queue. The queue owns reconnecting
    // transport, so this intentionally does not wait for either socket to open.
    setSendReady(substreamId === '0' || queryClient.getQueryData(contextQueryKey) !== undefined);

    loadTranscriptRangeRef.current = (input): Promise<TranscriptRangeResult> => {
      if (closedByEffect || accessRevoked || socket?.readyState !== WebSocket.OPEN) {
        return Promise.reject(new ApiError(
          'The thread connection is not ready to load transcript ranges.',
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
            'The thread connection could not send the transcript range request.',
            409,
            'workstream_socket_unavailable',
            error,
          ));
        }
      });
    };

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

    const applyEvent = (event: ServerSocketEvent): void => {
      if (event.type === 'initial_context_snapshot_chunk') {
        const assembly = initialContextSnapshot;
        if (!assembly || assembly.snapshotId !== event.snapshotId || assembly.sequence !== event.sequence) return;
        if (assembly.chunkCount !== event.chunkCount || event.chunkIndex >= event.chunkCount
          || assembly.chunks.has(event.chunkIndex)) {
          initialContextSnapshot = null;
          queryClient.removeQueries({ queryKey: contextQueryKey, exact: true });
          setSendReady(false);
          requestCanonicalSnapshot();
          return;
        }
        assembly.chunks.set(event.chunkIndex, event.json);
        if (assembly.chunks.size !== assembly.chunkCount) return;
        try {
          const json = Array.from(
            { length: assembly.chunkCount },
            (_, index) => assembly.chunks.get(index)!,
          ).join('');
          const parsedContext = safeParseSocketEvent(SubstreamInitialContextSchema, JSON.parse(json));
          if (!parsedContext.success) throw parsedContext.error;
          const context = parsedContext.data;
          if (context.source.workstreamId !== parentId || context.source.substreamId !== '0') {
            throw new Error('substream_initial_context_identity_mismatch');
          }
          queryClient.setQueryData<SubstreamInitialContext | null>(contextQueryKey, context);
          initialContextSnapshot = null;
          setSendReady(canonicalCachesAvailable());
        } catch {
          initialContextSnapshot = null;
          queryClient.removeQueries({ queryKey: contextQueryKey, exact: true });
          setSendReady(false);
          requestCanonicalSnapshot();
        }
        return;
      }
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
          transcriptQueryKey,
        );
        if (!current || current.snapshotId !== assembly.snapshotId) {
          pendingInputSnapshot = null;
          return;
        }
        const complete = { ...current, pendingInputs: inputs };
        queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          transcriptQueryKey,
          complete,
        );
        const canonical = orderedTranscriptMessages(complete, parentId);
        queryClient.setQueryData<TranscriptOverlay[]>(
          overlaysQueryKey,
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
                parentId,
                { source: 'socket_snapshot', snapshotId: assembly.snapshotId },
              )),
            ],
          ),
        );
        pendingInputSnapshot = null;
        return;
      }
      if (event.type === 'resync_required') {
        initialContextSnapshot = null;
        queryClient.removeQueries({ queryKey: contextQueryKey, exact: true });
        pendingInputSnapshot = null;
        setSendReady(false);
        // Range replies are correlated to this exact admitted socket and its
        // snapshot fence. A reconnect cannot answer them, so release callers
        // immediately into their existing retry-after-reconnect path.
        rejectPendingTranscriptRanges(
          'The thread resynchronized while loading transcript ranges.',
        );
        setActiveCompaction(event.activeCompaction);
        updateInferenceDelays(event.activeInferenceDelays);
        canonicalResyncActiveStreams = event.reason === 'history_unavailable'
          ? event.activeStreams
          : [];
        if (canonicalResyncActiveStreams.length > 0) {
          const snapshot = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
            transcriptQueryKey,
          );
          const streamed = applyActiveStreamCheckpoints(
            [],
            canonicalResyncActiveStreams,
            parentId,
            streamCursors,
          );
          queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) =>
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
      // A refusal the room correlated to one request is that request's answer,
      // and it is read ahead of every guard below for the same reason the
      // resync branch releases these callers: a caller holding a correlated
      // promise has nothing else that will settle it, and a frame dropped here
      // costs it the full timeout and reports a timeout the room never had.
      // The room's own code steers, rather than being flattened to one of the
      // client's — the two the callers act on (`workstream_socket_unavailable`,
      // `transcript_snapshot_changed`) both mean "ask again", which a refusal
      // does not, and a wrong one would reconnect or retry against a room that
      // just said no. Its *message* does not reach the reader: the screen puts
      // `error.message` straight into the transcript's banner, and the room
      // writes for the protocol ("Subscribe before loading transcript ranges"),
      // not for somebody looking at a work stream. The refusal's own text stays
      // on `details`, where a report can still recover it.
      //
      // Returns, like the `transcript_range` branch below, and for the reason
      // the named identity establishes: `request_snapshot` carries no request
      // id, so a frame that carries one cannot be its answer. Falling through
      // would hand this refusal to the `answersSnapshotRequest` check, which
      // releases the snapshot slot on any error — and this refusal is *most*
      // likely while a reconciliation snapshot is assembling, which is when
      // the room lowers `subscribed` in the first place. The next
      // `harness_status_changed` would then send a second `request_snapshot`
      // over the top of the outstanding one.
      if (event.type === 'error' && event.requestId !== null) {
        const pending = pendingTranscriptRanges.get(event.requestId);
        if (pending) {
          pendingTranscriptRanges.delete(event.requestId);
          window.clearTimeout(pending.timeout);
          pending.reject(new ApiError(
            'This part of the transcript could not be loaded.',
            409,
            event.code,
            event.message,
          ));
        }
        return;
      }
      // Once replay history is unavailable, subsequent frames cannot safely be
      // applied on top of stale state. Reconnect from cursor zero and let the
      // admitted room install one new authoritative socket baseline.
      if (canonicalResyncTarget !== null) return;
      if (event.type === 'transcript_range') {
        const pending = pendingTranscriptRanges.get(event.requestId);
        if (pending) {
          pendingTranscriptRanges.delete(event.requestId);
          window.clearTimeout(pending.timeout);
        }
        const current = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          transcriptQueryKey,
        );
        if (current?.snapshotId === event.snapshotId
          && (!pending || pending.snapshotId === event.snapshotId)) {
          queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
            transcriptQueryKey,
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
      //
      // Only an *uncorrelated* error, though. `request_snapshot` carries no
      // request id, so a refusal that names one answers something else, and
      // releasing the slot on it frees a snapshot that is still outstanding.
      // The correlated branch above already returns before reaching this line;
      // the condition says so itself because the rule this protocol now sets —
      // every correlated request's refusals name it — is what makes the next
      // request/response pair added here walk straight into it.
      const answersSnapshotRequest = snapshotRequestInFlight
        && (event.type === 'snapshot' || (event.type === 'error' && event.requestId === null));
      if (answersSnapshotRequest) snapshotRequestInFlight = false;
      const currentTranscript = event.type === 'snapshot'
        ? queryClient.getQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey)
        : undefined;
      // Snapshots are valid at sequence zero and may intentionally replace
      // state at the same sequence after an explicit initial subscription.
      //
      // A seed the local cache painted is not a fence at all. Its numbers are
      // what the room said some launches ago, and a room rebuilt since then
      // can legitimately answer with lower ones; whatever the room sends now
      // is newer than anything the disk remembered.
      // The resume registry outlives the query entries, so the sequence it
      // remembers from an earlier visit is a fence the seed must skip too.
      const replacingLocalSeed = event.type === 'snapshot' && seededFromLocalCache();
      if (event.type === 'snapshot') {
        if (!replacingLocalSeed && event.sequence < resumeState.lastSequence) return;
        // The room sequence can be equal when a requested snapshot races the
        // upsert that prompted it. Transcript event sequence is the canonical
        // fence: an older snapshot must never roll the cache back.
        if (!replacingLocalSeed && currentTranscript && event.transcript.eventSequence < currentTranscript.eventSequence) return;
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
        const contextChunkCount = event.initialContextChunkCount ?? 0;
        initialContextSnapshot = contextChunkCount === 0 ? null : {
          snapshotId: event.transcript.snapshotId, sequence: event.sequence,
          chunkCount: contextChunkCount, chunks: new Map(),
        };
        if (contextChunkCount === 0) queryClient.setQueryData(contextQueryKey, null);
        else queryClient.removeQueries({ queryKey: contextQueryKey, exact: true });
        setActiveCompaction(event.activeCompaction);
        updateInferenceDelays(event.activeInferenceDelays);
        resumeState.suggestions = event.suggestions ?? [];
        setSuggestions(resumeState.suggestions);
        queryClient.setQueryData<number>(
          workstreamSocketSnapshotGenerationQueryKey(parentId, substreamId),
          (current) => (current ?? 0) + 1,
        );
        queryClient.setQueryData(workstreamFeedSourceQueryKey(parentId, substreamId), 'socket_snapshot');
        setSendReady(contextChunkCount === 0);
        const detail = mapWorkstreamDetail(event.workstream);
        queryClient.setQueryData(detailQueryKey, detail);
        // Only a reconciliation requested on this still-contiguous socket can
        // carry previously loaded ranges across a new snapshot fence. Initial
        // delivery and history-loss recovery have no proof that mutable turns
        // outside the bounded opening ranges did not change, so relabelling an
        // old range with the new snapshot id would make stale lifecycle state
        // look authoritative.
        const transcript = currentTranscript && !replacingLocalSeed && event.reason === 'reconciliation'
          ? mergeCanonicalTranscriptSnapshot(currentTranscript, event.transcript)
          : event.transcript;
        queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          transcriptQueryKey,
          transcript,
        );
        const canonical = orderedTranscriptMessages(transcript, parentId);
        const snapshotOverlays = [
          ...event.transcript.pendingInputs.map((input) => pendingTranscriptInputOverlay(
            input,
            parentId,
            { source: 'socket_snapshot', snapshotId: event.transcript.snapshotId },
          )),
          ...activeStreamCheckpointOverlays(
            event.activeStreams,
            parentId,
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
          overlaysQueryKey,
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
      } else if (event.type === 'loop_input_upserted') {
        queryClient.setQueryData<TranscriptOverlay[]>(
          overlaysQueryKey,
          (current) => replaceTranscriptOverlay(
            current,
            pendingTranscriptInputOverlay(event.input, parentId, {
              source: 'socket_event',
              eventType: event.type,
              eventSequence: event.sequence,
            }),
          ),
        );
      } else if (event.type === 'loop_input_removed') {
        queryClient.setQueryData<TranscriptOverlay[]>(
          overlaysQueryKey,
          (current) => removeTranscriptOverlay(current, (overlay) =>
            (overlay.identity.type === 'loop_input' && overlay.identity.inputId === event.inputId)
            || (overlay.identity.type === 'client_message' && overlay.identity.turnId === event.inputId)),
        );
      } else if (event.type === 'transcript_turn_upserted') {
        const next = queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          transcriptQueryKey,
          (current) => current
            ? mergeRealtimeTranscriptTurn(current, event.turn, event.sequence)
            : current,
        );
        if (next) {
          const canonical = orderedTranscriptMessages(next, parentId);
          queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) =>
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
          queryClient.setQueryData<WorkstreamDetail>(detailQueryKey, (current) =>
            current ? advance(current) : current);
          if (substreamId === '0') {
            setCachedWorkstreams(queryClient, (current) => current?.map((workstream) =>
              workstream.id === parentId ? advance(workstream) : workstream));
          }
        }
      } else if (event.type === 'transcript_activity_upserted') {
        queryClient.setQueryData<WorkstreamTranscriptSnapshot>(
          transcriptQueryKey,
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
        patchCachedWorkstream(queryClient, parentId, { title: event.title, titleStatus: event.titleStatus }, substreamId);
        // A naming pass also chooses the icon, and only where nobody has, so
        // the event carries one exactly when the server wrote one. The sidebar
        // row takes it if it has no icon of its own; the header waits for the
        // versioned projection. Both conditions are the writer's, and
        // `patchCachedGeneratedIcon` holds the reasons for each.
        if (event.icon && substreamId === '0') patchCachedGeneratedIcon(queryClient, parentId, event.icon);
      } else if (event.type === 'conversation_suggestion_changed') {
        // The row's whole state each time: replace what is held for that id,
        // and drop it once it is no longer open. The newest-three rule that
        // hides a line is the surface's to apply against the feed it holds.
        const others = resumeState.suggestions.filter((suggestion) => suggestion.suggestionId !== event.suggestion.suggestionId);
        resumeState.suggestions = event.suggestion.status === 'open' ? [...others, event.suggestion] : others;
        setSuggestions(resumeState.suggestions);
      } else if (event.type === 'workstream_scope_changed') {
        // Whoever this change excluded has already been disconnected by the
        // room, so everyone still here may read it and only needs the lock on
        // their sidebar row and the header they are reading to agree.
        patchCachedWorkstream(queryClient, parentId, { scope: event.scope }, substreamId);
      } else if (event.type === 'stream_completed') {
        const matchingCursors = new Map([...streamCursors].filter(([, cursor]) =>
          cursor.streamId === event.streamId));
        flushStreamReveal(matchingCursors);
        queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) => {
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
        queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) =>
          applyStreamingOverlayEvent(current, event, parentId, event.transcriptSequence - 1, streamCursors, {
            paced: document.visibilityState !== 'hidden',
          }));
        scheduleReveal();
      } else if (event.type === 'harness_status_changed') {
        applyHarnessStatus(queryClient, parentId, normalizeHarnessStatus(event.status), substreamId);
        if (event.status !== 'running') {
          setActiveCompaction(null);
          updateInferenceDelays([]);
        }
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
      } else if (event.type === 'inference_delay_changed') {
        const others = resumeState.activeInferenceDelays.filter((delay) => delay.inferenceRequestId !== event.inferenceRequestId);
        updateInferenceDelays(event.active ? [...others, InferenceDelayStateSchema.parse(event)] : others);
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
          transcriptQueryKey,
        )?.snapshotThrough ?? 0;
        queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) => {
          const messageId = `tool-${event.invocation.id}`;
          const existing = (current ?? []).find((overlay) =>
            overlay.identity.type === 'tool_call'
            && overlay.identity.toolCallId === event.invocation.toolCallId);
          const message = createToolEventMessage({
            id: messageId,
            transcriptTurnId: event.invocation.toolCallId.replace(/:tool:\d+$/u, ''),
            workstreamId: parentId,
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
        if (event.elicitation.status === 'cancelled') {
          queryClient.setQueryData<WorkstreamTranscriptSnapshot>(transcriptQueryKey, (current) =>
            current ? setTranscriptElicitationState(current, event.elicitation.id, {
              status: 'cancelled', answer: null,
            }) : current);
        }
        const messageId = elicitationMessageId(event.elicitation.id);
        const afterTranscriptSequence = queryClient.getQueryData<WorkstreamTranscriptSnapshot>(
          transcriptQueryKey,
        )?.snapshotThrough ?? 0;
        queryClient.setQueryData<TranscriptOverlay[]>(overlaysQueryKey, (current) => {
          if (event.elicitation.status === 'cancelled') {
            return removeTranscriptOverlay(current, (overlay) => overlay.identity.type === 'elicitation'
              && overlay.identity.elicitationId === event.elicitation.id);
          }
          const message = createElicitationMessage({
            id: messageId,
            workstreamId: parentId,
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
        queryClient.setQueryData<WorkstreamDetail>(detailQueryKey, (current) => {
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
        queryClient.setQueryData<WorkstreamDetail>(detailQueryKey, (current) =>
          current ? { ...current, participants: current.participants.filter((participant) => participant.id !== event.userId) } : current,
        );
      } else if (event.type === 'resource_attached' || event.type === 'resource_updated') {
        queryClient.setQueryData<WorkstreamDetail>(detailQueryKey, (current) => {
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

    const clearOpeningTimer = (): void => {
      if (openingTimer !== null) window.clearTimeout(openingTimer);
      openingTimer = null;
    };

    const completeOpeningFromCanonicalCaches = (): boolean => {
      if (!canonicalCachesAvailable()) return false;
      clearOpeningTimer();
      openingCompleted = true;
      openingTimedOutAttempts = 0;
      setOpeningError(undefined);
      return true;
    };

    const scheduleStabilityReset = (target: RealtimeSocket): void => {
      clearStabilityTimer();
      stabilityTimer = window.setTimeout(() => {
        stabilityTimer = null;
        if (closedByEffect || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
        attempts.current = 0;
      }, SOCKET_STABLE_CONNECTION_MS);
    };

    const probeHeartbeatNow = (target: RealtimeSocket): void => {
      if (closedByEffect || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
      // Preserve the older deadline. Restarting it on every focus flap would
      // let a half-open socket avoid heartbeat_timeout indefinitely.
      if (pongTimer !== null) return;
      clearHeartbeat();
      try {
        target.send('ping');
      } catch {
        socketTelemetry.willClose('transport_error');
        target.close();
        return;
      }
      pongTimer = window.setTimeout(() => {
        pongTimer = null;
        if (closedByEffect || socket !== target || target.readyState !== REALTIME_SOCKET_OPEN) return;
        socketTelemetry.willClose('heartbeat_timeout');
        target.close();
      }, PONG_TIMEOUT_MS);
    };

    const scheduleHeartbeat = (target: RealtimeSocket): void => {
      clearHeartbeat();
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = null;
        probeHeartbeatNow(target);
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
      updateInferenceDelays([]);
      clearReconnectTimer();
      clearOpeningTimer();
      connectGeneration += 1;
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      ticketRequestInFlight = false;
      setState('unavailable');
      setSendReady(false);
      evictCachedSubstream(queryClient, parentId, substreamId);
    };

    const scheduleReconnect = (): void => {
      if (closedByEffect || accessRevoked || openingTerminal) return;
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
        || accessRevoked
        || openingTerminal
        || ticketRequestInFlight
        || socket?.readyState === REALTIME_SOCKET_CONNECTING
        || socket?.readyState === REALTIME_SOCKET_OPEN
      ) return;
      if (isOffline()) {
        setState('unavailable');
        return;
      }
      clearReconnectTimer();
      ticketRequestInFlight = true;
      setState(attempts.current === 0 ? 'connecting' : 'reconnecting');
      const generation = connectGeneration += 1;
      const ticketAbort = new AbortController();
      activeTicketAbort = ticketAbort;
      // Opening a work stream is a ticket, a handshake, a subscribe, and a
      // snapshot, and only the last of those puts the transcript on screen. The
      // trace ends on the frame that answers the subscribe, so its total is what
      // the person waited for. `ticketId` is what the server's upgrade and room
      // spans carry as `rally.socket.ticket_id`, and the request id joins the
      // ticket call itself. Replaced per attempt: a reconnect is a new open.
      const openingAttemptId = workstreamFeedOpenAttemptId(parentId);
      const trace = startPerfTrace('workstream_open', {
        workstreamId: parentId,
        ...(openingAttemptId ? { operationId: openingAttemptId } : {}),
        report: openingAttemptId !== undefined,
      });
      openTrace?.end({ outcome: 'superseded' });
      openTrace = trace;
      let effectiveAfterSequence = openingCompleted ? resumeState.lastSequence : 0;
      if (!openingCompleted) {
        const timeoutMs = workstreamOpenTimeoutMs(openingTimedOutAttempts);
        clearOpeningTimer();
        openingTimer = window.setTimeout(() => {
          if (closedByEffect || openingTerminal || generation !== connectGeneration) return;
          openingTimer = null;
          const recoveredCanonically = completeOpeningFromCanonicalCaches();
          const timedOutDuringTicket = activeTicketAbort === ticketAbort;
          connectGeneration += 1;
          if (activeTicketAbort === ticketAbort) {
            activeTicketAbort = null;
            ticketAbort.abort(new SocketTicketRequestTimeoutError());
          }
          ticketRequestInFlight = false;
          clearHeartbeat();
          clearStabilityTimer();
          const timedOutSocket = socket;
          socket = null;
          timedOutSocket?.close();
          trace.end({ outcome: 'timeout', timeoutMs });
          if (openTrace === trace) openTrace = null;
          if (recoveredCanonically) {
            socketTelemetry.disconnected({
              attempts: attempts.current,
              retrying: true,
              ...(timedOutDuringTicket ? { cause: 'ticket_timeout' as const } : {}),
            });
            scheduleReconnect();
            return;
          }
          openingTimedOutAttempts += 1;
          const retrying = openingTimedOutAttempts < WORKSTREAM_OPEN_TIMEOUT_ATTEMPTS;
          socketTelemetry.disconnected({
            attempts: attempts.current,
            retrying,
            ...(timedOutDuringTicket ? { cause: 'ticket_timeout' as const } : {}),
          });
          if (!retrying) {
            openingTerminal = true;
            rejectPendingSubstreamCommands(new ApiError(
              'The live connection timed out before the breakout command completed.',
              408,
              'workstream_socket_open_timeout',
            ));
            setSendReady(false);
            setOpeningError('The live connection timed out after 3 attempts.');
            setState('unavailable');
            return;
          }
          scheduleReconnect();
        }, timeoutMs);
      }
      reportWorkstreamSocketStarted(
        parentId,
        resolvedSocketLeaseId,
        'substream_feed',
        attempts.current === 0 ? initialReasonRef.current : 'reconnect',
        attempts.current,
        trace.traceId,
        openingAttemptId,
      );
      trace.annotate({
        attempt: attempts.current,
        afterSequence: effectiveAfterSequence,
        // On attempt zero this is dead time nobody has measured: the work
        // stream is on screen and no request has been made yet. On a reconnect
        // it is the age of the effect, and the backoff explains it.
        sinceEffectMs: Math.round(
          ((typeof performance === 'undefined' ? Date.now() : performance.now()) - effectStartedAt) * 10,
        ) / 10,
      });
      try {
        if (canonicalResyncTarget !== null) {
          // Main and child conversations recover identically. Reset only the
          // addressed conversation's retained cursor; the next admitted socket
          // must answer from its own authority with a complete snapshot.
          resumeState.lastSequence = 0;
          effectiveAfterSequence = 0;
          streamCursors.clear();
          canonicalResyncTarget = null;
          canonicalResyncActiveStreams = [];
        }
        const speculative = !openCommittedRef.current;
        // Called directly rather than through `trace.step`: the socket-ticket
        // lint rule recognizes a ticket only when the awaited call is the
        // declarator's own initializer, and a `mark` on the next line closes
        // exactly the same span.
        const socketTicket = await api.getSocketTicket(
          parentId,
          substreamId,
          trace.traceId,
          effectiveAfterSequence,
          speculative,
          ticketAbort.signal,
          openingCompleted ? SOCKET_TICKET_REQUEST_TIMEOUT_MS : workstreamOpenTimeoutMs(openingTimedOutAttempts),
        );
        if (closedByEffect || generation !== connectGeneration) return;
        if (activeTicketAbort === ticketAbort) activeTicketAbort = null;
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
              afterSequence: effectiveAfterSequence,
              publishPresence: false,
            }));
          }
          markOpened();
          sendPendingSubstreamCommands(nextSocket);
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
            const commandResult = safeParseSocketEvent(WorkstreamSocketCommandResultSchema, parsed);
            if (commandResult.success) {
              const pending = pendingSubstreamCommands.get(commandResult.data.operationId);
              if (!pending) return;
              pendingSubstreamCommands.delete(commandResult.data.operationId);
              if (commandResult.data.type === 'client_command_succeeded') {
                if (pending.command.type !== commandResult.data.command) {
                  pending.reject(new ApiError(
                    'The breakout returned a receipt for a different command.',
                    500,
                    'substream_command_receipt_mismatch',
                  ));
                } else {
                  pending.resolve(commandResult.data);
                }
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
            const event = safeParseSocketEvent(ServerSocketEventSchema, parsed);
            if (event.success) {
              if (event.data.type === 'error'
                && ['workspace_socket_required', 'invalid_event'].includes(event.data.code)
                && pendingSubstreamCommands.size > 0) {
                rejectPendingSubstreamCommands(new ApiError(
                  event.data.message,
                  400,
                  event.data.code,
                ));
              }
              applyEvent(event.data);
              const completedFromFrame = completeOpeningFromCanonicalCaches();
              if (completedFromFrame && (event.data.type === 'snapshot' || event.data.type === 'initial_context_snapshot_chunk')) {
                api.confirmSocketTicket?.(socketTicket);
              }
              if (completedFromFrame && openTrace === trace) {
                // The first server frame after `subscribe` is the one that
                // made canonical state renderable. Replay-only events cannot
                // complete a cacheless open; their deadline stays armed until
                // a fresh authoritative socket snapshot installs both base caches.
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
              return;
            }
          } catch {
            // Invalid frames are ignored; the next object snapshot or requested
            // page remains authoritative and can replace this transport gap.
          }
        });
        nextSocket.addEventListener('close', (closeEvent) => {
          if (socket !== nextSocket) return;
          clearOpeningTimer();
          if (openTrace === trace) {
            trace.end({ outcome: 'closed', closeCode: closeEvent.code });
            openTrace = null;
          }
          clearHeartbeat();
          clearStabilityTimer();
          rejectPendingTranscriptRanges(
            'The thread connection closed while loading transcript ranges.',
          );
          pendingInputSnapshot = null;
          const contextAssemblyWasIncomplete = initialContextSnapshot !== null;
          initialContextSnapshot = null;
          if (contextAssemblyWasIncomplete) {
            queryClient.removeQueries({ queryKey: contextQueryKey, exact: true });
            resumeState.lastSequence = 0;
            openingCompleted = false;
            setSendReady(false);
          }
          socket = null;
          if (closeEvent.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE) {
            socketTelemetry.disconnected({
              attempts: attempts.current,
              retrying: false,
              cause: 'access_revoked',
            });
            rejectPendingSubstreamCommands(new ApiError(
              'You can no longer access this thread.',
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
              'The thread connection failed while loading transcript ranges.',
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
      } catch (error) {
        // Offline and teardown advance the generation before aborting the
        // ticket, so those owner cancellations are deliberately silent here.
        if (closedByEffect || generation !== connectGeneration) return;
        clearOpeningTimer();
        trace.end({ outcome: 'failed' });
        if (openTrace === trace) openTrace = null;
        if (!closedByEffect) {
          socketTelemetry.disconnected({
            attempts: attempts.current,
            retrying: !isOffline(),
            cause: isSocketTicketRequestTimeoutError(error) ? 'ticket_timeout' : 'ticket_failed',
          });
        }
        scheduleReconnect();
      } finally {
        if (activeTicketAbort === ticketAbort) activeTicketAbort = null;
        if (generation === connectGeneration) ticketRequestInFlight = false;
      }
    };

    const handleOnline = (): void => {
      if (closedByEffect || accessRevoked || openingTerminal) return;
      if (socket?.readyState === REALTIME_SOCKET_CONNECTING || socket?.readyState === REALTIME_SOCKET_OPEN) return;
      clearReconnectTimer();
      void connect();
    };

    const handleOffline = (): void => {
      clearReconnectTimer();
      clearHeartbeat();
      clearStabilityTimer();
      clearOpeningTimer();
      connectGeneration += 1;
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      ticketRequestInFlight = false;
      setState('unavailable');
      if (socket) socketTelemetry.willClose('offline');
      socket?.close();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const stopApplicationForeground = desktopBridge().onApplicationForegroundChanged(
      handleApplicationForegroundChange,
    );
    // The disk paints first and the socket corrects it. Hydration lands only
    // in caches that are still empty, so a live snapshot that beats the read
    // is never overwritten; the mirror writes only what a live snapshot
    // installed, so a seed never persists itself. Both are no-ops outside a
    // workspace scope, which is what keeps every standalone embedding and
    // test on the path that existed before the cache.
    const localCacheMirror = localCacheScope === null
      ? null
      : mirrorConversation(queryClient, localCacheScope, parentId, substreamId, localCacheKeys);
    if (localCacheScope !== null) {
      void hydrateConversation(
        queryClient,
        localCacheScope,
        parentId,
        substreamId,
        localCacheKeys,
        // A hydration still in flight when the reader is shut out must not
        // repaint what the eviction just removed.
        () => !closedByEffect && !accessRevoked,
      );
    }
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
      localCacheMirror?.stop();
      releaseData();
      setSendReady(false);
      requestSnapshotRef.current = () => undefined;
      markOpenedRef.current = () => undefined;
      openTrace?.end({ outcome: 'unmounted' });
      openTrace = null;
      createMessageRef.current = () => Promise.reject(new ApiError(
        'The thread is no longer available.',
        409,
        'workstream_socket_unavailable',
      ));
      answerElicitationRef.current = () => Promise.reject(new ApiError(
        'The breakout is no longer available.', 409, 'workstream_socket_unavailable',
      ));
      reorderPendingInputsRef.current = () => Promise.reject(new ApiError(
        'The breakout is no longer available.', 409, 'workstream_socket_unavailable',
      ));
      setAppearanceRef.current = () => Promise.reject(new ApiError('The thread is not connected.', 409, 'workstream_socket_unavailable'));
      stopHarnessRef.current = () => Promise.reject(new ApiError(
        'The breakout is no longer available.', 409, 'workstream_socket_unavailable',
      ));
      retryHarnessRef.current = () => Promise.reject(new ApiError(
        'The breakout is no longer available.', 409, 'workstream_socket_unavailable',
      ));
      loadTranscriptRangeRef.current = () => Promise.reject(new ApiError(
        'The thread is no longer available.',
        409,
        'workstream_socket_unavailable',
      ));
      rejectPendingTranscriptRanges('The thread changed while loading transcript ranges.');
      rejectPendingSubstreamCommands(new ApiError(
        'The breakout changed while sending a command.',
        409,
        'workstream_socket_unavailable',
      ));
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopApplicationForeground();
      if (revealFrame !== null) {
        window.cancelAnimationFrame(revealFrame);
        revealFrame = null;
      }
      clearReconnectTimer();
      clearHeartbeat();
      clearStabilityTimer();
      clearOpeningTimer();
      activeTicketAbort?.abort();
      activeTicketAbort = null;
      socket?.close();
    };
  }, [
    api,
    enabled,
    localCacheScope,
    openingRetryGeneration,
    queryClient,
    resolvedSocketLeaseId,
    resumeState,
    substreamId,
    parentId,
  ]);

  const workspaceSocketState = state === 'idle' ? 'unavailable' : state;

  return useMemo(
    () => ({
      state,
      ...(openingError ? { openingError } : {}),
      retryOpening,
      sendReady: sendReady && admissionAllowed,
      workspaceSocketState,
      activeCompaction,
      activeInferenceDelays,
      suggestions,
      answerElicitation,
      createMessage,
      loadTranscriptRange,
      requestSnapshot,
      reorderPendingInputs,
      retryHarness,
      stopHarness,
      setAppearance,
    }),
    [
      admissionAllowed,
      activeCompaction,
      activeInferenceDelays,
      suggestions,
      answerElicitation,
      createMessage,
      loadTranscriptRange,
      openingError,
      requestSnapshot,
      reorderPendingInputs,
      retryOpening,
      retryHarness,
      sendReady,
      state,
      stopHarness,
      setAppearance,
      workspaceSocketState,
    ],
  );
}
