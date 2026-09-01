import type { ElicitationData, Message, PluginActivityData, ToolEventData, WorkspaceMember } from './types';
import { pluginGroup } from './plugin-groups';
import {
  AutomationDraftProposedV1Schema,
  AutomationPrincipalUnavailableV1Schema,
  ElicitationSchema,
  type TranscriptActivity,
  type PendingTranscriptInput,
  type TranscriptPluginRun,
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
  | { type: 'elicitation'; elicitationId: string };

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
  /**
   * Promotion order among pending loop inputs. Socket room sequence is not
   * FIFO, so the composer queue sorts on this instead of `position`.
   * Optimistic sending rows omit it and sort last.
   */
  queueSequence?: number;
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
  // The server's own answer, when it gives one. `pluginRuns` states which
  // plugin ran in which turn, for how long, and which calls it made, so a row
  // built from it needs none of the joins above — which is the point: every one
  // of those joins could miss, and when one did the row claimed `0ms` rather
  // than admitting it could not see the timing.
  //
  // Empty means the API predates the field, not that no plugin ran, so the
  // activity-tree derivation below stays as the fallback until every deployed
  // API reports runs.
  const resolvedPluginRuns = resolvePluginRuns(snapshot);
  const pluginRunByToolCallId = new Map<string, TranscriptPluginRun>();
  for (const run of resolvedPluginRuns) {
    for (const toolCallId of run.toolCallIds) pluginRunByToolCallId.set(toolCallId, run);
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
      // Older Workers may have projected a Suggested context block before the
      // feature was retired. It is no longer part of the feed.
      .filter((block) => !(block.type === 'text' && block.messageType === 'suggestion'))
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
          const statusKind = structured['kind'] === 'assistant_turn_failed'
            || structured['kind'] === 'assistant_turn_stopped'
            ? structured['kind']
            : null;
          const statusCode = typeof structured['code'] === 'string'
            ? structured['code']
            : 'assistant_turn_interrupted';
          const messageType: Message['messageType'] = statusKind
            ? 'system'
            // `automation_activation` is carried through rather than folded
            // into 'text'. Folding it made every automation result render as
            // the clamped system note — the outcome conversation-surfaces.md
            // records as considered and rejected — while the block tests
            // passed, because they build the Message this mapping produces
            // rather than going through it.
            : block.messageType === 'elicitation'
              || block.messageType === 'system'
              || block.messageType === 'automation_activation'
              ? block.messageType
              : 'text';
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
            ...principalUnavailableFields(structured),
            ...draftProposedFields(structured),
            ...(elicitation.success ? { elicitation: normalizeElicitation(elicitation.data) } : {}),
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
        // The run names the plugin when the server reported one, which is the
        // whole point: the map below is the nullable-`turn.activityId` join
        // this contract exists to stop depending on, and in the production
        // shape it returns nothing. Without a name here a `connection:` block
        // resolves to no group at all and its row is dropped rather than
        // folded, so this is what puts a connector back in the feed.
        const run = pluginRunByToolCallId.get(block.toolCallId);
        const owner = block.pluginId
          ? pluginActivitiesByTurnActivity.get(`${turn.activityId ?? ''}\u0000${block.pluginId}`)
          : undefined;
        const pluginName = run?.displayName ?? owner?.label;
        rememberOrder(block.blockId);
        return {
          ...base,
          authorType: 'agent',
          messageType: 'tool_event',
          toolEvent: {
            id: block.toolCallId,
            toolCallId: block.toolCallId,
            ...(block.pluginId ? { pluginId: block.pluginId } : {}),
            ...(pluginName === undefined ? {} : { pluginName }),
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
  for (const run of resolvedPluginRuns) {
    const lastTurn = turnsById.get(run.turnId);
    if (!lastTurn) continue;
    // Position the row at the plugin's last call in the turn. `toolCallIds` is
    // the precise answer and is preferred, but a run resolved from an activity
    // tree that carries no `tool_call` activities has none — so the plugin's
    // own id is the fallback, which is what positioning used before runs
    // existed. Without it such a row has nowhere to sit and is dropped.
    const calls = new Set(run.toolCallIds);
    const anchored = Math.max(...lastTurn.blocks.flatMap((block) => block.type === 'tool'
      && (calls.size > 0 ? calls.has(block.toolCallId) : block.pluginId === run.pluginId)
      ? [block.blockIndex]
      : []));
    // A run the authority reported is work that happened, so it gets a row even
    // when nothing in the turn anchors it — the blocks may not have streamed in
    // yet, or the turn may be an omitted-blocks placeholder. Anchoring decides
    // *where* the row sits, not whether it exists, and an unanchored one goes
    // last in its turn, which is where the response's own total already sits.
    const lastToolIndex = Number.isFinite(anchored)
      ? anchored
      : Math.max(-1, ...lastTurn.blocks.map((block) => block.blockIndex)) + 1;
    const group = pluginGroup(run.pluginId, run.displayName);
    if (!group) continue;
    const timing = pluginRunTiming(run);
    messages.push({
      id: run.pluginRunId,
      transcriptTurnId: lastTurn.turnId,
      transcriptSequence: lastTurn.transcriptSequence,
      workstreamId,
      sequenceNumber: 0,
      attentionSequenceNumber: null,
      authorType: 'agent',
      messageType: 'plugin_activity',
      createdAt: lastTurn.createdAtUtc,
      pluginActivity: {
        groupKey: group.key,
        name: group.name,
        icon: group.icon,
        activeVerb: group.activeVerb,
        completedVerb: group.completedVerb,
        active: run.state === 'active',
        durationMs: run.durationMs,
        timingAccuracy: run.timingAccuracy,
        ...(timing.monotonicStartedAt === undefined
          ? {}
          : { monotonicStartedAt: [timing.monotonicStartedAt] }),
      },
    });
    messageOrder.set(run.pluginRunId, {
      turnSequence: lastTurn.transcriptSequence,
      position: lastToolIndex * 2 + 1,
      tieBreaker: run.pluginRunId,
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
    return false;
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
    queueSequence: input.inputSequence,
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

/**
 * The pending-input id a composer-queue row can send on reorder, or undefined
 * when the overlay is still an optimistic send with no server identity.
 */
export function pendingOverlayInputId(overlay: TranscriptOverlay): string | undefined {
  if (overlay.identity.type === 'loop_input') return overlay.identity.inputId;
  if (overlay.identity.type === 'client_message' && overlay.identity.turnId) {
    return overlay.identity.turnId;
  }
  return undefined;
}

/**
 * Pending loop inputs, plus an in-flight send while the harness is running.
 * Those rows live on the composer, not in the transcript.
 */
export function isComposerQueueOverlay(
  overlay: TranscriptOverlay,
  options: { harnessRunning: boolean },
): boolean {
  const state = overlay.message.deliveryState;
  if (state === 'steer_pending' || state === 'queue_pending') return true;
  return options.harnessRunning && state === 'sending';
}

/** Visible composer-queue rows in promotion order; sending rows without a sequence sit last. */
export function composerQueueOverlays(
  overlays: readonly TranscriptOverlay[] | undefined,
  options: { harnessRunning: boolean },
): TranscriptOverlay[] {
  return (overlays ?? [])
    .filter((overlay) => isComposerQueueOverlay(overlay, options))
    .sort((left, right) => {
      const leftSequence = left.queueSequence;
      const rightSequence = right.queueSequence;
      if (leftSequence === undefined && rightSequence === undefined) {
        return left.message.id < right.message.id ? -1 : left.message.id > right.message.id ? 1 : 0;
      }
      if (leftSequence === undefined) return 1;
      if (rightSequence === undefined) return -1;
      return leftSequence - rightSequence
        || (left.message.id < right.message.id ? -1 : left.message.id > right.message.id ? 1 : 0);
    });
}

/**
 * Optimistically permute `queueSequence` among named pending overlays.
 * Unnamed visible ids keep their relative order behind the named ones —
 * the same merge the object applies, so a concurrent admission is not lost.
 */
export function applyPendingInputQueueOrder(
  overlays: readonly TranscriptOverlay[] | undefined,
  orderedInputIds: readonly string[],
): TranscriptOverlay[] {
  const current = overlays ?? [];
  const draggable = current.filter((overlay) => pendingOverlayInputId(overlay) !== undefined);
  const byId = new Map(draggable.map((overlay) => [pendingOverlayInputId(overlay)!, overlay]));
  const named = orderedInputIds.flatMap((inputId) => {
    const overlay = byId.get(inputId);
    return overlay ? [overlay] : [];
  });
  const namedIds = new Set(named.map((overlay) => pendingOverlayInputId(overlay)!));
  const unnamed = draggable.filter((overlay) => !namedIds.has(pendingOverlayInputId(overlay)!));
  const ordered = [...named, ...unnamed];
  const sequences = draggable
    .map((overlay) => overlay.queueSequence)
    .filter((sequence): sequence is number => typeof sequence === 'number')
    .sort((left, right) => left - right);
  const nextSequence = new Map(ordered.flatMap((overlay, index) => {
    const inputId = pendingOverlayInputId(overlay);
    const sequence = sequences[index];
    return inputId !== undefined && sequence !== undefined
      ? [[inputId, sequence] as const]
      : [];
  }));
  return current.map((overlay) => {
    const inputId = pendingOverlayInputId(overlay);
    if (inputId === undefined) return overlay;
    const sequence = nextSequence.get(inputId);
    return sequence === undefined || sequence === overlay.queueSequence
      ? overlay
      : { ...overlay, queueSequence: sequence };
  });
}

/** Replace local queue sequences with the object's current pending-input order. */
export function assignPendingInputQueueSequences(
  overlays: readonly TranscriptOverlay[] | undefined,
  pendingInputs: readonly Pick<PendingTranscriptInput, 'inputId' | 'inputSequence'>[],
): TranscriptOverlay[] {
  const byInputId = new Map(pendingInputs.map((input) => [input.inputId, input.inputSequence]));
  return (overlays ?? []).map((overlay) => {
    const inputId = pendingOverlayInputId(overlay);
    if (inputId === undefined) return overlay;
    const sequence = byInputId.get(inputId);
    return sequence === undefined || sequence === overlay.queueSequence
      ? overlay
      : { ...overlay, queueSequence: sequence };
  });
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
      activeVerb: group.activeVerb,
      completedVerb: group.completedVerb,
      active: tool.status === 'started',
      // Undefined here is an unknown duration, not a zero one: the row carries
      // a time only when its tool-call activity reached the snapshot.
      durationMs: tool.durationMs ?? null,
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
    identity: Pick<PluginActivityData, 'activeVerb' | 'completedVerb' | 'groupKey' | 'icon' | 'name'>;
    active: boolean;
    activityDurationMs: number;
    toolDurationMs: number;
    /** Cleared by any contribution whose own duration is unknown. */
    activityDurationKnown: boolean;
    toolDurationKnown: boolean;
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
      const { activeVerb, completedVerb, groupKey, icon, name } = contribution.activity;
      group = {
        row: rows.length,
        identity: { activeVerb, completedVerb, groupKey, icon, name },
        active: false,
        activityDurationMs: 0,
        toolDurationMs: 0,
        activityDurationKnown: true,
        toolDurationKnown: true,
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
        // A group row stands for machinery, not for something a person read, so
        // it carries no attention ordinal — the same reason the projected
        // plugin-activity row above sets this null. The tool row it is built
        // from carries its *turn's* ordinal, which is also the ordinal of that
        // turn's text, so spreading it would let a group scrolling into view
        // acknowledge an answer still below the fold.
        attentionSequenceNumber: null,
        // The tool call and its own thinking row are what this replaces;
        // nothing downstream should read them back off the group.
        toolEvent: undefined,
        thoughtEvent: undefined,
      });
    }
    group.active ||= contribution.activity.active;
    // One unknown piece makes the whole total unknowable rather than smaller:
    // adding up only the parts that reported would understate the work by
    // exactly the part that did not, and present the result as certain.
    if (contribution.authoritativeDuration) {
      group.sawActivity = true;
      if (contribution.activity.durationMs === null) group.activityDurationKnown = false;
      else group.activityDurationMs += contribution.activity.durationMs;
    } else if (contribution.activity.durationMs === null) {
      group.toolDurationKnown = false;
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
        durationMs: group.sawActivity
          ? group.activityDurationKnown ? group.activityDurationMs : null
          : group.toolDurationKnown ? group.toolDurationMs : null,
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
      pluginRuns: [],
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
  // Runs come with the range for the same reason activities do: the turns it
  // brings in were never covered by the opening snapshot, so their timing has
  // to arrive with them or those rows have nothing to render from.
  const pluginRuns = new Map(snapshot.pluginRuns.map((run) => [run.pluginRunId, run]));
  for (const run of range.pluginRuns) pluginRuns.set(run.pluginRunId, run);
  return {
    ...snapshot,
    ranges: [...snapshot.ranges, range],
    activities: mergedActivities,
    activeActivities: mergedActivities.filter((activity) => activity.state === 'active'),
    pluginRuns: [...pluginRuns.values()],
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
      const retainedTurnIds = new Set(turns.map((turn) => turn.turnId));
      return {
        purpose: 'requested' as const,
        requested: covered,
        covered,
        turns,
        activities: activitiesForTurns(range.activities, turns),
        // The turns survive the reconcile, so their timing has to survive with
        // them. Dropping the runs here would blank the duration on every row
        // above the incoming snapshot's coverage the first time one arrived.
        pluginRuns: range.pluginRuns.filter((run) => retainedTurnIds.has(run.turnId)),
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
  // Same rule for the snapshot-level list: the incoming snapshot is
  // authoritative for the turns it covers, and the runs it does not cover are
  // the ones the retained ranges still need.
  const pluginRuns = new Map(retainedRanges.flatMap((range) =>
    range.pluginRuns.map((run) => [run.pluginRunId, run] as const)));
  for (const run of incoming.pluginRuns) pluginRuns.set(run.pluginRunId, run);

  return {
    ...incoming,
    ranges: [...retainedRanges, ...incoming.ranges],
    activities: mergedActivities,
    activeActivities: mergedActivities.filter((activity) => activity.state === 'active'),
    pluginRuns: [...pluginRuns.values()],
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

/**
 * The plugin runs the activity tree can account for.
 *
 * The server's `pluginRuns` is resolved once, when a snapshot is taken. The
 * activity tree, by contrast, is kept current by realtime: a plugin that
 * completes mid-run arrives as `transcript_activity_upserted` and lands in
 * `activities`. So where the tree *can* account for a run, it is the fresher of
 * the two, and a row built only from the snapshot's copy would tick forever
 * because its `state` never leaves `active`.
 *
 * Where the tree cannot account for one — the parent chain that names the turn
 * is exactly what the nullable seeds fail to deliver — this returns nothing for
 * it and the snapshot's own run stands. That is the case this whole contract
 * exists for, and the two sources compose rather than competing:
 * `resolvePluginRuns` overlays what the tree knows onto what the server said.
 */
function pluginRunsFromActivities(
  activities: readonly TranscriptActivity[],
): Map<string, TranscriptPluginRun> {
  const byId = new Map(activities.map((activity) => [activity.activityId, activity]));
  const callsByPlugin = new Map<string, string[]>();
  for (const activity of activities) {
    if (activity.scope !== 'tool_call' || !activity.parentActivityId) continue;
    const current = callsByPlugin.get(activity.parentActivityId) ?? [];
    current.push(activity.subjectId);
    callsByPlugin.set(activity.parentActivityId, current);
  }
  const runs = new Map<string, TranscriptPluginRun>();
  for (const activity of activities) {
    if (activity.scope !== 'plugin' || !activity.parentActivityId) continue;
    const parent = byId.get(activity.parentActivityId);
    if (parent?.scope !== 'assistant_turn') continue;
    let completedMs = 0;
    let elapsedMsAtSnapshot: number | null = null;
    // The same rule the server folds by: a stopped interval that recorded no
    // duration makes the total unknowable, not smaller.
    let durationKnown = activity.intervals.length > 0;
    let upperBound = false;
    for (const interval of activity.intervals) {
      if (interval.timingAccuracy === 'upper_bound') upperBound = true;
      if (interval.stoppedAtUtc === null) {
        elapsedMsAtSnapshot = (elapsedMsAtSnapshot ?? 0) + (interval.elapsedMsAtSnapshot ?? 0);
        continue;
      }
      if (interval.durationMs === null) durationKnown = false;
      else completedMs += interval.durationMs;
    }
    runs.set(activity.activityId, {
      pluginRunId: activity.activityId,
      turnId: parent.subjectId,
      pluginId: activity.subjectId,
      displayName: activity.label,
      state: activity.state,
      durationMs: durationKnown ? completedMs : null,
      elapsedMsAtSnapshot,
      timingAccuracy: upperBound ? 'upper_bound' : 'observed',
      toolCallIds: callsByPlugin.get(activity.activityId) ?? [],
    });
  }
  return runs;
}

/**
 * One list of runs from the two sources, newest fact winning per field.
 *
 * The snapshot's run is the base, because it is the one that exists even when
 * the tree cannot reach the activity. The tree's view is overlaid on top when
 * it has one, because realtime keeps it current. `toolCallIds` is the exception
 * to "newest wins": an empty list there is the tree failing to see the calls
 * rather than the plugin having made none, and an empty list leaves the row
 * with nowhere to sit.
 */
function resolvePluginRuns(snapshot: WorkstreamTranscriptSnapshot): TranscriptPluginRun[] {
  const derived = pluginRunsFromActivities(snapshot.activities);
  const resolved = snapshot.pluginRuns.map((run) => {
    const fresh = derived.get(run.pluginRunId);
    derived.delete(run.pluginRunId);
    if (!fresh) return run;
    return {
      ...run,
      ...fresh,
      toolCallIds: fresh.toolCallIds.length > 0 ? fresh.toolCallIds : run.toolCallIds,
    };
  });
  // A plugin that started after the snapshot was taken has no server run yet.
  return [...resolved, ...derived.values()];
}

/**
 * The local monotonic anchor a still-running plugin row ticks from.
 *
 * The server reports how long the run has been going as of the snapshot, never
 * a wall-clock start: the two clocks are not the same one, and subtracting a
 * server timestamp from a local `Date.now()` reports the skew between them as
 * work. So the client stamps `performance.now()` the first time it sees a given
 * elapsed reading and counts forward from there, re-stamping only when the
 * server sends a new one.
 */
const pluginRunReceiptMonotonic = new WeakMap<TranscriptPluginRun, number>();

function pluginRunTiming(run: TranscriptPluginRun): { monotonicStartedAt?: number } {
  if (run.state !== 'active' || run.elapsedMsAtSnapshot === null) return {};
  // Keyed on the run object, like `activityReceiptMonotonic` beside it: a new
  // snapshot brings a new object and re-stamps, and an entry is collected with
  // the snapshot that produced it rather than outliving the work stream.
  const cached = pluginRunReceiptMonotonic.get(run);
  // The reading was already `elapsedMsAtSnapshot` old when it was taken, so the
  // segment began that far before this moment.
  const receivedAt = cached ?? performance.now() - run.elapsedMsAtSnapshot;
  pluginRunReceiptMonotonic.set(run, receivedAt);
  return { monotonicStartedAt: receivedAt };
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

/**
 * Move a finished response's total onto the message it produced.
 *
 * A response-level timer is progress while it runs, so it stays a row of its
 * own and the reader watches it climb. The moment it settles it is no longer
 * progress — it is a fact about the answer above it — and a spent timer parked
 * under that answer reads like another step still to come. Folding it into the
 * header puts it where the rest of the message's provenance already is:
 * "Rally · 11 minutes ago · Worked for 2m 52s".
 *
 * Only the response scope moves. A turn's thinking row stays where it is: it
 * annotates one step inside the run rather than summarizing the whole of it,
 * and several of them can belong to a single message.
 */
export function foldSettledWorkIntoMessages(messages: readonly Message[]): Message[] {
  const rows: Message[] = [];
  for (const message of messages) {
    const thought = message.thoughtEvent;
    const settledResponseWork = thought !== undefined
      && message.messageType === 'thought'
      && thought.status !== 'started'
      // 'thinking' is a turn's own reasoning; 'working' is the whole response.
      && (thought.activeVerb ?? 'working') === 'working';
    if (!settledResponseWork) {
      rows.push(message);
      continue;
    }
    // The answer this total belongs to is the nearest agent text above it from
    // the same turn. `findLastIndex` would say it more directly, but the
    // renderer's lib target predates it.
    let host = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index]!;
      if (candidate.authorType === 'agent'
        && candidate.messageType === 'text'
        && candidate.transcriptTurnId === message.transcriptTurnId) {
        host = index;
        break;
      }
    }
    if (host === -1) {
      // Nothing to attach to — an answer that was omitted or has not arrived.
      // The row stays rather than taking the timing out of the feed entirely.
      rows.push(message);
      continue;
    }
    rows[host] = {
      ...rows[host]!,
      workSummary: {
        durationMs: thought.durationMs,
        ...(thought.timingAccuracy === undefined ? {} : { timingAccuracy: thought.timingAccuracy }),
      },
    };
  }
  return rows.map((message, index) => ({ ...message, sequenceNumber: index + 1 }));
}

/**
 * The automation-principal card's fields, or nothing.
 *
 * Parsed rather than trusted: this row is written by the server, but a client
 * that rendered a half-formed card would show an action leading nowhere, and
 * the row is one the room is being asked to act on.
 */
function principalUnavailableFields(
  structured: Record<string, unknown>,
): Pick<Message, 'principalUnavailable'> | Record<string, never> {
  if (structured['type'] !== 'automation_principal_unavailable') return {};
  const parsed = AutomationPrincipalUnavailableV1Schema.safeParse(structured);
  if (!parsed.success) return {};
  return {
    principalUnavailable: {
      automationId: parsed.data.automationId,
      automationName: parsed.data.automationName,
      outgoingUserName: parsed.data.outgoingUserName,
      unreachableProviders: parsed.data.unreachableProviders,
    },
  };
}

/**
 * The proposal card's fields, or nothing.
 *
 * Parsed rather than trusted, for the same reason the principal card is: a
 * half-formed card would offer an accept leading nowhere, and this row is one
 * the room is being asked to act on.
 */
function draftProposedFields(
  structured: Record<string, unknown>,
): Pick<Message, 'draftProposed'> | Record<string, never> {
  if (structured['type'] !== 'automation_draft_proposed') return {};
  const parsed = AutomationDraftProposedV1Schema.safeParse(structured);
  if (!parsed.success) return {};
  return {
    draftProposed: {
      automationId: parsed.data.automationId,
      automationName: parsed.data.automationName,
      description: parsed.data.description,
      triggerSummaries: [...parsed.data.triggerSummaries],
      suggestedScope: parsed.data.suggestedScope,
      ready: parsed.data.ready,
    },
  };
}
