import type { ElicitationData, Message, PluginActivityData, ToolEventData, WorkspaceMember } from './types';
import { pluginGroup } from './plugin-groups';
import {
  ActivitySuggestionSchema,
  ElicitationSchema,
  type TranscriptActivity,
  type PendingTranscriptInput,
  type TranscriptRange,
  type TranscriptTurn,
  type WorkstreamTranscriptSnapshot,
} from '@rally/contracts';
import { elicitationMessageId, normalizeElicitation } from './elicitation';

export const TRANSCRIPT_RANGE_BLOCK_SIZE = 20;

export type TranscriptOverlayIdentity =
  | { type: 'client_message'; clientMessageId: string; turnId?: string }
  | { type: 'loop_input'; inputId: string; futureTurnId: string }
  | { type: 'assistant_turn'; turnId: string }
  | { type: 'tool_call'; toolCallId: string }
  | { type: 'elicitation'; elicitationId: string }
  | { type: 'activity_suggestion'; suggestionId: string };

export type TranscriptOverlayProvenance =
  | { source: 'client_command'; phase: 'sending' | 'accepted' }
  | { source: 'socket_event'; eventType: string; eventSequence: number }
  | { source: 'socket_snapshot'; snapshotId: string }
  | { source: 'rest_snapshot'; snapshotId: string }
  | { source: 'stream_event'; streamId: string; eventType: 'stream_started' | 'stream_delta'; eventSequence: number }
  | { source: 'stream_snapshot'; streamId: string; snapshotId: string };

/**
 * Explicit, non-durable presentation state layered over the canonical ordered
 * transcript. A compatibility `Message` can never satisfy this type by
 * accident: every overlay names both where it came from and the canonical
 * identity that will replace it.
 */
export interface TranscriptOverlay {
  identity: TranscriptOverlayIdentity;
  provenance: TranscriptOverlayProvenance;
  /** Insert after this durable transcript turn; room sequence orders peers. */
  position: {
    afterTranscriptSequence: number;
    eventSequence: number;
  };
  message: Message;
}

/**
 * Apply presentation-only elicitation state to every canonical copy of the
 * turn. Ranges may overlap and active turns may duplicate a ranged turn, so an
 * optimistic answer has to update all copies or composition can resurrect the
 * still-open card. The turn revision is deliberately unchanged: the next
 * authoritative upsert must remain able to replace this local projection.
 */
export function setTranscriptElicitationState(
  snapshot: WorkstreamTranscriptSnapshot,
  elicitationId: string,
  state: { status: 'open' | 'answered'; answer: string | string[] | null },
): WorkstreamTranscriptSnapshot {
  const updateTurn = (turn: TranscriptTurn): TranscriptTurn => {
    let changed = false;
    const blocks = turn.blocks.map((block) => {
      if (block.type !== 'text' || block.messageType !== 'elicitation' || !block.structuredContent) {
        return block;
      }
      const wrapped = 'elicitation' in block.structuredContent;
      const source = wrapped ? block.structuredContent['elicitation'] : block.structuredContent;
      const parsed = ElicitationSchema.safeParse(source);
      if (!parsed.success || parsed.data.id !== elicitationId) return block;
      changed = true;
      const elicitation = { ...parsed.data, status: state.status, answer: state.answer };
      return {
        ...block,
        structuredContent: wrapped
          ? { ...block.structuredContent, elicitation }
          : elicitation,
      };
    });
    return changed ? { ...turn, blocks } : turn;
  };
  return {
    ...snapshot,
    ranges: snapshot.ranges.map((range) => ({
      ...range,
      turns: range.turns.map(updateTurn),
    })),
    activeTurns: snapshot.activeTurns.map(updateTurn),
  };
}

export function transcriptOverlaysQueryKey(
  workstreamId: string,
): readonly ['transcript-overlays', string] {
  return ['transcript-overlays', workstreamId];
}

type TextMessageInput = Omit<Message, 'messageType' | 'text'> & { text: string };
type ToolEventMessageInput = Omit<Message, 'messageType' | 'toolEvent'> & { toolEvent: ToolEventData };
type ElicitationMessageInput = Omit<Message, 'messageType' | 'elicitation'> & { elicitation: ElicitationData };

