import type { ElicitationData, Message, ToolEventData } from './types';
import type {
  TranscriptActivity,
  TranscriptRange,
  TranscriptTurn,
  WorkstreamTranscriptSnapshot,
} from '@rally/contracts';

export const TRANSCRIPT_RANGE_BLOCK_SIZE = 20;

type TextMessageInput = Omit<Message, 'messageType' | 'text'> & { text: string };
type ToolEventMessageInput = Omit<Message, 'messageType' | 'toolEvent'> & { toolEvent: ToolEventData };
type ElicitationMessageInput = Omit<Message, 'messageType' | 'elicitation'> & { elicitation: ElicitationData };

const activityReceiptMonotonic = new Map<string, {
  intervalId: string;
  revision: number;
  elapsedMsAtSnapshot: number;
  receivedAt: number;
}>();

export function dismissedSuggestionIdsQueryKey(workstreamId: string): readonly ['dismissed-suggestion-ids', string] {
  return ['dismissed-suggestion-ids', workstreamId];
}

export function appendDismissedSuggestionId(
  current: readonly string[] | undefined,
  suggestionId: string,
): readonly string[] {
  return current?.includes(suggestionId) ? current : [...(current ?? []), suggestionId];
}

export function visibleTranscriptMessages(
  messages: Message[],
  dismissedSuggestionIds: readonly string[] = [],
): Message[] {
  const dismissed = new Set(dismissedSuggestionIds);
  return messages.filter((message) => !(
    message.messageType === 'activity_suggestion'
    && message.activitySuggestion
    && (message.activitySuggestion.status === 'dismissed' || dismissed.has(message.activitySuggestion.id))
  ));
}

export function createTextMessage({ text, ...message }: TextMessageInput): Message {
  return { ...message, messageType: 'text', text };
}

export function createToolEventMessage({ toolEvent, ...message }: ToolEventMessageInput): Message {
  return { ...message, messageType: 'tool_event', toolEvent };
}

export function createElicitationMessage({ elicitation, ...message }: ElicitationMessageInput): Message {
  return { ...message, messageType: 'elicitation', elicitation };
}

export function isSameLogicalMessage(left: Message, right: Message): boolean {
  if (left.id === right.id) return true;
  if (left.clientMessageId && (
    left.clientMessageId === right.id
    || left.clientMessageId === right.clientMessageId
  )) return true;
  return Boolean(right.clientMessageId && right.clientMessageId === left.id);
}

function preferLogicalMessage(existing: Message, incoming: Message): Message {
  const existingElicitation = existing.messageType === 'elicitation' ? existing.elicitation : undefined;
  const incomingElicitation = incoming.messageType === 'elicitation' ? incoming.elicitation : undefined;
  if (
    existingElicitation
    && incomingElicitation
    && existingElicitation.id === incomingElicitation.id
    && existingElicitation.status === 'answered'
    && incomingElicitation.status === 'open'
  ) {
    return existing;
  }
  return incoming;
}

export function upsertTranscriptMessage(messages: Message[] | undefined, message: Message): Message[] {
  const existing = messages ?? [];
  const index = existing.findIndex((candidate) => isSameLogicalMessage(candidate, message));
  if (index < 0) return [...existing, message];
  const existingReplacement = existing.slice(index + 1).reduce(
    (preferred, candidate) => isSameLogicalMessage(candidate, message)
      ? preferLogicalMessage(preferred, candidate)
      : preferred,
    existing[index]!,
  );
  const replacement = preferLogicalMessage(existingReplacement, message);
  return [
    ...existing.slice(0, index),
    replacement,
    ...existing.slice(index + 1).filter((candidate) => !isSameLogicalMessage(candidate, message)),
  ];
}

export function removeTranscriptMessage(messages: Message[] | undefined, id: string): Message[] {
  return (messages ?? []).filter((message) => message.id !== id);
}

/**
 * Flatten ordered turn blocks only at the existing render boundary. Ordering
 * and lifecycle remain owned by the turn/block protocol; the automation wizard
 * continues to use its aggregate-message feed.
 */
export function orderedTranscriptMessages(
  snapshot: WorkstreamTranscriptSnapshot | undefined,
  workstreamId: string,
): Message[] {
  if (!snapshot) return [];
  const turns = new Map<number, TranscriptTurn>();
  for (const range of snapshot.ranges) {
    for (const turn of range.turns) {
      const current = turns.get(turn.transcriptSequence);
      if (!current || current.revision < turn.revision) turns.set(turn.transcriptSequence, turn);
    }
  }
  for (const turn of snapshot.activeTurns) {
    const current = turns.get(turn.transcriptSequence);
    if (!current || current.revision < turn.revision) turns.set(turn.transcriptSequence, turn);
  }
  const activities = new Map(snapshot.activities.map((activity) => [activity.activityId, activity]));
  const orderedTurns = [...turns.values()].sort(
    (left, right) => left.transcriptSequence - right.transcriptSequence,
  );
  const messages = orderedTurns
    .flatMap((turn) => turn.blocks
      .slice()
      .sort((left, right) => left.blockIndex - right.blockIndex)
      .map((block): Message => {
        const sequenceNumber = turn.transcriptSequence * 1_000 + block.blockIndex;
        const base = {
          id: block.blockId,
          transcriptTurnId: turn.turnId,
          workstreamId,
          sequenceNumber,
          attentionSequenceNumber: turn.attentionOrdinal,
          authorType: turn.actor === 'assistant' ? 'agent' as const : turn.actor,
          createdAt: turn.createdAtUtc,
        };
        if (block.type === 'text') {
          return {
            ...base,
            messageType: 'text',
            text: block.text,
            streaming: block.streaming,
          };
        }
        if (block.type === 'thinking') {
          const activity = activities.get(block.activityId);
          const timing = activityTiming(activity);
          return {
            ...base,
            authorType: 'agent',
            messageType: 'thought',
            thoughtEvent: {
              status: activity?.state === 'active' ? 'started' : 'completed',
              durationMs: timing.durationMs,
              ...(timing.monotonicStartedAt === undefined
                ? {}
                : { monotonicStartedAt: timing.monotonicStartedAt }),
              activeVerb: 'thinking',
              completedVerb: 'thought',
            },
          };
        }
        const activity = block.activityId ? activities.get(block.activityId) : undefined;
        return {
          ...base,
          authorType: 'agent',
          messageType: 'tool_event',
          toolEvent: {
            id: block.toolCallId,
            toolCallId: block.toolCallId,
            name: block.toolName,
            status: block.status === 'planned' || block.status === 'started'
              ? 'started'
              : block.status === 'cancelled'
                ? 'failed'
                : block.status,
            ...(typeof block.participantSafeResult === 'string'
              ? { summary: block.participantSafeResult }
              : {}),
            ...(block.participantSafeInput !== null ? { input: block.participantSafeInput } : {}),
            ...(block.participantSafeResult !== null ? { output: block.participantSafeResult } : {}),
            ...(activity ? { durationMs: activityDuration(activity) } : {}),
          },
        };
      }));
  for (const activity of snapshot.activities) {
    if (activity.scope !== 'response') continue;
    const assistantActivityIds = new Set(snapshot.activities
      .filter((candidate) =>
        candidate.scope === 'assistant_turn' && candidate.parentActivityId === activity.activityId)
      .map((candidate) => candidate.activityId));
    const ownedTurns = orderedTurns.filter((turn) =>
      turn.activityId !== null && assistantActivityIds.has(turn.activityId));
    const lastTurn = ownedTurns[ownedTurns.length - 1];
    if (!lastTurn) continue;
    const timing = activityTiming(activity);
    const activeInterval = activity.intervals.find((interval) => interval.stoppedAtUtc === null);
    messages.push({
      id: activity.activityId,
      transcriptTurnId: lastTurn.turnId,
      workstreamId,
      sequenceNumber: lastTurn.transcriptSequence * 1_000 + 999,
      attentionSequenceNumber: null,
      authorType: 'agent',
      messageType: 'thought',
      createdAt: activeInterval?.startedAtUtc ?? lastTurn.createdAtUtc,
      thoughtEvent: {
        status: activity.state === 'active' ? 'started' : 'completed',
        durationMs: timing.durationMs,
        ...(timing.monotonicStartedAt === undefined
          ? {}
          : { monotonicStartedAt: timing.monotonicStartedAt }),
        activeVerb: 'working',
        completedVerb: 'worked',
      },
    });
  }
  for (const activity of snapshot.activities) {
    if (activity.scope !== 'plugin') continue;
    const parent = activity.parentActivityId
      ? activities.get(activity.parentActivityId)
      : undefined;
    const lastTurn = parent?.scope === 'assistant_turn'
      ? orderedTurns.find((turn) => turn.turnId === parent.subjectId)
      : undefined;
    if (!lastTurn) continue;
    const lastToolIndex = Math.max(...lastTurn.blocks.flatMap((block) =>
      block.type === 'tool' && block.pluginId === activity.subjectId ? [block.blockIndex] : []));
    if (!Number.isFinite(lastToolIndex)) continue;
    const timing = activityTiming(activity);
    const activeInterval = activity.intervals.find((interval) => interval.stoppedAtUtc === null);
    messages.push({
      id: activity.activityId,
      transcriptTurnId: lastTurn.turnId,
      workstreamId,
      sequenceNumber: lastTurn.transcriptSequence * 1_000 + lastToolIndex + 1,
      attentionSequenceNumber: null,
      authorType: 'agent',
      messageType: 'thought',
      createdAt: activeInterval?.startedAtUtc ?? lastTurn.createdAtUtc,
      thoughtEvent: {
        status: activity.state === 'active' ? 'started' : 'completed',
        durationMs: timing.durationMs,
        ...(timing.monotonicStartedAt === undefined
          ? {}
          : { monotonicStartedAt: timing.monotonicStartedAt }),
        activeVerb: `${activity.label} working`,
        completedVerb: `${activity.label} worked`,
      },
    });
  }
  return messages.sort((left, right) => left.sequenceNumber - right.sequenceNumber);
}