const activityReceiptMonotonic = new WeakMap<TranscriptActivity, {
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
  if (right.clientMessageId && right.clientMessageId === left.id) return true;
  if (left.elicitation && right.elicitation && left.elicitation.id === right.elicitation.id) return true;
  if (left.activitySuggestion && right.activitySuggestion
    && left.activitySuggestion.id === right.activitySuggestion.id) return true;
  return Boolean(left.toolEvent && right.toolEvent
    && (left.toolEvent.toolCallId ?? left.toolEvent.id) === (right.toolEvent.toolCallId ?? right.toolEvent.id));
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

/**
 * Flatten ordered turn blocks only at the existing render boundary. Ordering
 * and lifecycle remain owned by the turn/block protocol; the automation wizard
 * continues to use its aggregate-message feed.
 */
export function orderedTranscriptMessages(
  snapshot: WorkstreamTranscriptSnapshot | undefined,
  workstreamId: string,
  members: readonly WorkspaceMember[] = [],
): Message[] {
  if (!snapshot) return [];
  const membersById = new Map(members.map((member) => [member.id, member]));
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
  const messageOrder = new Map<string, {
    turnSequence: number;
    position: number;
    tieBreaker: string;
  }>();
  const orderedTurns = [...turns.values()].sort(
    (left, right) => left.transcriptSequence - right.transcriptSequence,
  );
  for (const turn of orderedTurns) {
    if (turn.actor === 'human' && turn.revision > 0
      && (!turn.authorUserId || !turn.authorSnapshot
        || turn.authorSnapshot.userId !== turn.authorUserId)) {
      throw new Error('canonical_human_author_provenance_invalid');
    }
  }
  const turnsById = new Map(orderedTurns.map((turn) => [turn.turnId, turn]));
  // A plugin activity is addressed by the turn it hangs off and the plugin it
  // is about; its own id is the backend's composition of exactly those two.
  // Reading it back through the parent link rather than rebuilding that string
  // keeps this projection independent of how the id happens to be spelled.
  const pluginActivitiesByTurnActivity = new Map<string, TranscriptActivity>();
  for (const activity of snapshot.activities) {
    if (activity.scope !== 'plugin' || !activity.parentActivityId) continue;
    pluginActivitiesByTurnActivity.set(`${activity.parentActivityId}\u0000${activity.subjectId}`, activity);
  }
  const lastTurnByResponseActivityId = new Map<string, TranscriptTurn>();
  for (const turn of orderedTurns) {
    const assistantActivity = turn.activityId ? activities.get(turn.activityId) : undefined;
    if (assistantActivity?.scope === 'assistant_turn' && assistantActivity.parentActivityId) {
      lastTurnByResponseActivityId.set(assistantActivity.parentActivityId, turn);
    }
  }
  const messages = orderedTurns
    .flatMap((turn) => turn.blocks
      .slice()
      .sort((left, right) => left.blockIndex - right.blockIndex)
      .map((block): Message => {
        const rememberOrder = (messageId: string): void => {
          // An open elicitation and its durable answer deliberately share one
          // UI identity. Keep the question's first position while the answered
          // representation replaces its content below.
          if (messageOrder.has(messageId)) return;
          messageOrder.set(messageId, {
            turnSequence: turn.transcriptSequence,
            position: block.blockIndex * 2,
            tieBreaker: block.blockId,
          });
        };
        const base = {
          id: block.blockId,
          transcriptTurnId: turn.turnId,
          transcriptSequence: turn.transcriptSequence,
          workstreamId,
          sequenceNumber: 0,
          attentionSequenceNumber: turn.attentionOrdinal,
          authorType: turn.actor === 'assistant' ? 'agent' as const : turn.actor,
          ...(turn.actor === 'human' && turn.authorUserId ? {
            author: turn.authorSnapshot ? {
              id: turn.authorSnapshot.userId,
              name: turn.authorSnapshot.displayName,
              ...(turn.authorSnapshot.avatarUrl ? { avatarUrl: turn.authorSnapshot.avatarUrl } : {}),
            } : turn.revision === 0 ? membersById.get(turn.authorUserId) : undefined,
          } : {}),
          ...(turn.clientMessageId ? { clientMessageId: turn.clientMessageId } : {}),
          ...(turn.actor === 'external' && turn.externalActor
            ? { externalActor: { ...turn.externalActor } }
            : {}),
          createdAt: turn.createdAtUtc,
        };
        if (block.type === 'text') {
          const structured = block.structuredContent ?? {};
          const elicitation = ElicitationSchema.safeParse(
            'elicitation' in structured ? structured['elicitation'] : structured,
          );
          const suggestion = ActivitySuggestionSchema.safeParse(
            'suggestion' in structured ? structured['suggestion'] : structured,
          );
          const statusKind = structured['kind'] === 'assistant_turn_failed'
            || structured['kind'] === 'assistant_turn_stopped'
            ? structured['kind']
            : null;
          const statusCode = typeof structured['code'] === 'string'
            ? structured['code']
            : 'assistant_turn_interrupted';
          const messageType: Message['messageType'] = statusKind
            ? 'system'
            : block.messageType === 'suggestion'
            ? 'activity_suggestion'
            : block.messageType ?? 'text';
          const messageId = elicitation.success ? elicitationMessageId(elicitation.data.id) : block.blockId;
          rememberOrder(messageId);
          return {
            ...base,
            id: messageId,
            messageType,
            text: block.text,
            streaming: block.streaming,
            ...(statusKind ? { statusEvent: { kind: statusKind, code: statusCode } } : {}),
            mentions: (block.mentions ?? []).map((mention) => {
              const member = mention.userId ? membersById.get(mention.userId) : undefined;
              return {
                type: mention.type,
                ...(mention.userId ? { personId: mention.userId } : {}),
                ...(mention.connectorType ? { connectorType: mention.connectorType } : {}),
                ...(member ? { displayName: member.name } : {}),
                ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
                startOffset: mention.startOffset,
                endOffset: mention.endOffset,
              };
            }),
            attachments: (block.attachments ?? []).map((attachment) => ({ ...attachment })),
            ...(structured['kind'] === 'suggested_work_expansion' && typeof structured['label'] === 'string'
              ? { contextLabel: structured['label'] }
              : {}),
            ...(elicitation.success ? { elicitation: normalizeElicitation(elicitation.data) } : {}),
            ...(suggestion.success ? {
              activitySuggestion: {
                id: suggestion.data.id,
                title: suggestion.data.title,
                source: 'Activity',
                occurredAt: suggestion.data.createdAt,
                reason: suggestion.data.reason,
                status: suggestion.data.status,
              },
            } : {}),
          };
        }
        if (block.type === 'thinking') {
          rememberOrder(block.blockId);
          const activity = activities.get(block.activityId);
          const timing = activityTiming(activity);
          return {
            ...base,
            authorType: 'agent',
            messageType: 'thought',
            thoughtEvent: {
              status: activity?.state === 'active' ? 'started' : 'completed',
              durationMs: timing.durationMs,
              timingAccuracy: timing.timingAccuracy,
              ...(timing.monotonicStartedAt === undefined
                ? {}
                : { monotonicStartedAt: timing.monotonicStartedAt }),
              activeVerb: 'thinking',
              completedVerb: 'thought',
            },
          };
        }
        const activity = block.activityId ? activities.get(block.activityId) : undefined;
        const owner = block.pluginId
          ? pluginActivitiesByTurnActivity.get(`${turn.activityId ?? ''}\u0000${block.pluginId}`)
          : undefined;
        rememberOrder(block.blockId);
        return {
          ...base,
          authorType: 'agent',
          messageType: 'tool_event',
          toolEvent: {
            id: block.toolCallId,
            toolCallId: block.toolCallId,
            ...(block.pluginId ? { pluginId: block.pluginId } : {}),
            ...(owner ? { pluginName: owner.label } : {}),
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
  for (const turn of orderedTurns) {
    if (turn.blocksOmitted !== true) continue;
    const messageId = `${turn.turnId}:blocks-omitted`;
    messageOrder.set(messageId, {
      turnSequence: turn.transcriptSequence,
      position: 0,
      tieBreaker: messageId,
    });
    messages.push({
      id: messageId,
      transcriptTurnId: turn.turnId,
      transcriptSequence: turn.transcriptSequence,
      workstreamId,
      sequenceNumber: 0,
      attentionSequenceNumber: turn.attentionOrdinal,
      authorType: turn.actor === 'assistant' ? 'agent' : turn.actor,
      ...(turn.actor === 'human' && turn.authorUserId && turn.authorSnapshot ? {
        author: {
          id: turn.authorSnapshot.userId,
          name: turn.authorSnapshot.displayName,
          ...(turn.authorSnapshot.avatarUrl ? { avatarUrl: turn.authorSnapshot.avatarUrl } : {}),
        },
      } : {}),
      ...(turn.actor === 'external' && turn.externalActor
        ? { externalActor: { ...turn.externalActor } }
        : {}),
      messageType: 'system',
      text: 'This message is too large to display.',
      createdAt: turn.createdAtUtc,
      blocksOmittedPlaceholder: true,
    });
  }
  for (const activity of snapshot.activities) {
    if (activity.scope !== 'response') continue;
    const lastTurn = lastTurnByResponseActivityId.get(activity.activityId);
    if (!lastTurn) continue;
    const timing = activityTiming(activity);
    const activeInterval = activity.intervals.find((interval) => interval.stoppedAtUtc === null);
    messages.push({
      id: activity.activityId,
      transcriptTurnId: lastTurn.turnId,
      transcriptSequence: lastTurn.transcriptSequence,
      workstreamId,
      sequenceNumber: 0,
      attentionSequenceNumber: null,
      authorType: 'agent',
      messageType: 'thought',
      createdAt: activeInterval?.startedAtUtc ?? lastTurn.createdAtUtc,
      thoughtEvent: {
        status: activity.state === 'active' ? 'started' : 'completed',
        durationMs: timing.durationMs,
        timingAccuracy: timing.timingAccuracy,
        ...(timing.monotonicStartedAt === undefined
          ? {}
          : { monotonicStartedAt: timing.monotonicStartedAt }),
        activeVerb: 'working',
        completedVerb: 'worked',
      },
    });
    messageOrder.set(activity.activityId, {
      turnSequence: lastTurn.transcriptSequence,
      position: (Math.max(-1, ...lastTurn.blocks.map((block) => block.blockIndex)) + 1) * 2,
      tieBreaker: activity.activityId,
    });
  }
  for (const activity of snapshot.activities) {
    if (activity.scope !== 'plugin') continue;
    const parent = activity.parentActivityId
      ? activities.get(activity.parentActivityId)
      : undefined;
    const lastTurn = parent?.scope === 'assistant_turn'
      ? turnsById.get(parent.subjectId)
      : undefined;
    if (!lastTurn) continue;
    const lastToolIndex = Math.max(...lastTurn.blocks.flatMap((block) =>
      block.type === 'tool' && block.pluginId === activity.subjectId ? [block.blockIndex] : []));
    if (!Number.isFinite(lastToolIndex)) continue;
    const group = pluginGroup(activity.subjectId, activity.label);
    if (!group) continue;
    const timing = activityTiming(activity);
    const activeInterval = activity.intervals.find((interval) => interval.stoppedAtUtc === null);
    messages.push({
      id: activity.activityId,
      transcriptTurnId: lastTurn.turnId,
      transcriptSequence: lastTurn.transcriptSequence,
      workstreamId,
      sequenceNumber: 0,
      attentionSequenceNumber: null,
      authorType: 'agent',
      messageType: 'plugin_activity',
      createdAt: activeInterval?.startedAtUtc ?? lastTurn.createdAtUtc,
      pluginActivity: {
        groupKey: group.key,
        name: group.name,
        icon: group.icon,
        active: activity.state === 'active',
        durationMs: timing.durationMs,
        timingAccuracy: timing.timingAccuracy,
        ...(timing.monotonicStartedAt === undefined
          ? {}
          : { monotonicStartedAt: [timing.monotonicStartedAt] }),
      },
    });
    messageOrder.set(activity.activityId, {
      turnSequence: lastTurn.transcriptSequence,
      position: lastToolIndex * 2 + 1,
      tieBreaker: activity.activityId,
    });
  }
  // Canonical blocks are not optimistic messages. In particular, every block
  // in one human turn legitimately shares its `clientMessageId`; using the
  // generic optimistic-message reconciler here would collapse those blocks and
  // could lose text. Only protocol-declared singleton UI identities coalesce.
  // The index also keeps flattening linear before the final display sort.
  const logicalMessages: Message[] = [];
  const logicalMessageIndexes = new Map<string, number>();
  for (const message of messages) {
    const key = canonicalLogicalMessageKey(message);
    const index = logicalMessageIndexes.get(key);
    if (index === undefined) {
      logicalMessageIndexes.set(key, logicalMessages.length);
      logicalMessages.push(message);
    } else {
      const anchored = logicalMessages[index]!;
      logicalMessages[index] = {
        ...preferLogicalMessage(anchored, message),
        // One logical UI row keeps the first canonical slot even when a later
        // answer replaces its presentation. Carrying the answer turn's
        // sequence back to the question's position makes the ordered list
        // internally non-monotonic and causes composition to fail closed.
        transcriptTurnId: anchored.transcriptTurnId,
        transcriptSequence: anchored.transcriptSequence,
        attentionSequenceNumber: anchored.attentionSequenceNumber,
      };
    }
  }
  return logicalMessages
    .sort((left, right) => {
      const leftOrder = messageOrder.get(left.id)!;
      const rightOrder = messageOrder.get(right.id)!;
      return leftOrder.turnSequence - rightOrder.turnSequence
        || leftOrder.position - rightOrder.position
        || (leftOrder.tieBreaker < rightOrder.tieBreaker
          ? -1 : leftOrder.tieBreaker > rightOrder.tieBreaker ? 1 : 0);
    })
    .map((message, index) => ({ ...message, sequenceNumber: index + 1 }));
}

function canonicalLogicalMessageKey(message: Message): string {
  if (message.elicitation) return `elicitation:${message.elicitation.id}`;
  if (message.activitySuggestion) return `activity_suggestion:${message.activitySuggestion.id}`;
  if (message.toolEvent) {
    return `tool_call:${message.toolEvent.toolCallId ?? message.toolEvent.id}`;
  }
  return `block:${message.id}`;
}

/**
 * Retain only live overlays that do not yet have a canonical turn/block. A
 * canonical turn arrives before a run necessarily becomes terminal, so run
 * status is not a safe reconciliation signal; the stable Bind turn and tool
 * call identities are.
 */
export function transcriptOverlaysWithoutCanonicalMatch(
  canonical: readonly Message[],
  overlays: readonly TranscriptOverlay[],
): TranscriptOverlay[] {
  const clientMessageIds = new Set(canonical.flatMap((message) =>
    message.clientMessageId ? [message.clientMessageId] : []));
  const turnIds = new Set(canonical.flatMap((message) =>
    message.transcriptTurnId ? [message.transcriptTurnId] : []));
  const settledAssistantTurnIds = new Set(canonical.flatMap((message) =>
    message.transcriptTurnId
      && ((message.messageType === 'text' && message.streaming !== true) || message.statusEvent)
      ? [message.transcriptTurnId]
      : []));
  const toolCallIds = new Set(canonical.flatMap((message) => {
    const id = message.toolEvent?.toolCallId ?? message.toolEvent?.id;
    return id ? [id] : [];
  }));
  const elicitationIds = new Set(canonical.flatMap((message) =>
    message.elicitation ? [message.elicitation.id] : []));
  const suggestionIds = new Set(canonical.flatMap((message) =>
    message.activitySuggestion ? [message.activitySuggestion.id] : []));
  return overlays.filter((overlay) => {
    const identity = overlay.identity;
    if (identity.type === 'client_message') {
      return !clientMessageIds.has(identity.clientMessageId)
        && !(identity.turnId && turnIds.has(identity.turnId));
    }
    if (identity.type === 'loop_input') return !turnIds.has(identity.futureTurnId);
    if (identity.type === 'assistant_turn') return !settledAssistantTurnIds.has(identity.turnId);
    if (identity.type === 'tool_call') return !toolCallIds.has(identity.toolCallId);
    if (identity.type === 'elicitation') return !elicitationIds.has(identity.elicitationId);
    return !suggestionIds.has(identity.suggestionId);
  });
}

export function upsertTranscriptOverlay(
  overlays: readonly TranscriptOverlay[] | undefined,
  overlay: TranscriptOverlay,
): TranscriptOverlay[] {
  const current = overlays ?? [];
  const index = current.findIndex((candidate) =>
    transcriptOverlayIdentityKey(candidate.identity) === transcriptOverlayIdentityKey(overlay.identity));
  return index < 0
    ? [...current, overlay]
    : [
        ...current.slice(0, index),
        { ...overlay, position: current[index]!.position },
        ...current.slice(index + 1),
      ];
}

/**
 * Install server-owned overlays over any optimistic copies of the same
 * protocol identities. The server position is authoritative: retaining the
 * client's guessed anchor would make concurrent pending inputs visibly diverge
 * from the order the loop will eventually deliver.
 */
export function reconcileAuthoritativeTranscriptOverlays(
  canonical: readonly Message[],
  current: readonly TranscriptOverlay[] | undefined,
  authoritative: readonly TranscriptOverlay[],
): TranscriptOverlay[] {
  const retainedClientCommands = transcriptOverlaysWithoutCanonicalMatch(
    canonical,
    (current ?? []).filter((overlay) => overlay.provenance.source === 'client_command'),
  );
  const byIdentity = new Map(retainedClientCommands.map((overlay) =>
    [transcriptOverlayIdentityKey(overlay.identity), overlay]));
  for (const overlay of authoritative) {
    byIdentity.set(transcriptOverlayIdentityKey(overlay.identity), overlay);
  }
  return transcriptOverlaysWithoutCanonicalMatch(canonical, [...byIdentity.values()]);
}

/** Replace one optimistic overlay with the server-owned position and bytes. */
export function replaceTranscriptOverlay(
  overlays: readonly TranscriptOverlay[] | undefined,
  overlay: TranscriptOverlay,
): TranscriptOverlay[] {
  const current = overlays ?? [];
  const key = transcriptOverlayIdentityKey(overlay.identity);
  const index = current.findIndex((candidate) =>
    transcriptOverlayIdentityKey(candidate.identity) === key);
  return index < 0
    ? [...current, overlay]
    : [...current.slice(0, index), overlay, ...current.slice(index + 1)];
}

export function transcriptOverlayIdentityKey(identity: TranscriptOverlayIdentity): string {
  switch (identity.type) {
    case 'client_message': return `client_message:${identity.clientMessageId}`;
    case 'loop_input': return `loop_input:${identity.inputId}`;
    case 'assistant_turn': return `assistant_turn:${identity.turnId}`;
    case 'tool_call': return `tool_call:${identity.toolCallId}`;
    case 'elicitation': return `elicitation:${identity.elicitationId}`;
    case 'activity_suggestion': return `activity_suggestion:${identity.suggestionId}`;
  }
}

/** Project one server-owned, non-canonical loop input into presentation state. */
export function pendingTranscriptInputOverlay(
  input: PendingTranscriptInput,
  workstreamId: string,
  provenance: Extract<TranscriptOverlayProvenance, {
    source: 'socket_event' | 'socket_snapshot' | 'rest_snapshot';
  }>,
): TranscriptOverlay {
  return {
    identity: input.clientMessageId
      ? { type: 'client_message', clientMessageId: input.clientMessageId, turnId: input.futureTurnId }
      : { type: 'loop_input', inputId: input.inputId, futureTurnId: input.futureTurnId },
    provenance,
    position: {
      afterTranscriptSequence: input.afterTranscriptSequence,
      eventSequence: provenance.source === 'socket_event'
        ? provenance.eventSequence
        : input.inputSequence,
    },
    message: {
      id: input.futureTurnId,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      workstreamId,
      sequenceNumber: 0,
      authorType: input.actor,
      ...(input.authorSnapshot ? {
        author: {
          id: input.authorSnapshot.userId,
          name: input.authorSnapshot.displayName,
          ...(input.authorSnapshot.avatarUrl ? { avatarUrl: input.authorSnapshot.avatarUrl } : {}),
        },
      } : {}),
      ...(input.externalActor ? { externalActor: { ...input.externalActor } } : {}),
      messageType: input.block.messageType === 'system' ? 'system' : 'text',
      text: input.block.text,
      mentions: input.block.mentions?.map((mention) => ({
        type: mention.type,
        ...(mention.userId ? { personId: mention.userId } : {}),
        ...(mention.connectorType ? { connectorType: mention.connectorType } : {}),
        startOffset: mention.startOffset,
        endOffset: mention.endOffset,
      })),
      attachments: input.block.attachments?.map((attachment) => ({ ...attachment })),
      createdAt: input.admittedAtUtc,
      deliveryState: input.deliveryMode === 'steer' ? 'steer_pending' : 'queue_pending',
    },
  };
}

/** Update presentation content without weakening its identity or provenance. */
export function mapTranscriptOverlayMessages(
  overlays: readonly TranscriptOverlay[] | undefined,
  update: (messages: Message[]) => Message[],
): TranscriptOverlay[] {
  const current = overlays ?? [];
  const messages = current.map((overlay) => overlay.message);
  const updated = update(messages);
  if (updated.length === messages.length
    && updated.every((message, index) => message === messages[index])) {
    return current as TranscriptOverlay[];
  }
  const updatedById = new Map(updated
    .map((message) => [message.id, message]));
  return current.flatMap((overlay) => {
    const message = updatedById.get(overlay.message.id);
    return message ? [{ ...overlay, message }] : [];
  });
}

export function removeTranscriptOverlay(
  overlays: readonly TranscriptOverlay[] | undefined,
  predicate: (overlay: TranscriptOverlay) => boolean,
): TranscriptOverlay[] {
  return (overlays ?? []).filter((overlay) => !predicate(overlay));
}

/**
 * Compose already-ordered canonical rows with explicitly sourced, non-durable
 * overlays. Canonical projection is the expensive side and is memoized by the
 * screen; sorting it again on every reveal tick would put the whole loaded
 * transcript on the display-rate path.
 */
export function composeTranscript(
  canonical: readonly Message[],
  overlays: readonly TranscriptOverlay[],
): Message[] {
  const live = transcriptOverlaysWithoutCanonicalMatch(canonical, overlays);
  const activeAssistantTurns = new Set(live.flatMap((overlay) =>
    overlay.identity.type === 'assistant_turn' ? [overlay.identity.turnId] : []));
  let previousCanonicalSequence = 0;
  const visibleCanonical = canonical.filter((message) => {
    const transcriptSequence = message.transcriptSequence;
    if (typeof transcriptSequence !== 'number'
      || !Number.isSafeInteger(transcriptSequence)
      || transcriptSequence < 1
      || transcriptSequence < previousCanonicalSequence) {
      throw new Error('Rally received an invalid transcript order. Reopen this work stream.');
    }
    previousCanonicalSequence = transcriptSequence;
    return !(
      message.messageType === 'text'
      && message.streaming === true
      && message.transcriptTurnId !== undefined
      && activeAssistantTurns.has(message.transcriptTurnId)
    );
  });
  const orderedLive = [...live].sort((left, right) =>
    left.position.afterTranscriptSequence - right.position.afterTranscriptSequence
    || left.position.eventSequence - right.position.eventSequence
    || (left.message.id < right.message.id ? -1 : left.message.id > right.message.id ? 1 : 0));
  const composed: Message[] = [];
  let canonicalIndex = 0;
  for (const overlay of orderedLive) {
    while (canonicalIndex < visibleCanonical.length) {
      const candidate = visibleCanonical[canonicalIndex];
      if (!candidate || candidate.transcriptSequence === undefined
        || candidate.transcriptSequence > overlay.position.afterTranscriptSequence) break;
      composed.push(candidate);
      canonicalIndex += 1;
    }
    composed.push(overlay.message);
  }
  composed.push(...visibleCanonical.slice(canonicalIndex));
  return composed.map((message, index) => ({ ...message, sequenceNumber: index + 1 }));
}

/**
 * What one row contributes to its plugin's group, or null when the row is not
 * plugin activity at all.
 */
function pluginGroupContribution(message: Message): {
  key: string;
  activity: PluginActivityData;
  /** Plugin-activity rows carry the authoritative aggregate; tool rows do not. */
  authoritativeDuration: boolean;
} | null {
  if (message.pluginActivity) {
    return {
      key: message.pluginActivity.groupKey,
      activity: message.pluginActivity,
      authoritativeDuration: true,
    };
  }
  const tool = message.toolEvent;
  if (!tool) return null;
  const group = pluginGroup(tool.pluginId, tool.pluginName ?? tool.plugin?.displayName);
  if (!group) return null;
  return {
    key: group.key,
    activity: {
      groupKey: group.key,
      name: group.name,
      icon: group.icon,
      active: tool.status === 'started',
      durationMs: tool.durationMs ?? 0,
    },
    authoritativeDuration: false,
  };
}

/**
 * Whether a row leaves the run of activity around it open.
 *
 * Thinking rows do not close it. The model thinks between every pair of tool
 * calls, so closing on one would mean nothing ever grouped — the two Granola
 * calls a run makes either side of a thought are one stretch of Granola work,
 * and that is the case this feature exists for. Anything a person reads or
 * answers does close it: a sentence from Rally is a report on the work above
 * it, and folding work that came after the sentence back into a row printed
 * before it would put the feed out of order with its own narration.
 */
function continuesPluginActivityRun(message: Message): boolean {
  return message.messageType === 'tool_event'
    || message.messageType === 'plugin_activity'
    || message.messageType === 'thought';
}

/**
 * Collapse tool calls into one row per plugin per run of uninterrupted agent
 * activity.
 *
 * The tools themselves are not what this audience reads — `table_insert_rows`
 * and `slack_read_thread` are implementation, and a screenful of them buries
 * the conversation they belong to. What a reader does want is which places
 * Rally is working in and for how long, so that is the whole row: a plugin's
 * mark, its name, and its time.
 *
 * A group sits where its plugin's *first* call in the run sat, not where its
 * last one did, which keeps the feed's order the order work started in. The
 * run ends at the first thing a person reads — see `continuesPluginActivityRun`
 * — so a plugin picked up again after Rally has said something starts a second
 * row under that sentence rather than reopening the one above it.
 *
 * Timing comes from the plugin activity when the transcript carries one — it
 * measures the plugin, including the time between its calls. Summed tool
 * durations are the fallback for a row whose activity has not arrived, and
 * they undercount by exactly that gap, so an activity always displaces them.
 */
export function groupPluginToolMessages(messages: readonly Message[]): Message[] {
  interface GroupTiming {
    row: number;
    identity: Pick<PluginActivityData, 'groupKey' | 'icon' | 'name'>;
    active: boolean;
    activityDurationMs: number;
    toolDurationMs: number;
    sawActivity: boolean;
    monotonicStartedAt: number[];
    upperBound: boolean;
  }
  const groups: GroupTiming[] = [];
  let open = new Map<string, GroupTiming>();
  const rows: Message[] = [];
  for (const message of messages) {
    if (!continuesPluginActivityRun(message)) {
      open = new Map();
      rows.push(message);
      continue;
    }
    const contribution = pluginGroupContribution(message);
    if (!contribution) {
      // A tool row that named no plugin is dropped rather than shown: all it
      // carries is a tool name, which is the thing this feed hides, and the
      // canonical block names its owner a beat later under a row of its own.
      if (!message.toolEvent) rows.push(message);
      continue;
    }
    let group = open.get(contribution.key);
    if (!group) {
      const { groupKey, icon, name } = contribution.activity;
      group = {
        row: rows.length,
        identity: { groupKey, icon, name },
        active: false,
        activityDurationMs: 0,
        toolDurationMs: 0,
        sawActivity: false,
        monotonicStartedAt: [],
        upperBound: false,
      };
      open.set(contribution.key, group);
      groups.push(group);
      rows.push({
        ...message,
        id: `${message.id}:plugin-group:${contribution.key}`,
        messageType: 'plugin_activity',
        pluginActivity: contribution.activity,
        // The tool call and its own thinking row are what this replaces;
        // nothing downstream should read them back off the group.
        toolEvent: undefined,
        thoughtEvent: undefined,
      });
    }
    group.active ||= contribution.activity.active;
    if (contribution.authoritativeDuration) {
      group.sawActivity = true;
      group.activityDurationMs += contribution.activity.durationMs;
    } else {
      group.toolDurationMs += contribution.activity.durationMs;
    }
    // Every running contribution, not the last one seen: they run at the same
    // time and the completed total counts them all, so the live number has to
    // advance by all of them or it jumps at settle.
    group.monotonicStartedAt.push(...(contribution.activity.monotonicStartedAt ?? []));
    if (contribution.activity.timingAccuracy === 'upper_bound') group.upperBound = true;
  }
  for (const group of groups) {
    const row = rows[group.row]!;
    rows[group.row] = {
      ...row,
      pluginActivity: {
        ...group.identity,
        active: group.active,
        durationMs: group.sawActivity ? group.activityDurationMs : group.toolDurationMs,
        ...(group.monotonicStartedAt.length === 0
          ? {}
          : { monotonicStartedAt: group.monotonicStartedAt }),
        ...(group.upperBound ? { timingAccuracy: 'upper_bound' as const } : {}),
      },
    };
  }
  return rows.map((message, index) => ({ ...message, sequenceNumber: index + 1 }));
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

export function transcriptCoverageAdvanced(
  before: WorkstreamTranscriptSnapshot,
  after: WorkstreamTranscriptSnapshot,
): boolean {
  const previous = transcriptCoverage(before);
  const next = transcriptCoverage(after);
  return previous.length !== next.length || next.some((covered, index) => {
    const prior = previous[index];
    return prior?.startInclusive !== covered.startInclusive
      || prior.endExclusive !== covered.endExclusive;
  });
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
  const existingRevision = Math.max(
    -1,
    ...snapshot.ranges.flatMap((range) => range.turns
      .filter((candidate) => candidate.turnId === turn.turnId)
      .map((candidate) => candidate.revision)),
    ...snapshot.activeTurns
      .filter((candidate) => candidate.turnId === turn.turnId)
      .map((candidate) => candidate.revision),
  );
  if (existingRevision >= turn.revision) {
    return eventSequence <= snapshot.eventSequence
      ? snapshot
      : { ...snapshot, eventSequence };
  }
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
      activities: [],
    });
  }
  return {
    ...snapshot,
    eventSequence: Math.max(snapshot.eventSequence, eventSequence),
    snapshotThrough: Math.max(snapshot.snapshotThrough, turn.transcriptSequence),
    ranges,
    activeTurns: snapshot.activeTurns.filter((candidate) => candidate.turnId !== turn.turnId),
  };
}

export function mergeTranscriptRange(
  snapshot: WorkstreamTranscriptSnapshot,
  range: WorkstreamTranscriptSnapshot['ranges'][number],
): WorkstreamTranscriptSnapshot {
  const activities = new Map(snapshot.activities.map((activity) => [activity.activityId, activity]));
  for (const activity of range.activities) {
    const current = activities.get(activity.activityId);
    if (!current || current.revision < activity.revision) activities.set(activity.activityId, activity);
  }
  const mergedActivities = [...activities.values()];
  return {
    ...snapshot,
    ranges: [...snapshot.ranges, range],
    activities: mergedActivities,
    activeActivities: mergedActivities.filter((activity) => activity.state === 'active'),
  };
}

function uncoveredRangeSegments(
  range: TranscriptRange,
  covered: readonly TranscriptRange[],
  upperExclusive: number,
): TranscriptRange[] {
  const endExclusive = Math.min(range.endExclusive, upperExclusive);
  if (range.startInclusive >= endExclusive) return [];
  const segments: TranscriptRange[] = [];
  let cursor = range.startInclusive;
  for (const replacement of covered) {
    if (replacement.endExclusive <= cursor) continue;
    if (replacement.startInclusive >= endExclusive) break;
    if (cursor < replacement.startInclusive) {
      segments.push({
        startInclusive: cursor,
        endExclusive: Math.min(replacement.startInclusive, endExclusive),
      });
    }
    cursor = Math.max(cursor, replacement.endExclusive);
    if (cursor >= endExclusive) break;
  }
  if (cursor < endExclusive) segments.push({ startInclusive: cursor, endExclusive });
  return segments;
}

function activitiesForTurns(
  activities: readonly TranscriptActivity[],
  turns: readonly TranscriptTurn[],
): TranscriptActivity[] {
  const byId = new Map(activities.map((activity) => [activity.activityId, activity]));
  const required = new Set(turns.flatMap((turn) => [
    ...(turn.activityId ? [turn.activityId] : []),
    ...turn.blocks.flatMap((block) => 'activityId' in block && block.activityId
      ? [block.activityId]
      : []),
  ]));
  for (const activityId of required) {
    let parentId = byId.get(activityId)?.parentActivityId;
    while (parentId && !required.has(parentId)) {
      required.add(parentId);
      parentId = byId.get(parentId)?.parentActivityId;
    }
  }
  return activities.filter((activity) => required.has(activity.activityId));
}

/**
 * Apply a fresh canonical snapshot without turning its deliberately bounded
 * opening ranges into a deletion of history this reader already loaded. The
 * new snapshot is authoritative inside its covered intervals; only older
 * coverage outside those intervals is retained under the new snapshot fence.
 */
export function mergeCanonicalTranscriptSnapshot(
  current: WorkstreamTranscriptSnapshot,
  incoming: WorkstreamTranscriptSnapshot,
): WorkstreamTranscriptSnapshot {
  const incomingCoverage = transcriptCoverage(incoming);
  const upperExclusive = incoming.snapshotThrough + 1;
  const retainedRanges = current.ranges.flatMap((range) =>
    uncoveredRangeSegments(range.covered, incomingCoverage, upperExclusive).map((covered) => {
      const turns = range.turns.filter((turn) =>
        turn.transcriptSequence >= covered.startInclusive
        && turn.transcriptSequence < covered.endExclusive);
      return {
        purpose: 'requested' as const,
        requested: covered,
        covered,
        turns,
        activities: activitiesForTurns(range.activities, turns),
      };
    }));

  // A snapshot enumerates all currently active work. Retain only historical
  // terminal activity outside its opening ranges, then let equal/newer incoming
  // revisions refresh timing baselines and lifecycle state.
  const activities = new Map(current.activities
    .filter((activity) => activity.state !== 'active')
    .map((activity) => [activity.activityId, activity]));
  for (const activity of incoming.activities) {
    const existing = activities.get(activity.activityId);
    if (!existing || existing.revision <= activity.revision) {
      activities.set(activity.activityId, activity);
    }
  }
  const mergedActivities = [...activities.values()];

  return {
    ...incoming,
    ranges: [...retainedRanges, ...incoming.ranges],
    activities: mergedActivities,
    activeActivities: mergedActivities.filter((activity) => activity.state === 'active'),
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
  timingAccuracy: 'observed' | 'upper_bound';
} {
  if (!activity) return { durationMs: 0, timingAccuracy: 'observed' };
  const timingAccuracy = activity.intervals.some((interval) => interval.timingAccuracy === 'upper_bound')
    ? 'upper_bound' as const
    : 'observed' as const;
  const active = activity.intervals.find((interval) => interval.stoppedAtUtc === null);
  if (!active) return { durationMs: activityDuration(activity), timingAccuracy };
  const elapsedMsAtSnapshot = active.elapsedMsAtSnapshot ?? 0;
  const cached = activityReceiptMonotonic.get(activity);
  const receivedAt = cached
    && cached.intervalId === active.intervalId
    && cached.revision === active.revision
    && cached.elapsedMsAtSnapshot === elapsedMsAtSnapshot
    ? cached.receivedAt
    : performance.now();
  activityReceiptMonotonic.set(activity, {
    intervalId: active.intervalId,
    revision: active.revision,
    elapsedMsAtSnapshot,
    receivedAt,
  });
  return {
    durationMs: activityDuration(activity),
    monotonicStartedAt: receivedAt,
    timingAccuracy,
  };
}