/**
 * Retain only live overlays that do not yet have a canonical turn/block. A
 * canonical turn arrives before a run necessarily becomes terminal, so run
 * status is not a safe reconciliation signal; the stable Bind turn and tool
 * call identities are.
 */
export function transientMessagesWithoutCanonicalMatch(
  canonical: readonly Message[],
  routed: readonly Message[],
): Message[] {
  const canonicalTurnIds = new Set(canonical.flatMap((message) =>
    message.transcriptTurnId ? [message.transcriptTurnId] : []));
  const canonicalToolCallIds = new Set(canonical.flatMap((message) =>
    message.toolEvent ? [message.toolEvent.toolCallId ?? message.toolEvent.id] : []));
  return routed.filter((message) =>
    message.deliveryState === 'sending'
    || (message.realtimeOrder !== undefined
      && message.authorType === 'agent'
      && message.messageType === 'text'
      && (!message.transcriptTurnId || !canonicalTurnIds.has(message.transcriptTurnId)))
    || (message.messageType !== 'text'
      && message.messageType !== 'tool_event'
      && message.messageType !== 'thought')
    || (message.realtimeOrder !== undefined
      && message.messageType === 'tool_event'
      && (!message.toolEvent
        || !canonicalToolCallIds.has(message.toolEvent.toolCallId ?? message.toolEvent.id))));
}

/** Union the intervals the backend inspected; row presence is not coverage. */
export function transcriptCoverage(snapshot: WorkstreamTranscriptSnapshot): TranscriptRange[] {
  const ordered = snapshot.ranges
    .map((range) => range.covered)
    .filter((range) => range.endExclusive > range.startInclusive)
    .sort((left, right) => left.startInclusive - right.startInclusive);
  const merged: TranscriptRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || range.startInclusive > previous.endExclusive) {
      merged.push({ ...range });
      continue;
    }
    previous.endExclusive = Math.max(previous.endExclusive, range.endExclusive);
  }
  return merged;
}

export function transcriptGaps(snapshot: WorkstreamTranscriptSnapshot): TranscriptRange[] {
  const upper = snapshot.snapshotThrough + 1;
  const gaps: TranscriptRange[] = [];
  let cursor = 1;
  for (const covered of transcriptCoverage(snapshot)) {
    if (cursor < covered.startInclusive) {
      gaps.push({ startInclusive: cursor, endExclusive: covered.startInclusive });
    }
    cursor = Math.max(cursor, covered.endExclusive);
  }
  if (cursor < upper) gaps.push({ startInclusive: cursor, endExclusive: upper });
  return gaps;
}

export function adjacentTranscriptRange(
  snapshot: WorkstreamTranscriptSnapshot,
  direction: 'older' | 'newer',
): TranscriptRange | null {
  const coverage = transcriptCoverage(snapshot);
  if (coverage.length === 0) {
    const endExclusive = snapshot.snapshotThrough + 1;
    return endExclusive <= 1 ? null : {
      startInclusive: Math.max(1, endExclusive - TRANSCRIPT_RANGE_BLOCK_SIZE),
      endExclusive,
    };
  }
  if (direction === 'older') {
    const edge = coverage[0]!.startInclusive;
    return edge <= 1 ? null : {
      startInclusive: Math.max(1, edge - TRANSCRIPT_RANGE_BLOCK_SIZE),
      endExclusive: edge,
    };
  }
  // Load only the first uncovered interval after the oldest island. The latest
  // island is already present, so Jump to Latest never waits for this fill.
  const gaps = transcriptGaps(snapshot);
  const gap = gaps.find((candidate) => candidate.startInclusive >= coverage[0]!.endExclusive);
  if (!gap) return null;
  return {
    startInclusive: gap.startInclusive,
    endExclusive: Math.min(gap.endExclusive, gap.startInclusive + TRANSCRIPT_RANGE_BLOCK_SIZE),
  };
}

export function mergeRealtimeTranscriptTurn(
  snapshot: WorkstreamTranscriptSnapshot,
  turn: TranscriptTurn,
  eventSequence: number,
): WorkstreamTranscriptSnapshot {
  let replaced = false;
  const ranges = snapshot.ranges.map((range) => {
    const index = range.turns.findIndex((candidate) => candidate.turnId === turn.turnId);
    if (index < 0) return range;
    replaced = true;
    if (range.turns[index]!.revision >= turn.revision) return range;
    const turns = [...range.turns];
    turns[index] = turn;
    return { ...range, turns };
  });
  if (!replaced) {
    ranges.push({
      purpose: 'requested',
      requested: {
        startInclusive: turn.transcriptSequence,
        endExclusive: turn.transcriptSequence + 1,
      },
      covered: {
        startInclusive: turn.transcriptSequence,
        endExclusive: turn.transcriptSequence + 1,
      },
      turns: [turn],
    });
  }
  return {
    ...snapshot,
    snapshotThrough: Math.max(snapshot.snapshotThrough, turn.transcriptSequence),
    eventSequence: Math.max(snapshot.eventSequence, eventSequence),
    ranges,
    activeTurns: snapshot.activeTurns.filter((candidate) => candidate.turnId !== turn.turnId),
  };
}

export function mergeRealtimeTranscriptActivity(
  snapshot: WorkstreamTranscriptSnapshot,
  activity: TranscriptActivity,
  eventSequence: number,
  snapshotAtUtc: string,
): WorkstreamTranscriptSnapshot {
  const current = snapshot.activities.find((candidate) => candidate.activityId === activity.activityId);
  if (current && current.revision >= activity.revision) return snapshot;
  const activities = [
    ...snapshot.activities.filter((candidate) => candidate.activityId !== activity.activityId),
    activity,
  ];
  return {
    ...snapshot,
    eventSequence: Math.max(snapshot.eventSequence, eventSequence),
    snapshotAtUtc,
    activities,
    activeActivities: activities.filter((candidate) => candidate.state === 'active'),
  };
}

function activityDuration(activity: TranscriptActivity | undefined): number {
  if (!activity) return 0;
  return activity.intervals.reduce(
    (total, interval) => total + (interval.durationMs ?? interval.elapsedMsAtSnapshot ?? 0),
    0,
  );
}

function activityTiming(activity: TranscriptActivity | undefined): {
  durationMs: number;
  monotonicStartedAt?: number;
} {
  if (!activity) return { durationMs: 0 };
  const active = activity.intervals.find((interval) => interval.stoppedAtUtc === null);
  if (!active) return { durationMs: activityDuration(activity) };
  const elapsedMsAtSnapshot = active.elapsedMsAtSnapshot ?? 0;
  const cached = activityReceiptMonotonic.get(activity.activityId);
  const receivedAt = cached
    && cached.intervalId === active.intervalId
    && cached.revision === active.revision
    && cached.elapsedMsAtSnapshot === elapsedMsAtSnapshot
    ? cached.receivedAt
    : performance.now();
  activityReceiptMonotonic.set(activity.activityId, {
    intervalId: active.intervalId,
    revision: active.revision,
    elapsedMsAtSnapshot,
    receivedAt,
  });
  return {
    durationMs: activityDuration(activity),
    monotonicStartedAt: receivedAt,
  };
}
