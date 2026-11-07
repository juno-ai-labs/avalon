import { ImportedMessageProvenanceSchema } from "@rally/contracts";
import { visibleParticipantText } from "@rally/contracts/text";
import { personMentionMarkdownRanges } from '@rally/contracts/citations';
import { prepareMentionMarkdown } from '@rally/contracts/message-mentions';
import type { MentionIdentity } from './api';
import { resolveMentionPayload } from './mention-draft';
import { connectorConnectionCardDisplayInputFromToolEvent } from './connector-connection-card';
import type { ElicitationData, Message, MessageMention, PluginActivityData, ThoughtEventData, ToolEventData, WorkSpan, WorkTotal, WorkspaceMember } from './types';
import {
  AGENT_MESSAGES_INBOUND_GROUP,
  AGENT_MESSAGES_OUTBOUND_GROUP,
  AGENT_WORKERS_FINISHED_GROUP,
  AGENT_WORKERS_STARTED_GROUP,
  agentWorkersFailedGroup,
  countedGroup,
  pluginGroup,
  type PluginGroup,
} from './plugin-groups';
import {
  AutomationActivationV1Schema,
  AutomationDraftProposedV1Schema,
  ElicitationSchema,
  agentMessageNotice,
  agentMessageNoticeReason,
  connectorResourceAuthorizationRequestFromToolEvent,
  isAgentMessageContent,
  isAgentMessageSendWireName,
  isAgentStartWireName,
  isConnectorConnectionCardWireName,
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
  state: { status: 'open' | 'answered' | 'cancelled'; answer: string | string[] | null },
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
  substreamId = '0',
): readonly ['transcript-overlays', string]
  | readonly ['substream-transcript-overlays', string, string] {
  return substreamId === '0'
    ? ['transcript-overlays', workstreamId]
    : ['substream-transcript-overlays', workstreamId, substreamId];
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

/** What the rewrite reads of a selection: the identity and the span it replaces. */
type MentionSpan = Pick<MentionIdentity, 'type' | 'userId' | 'connectorType' | 'startOffset' | 'endOffset'> & Partial<Pick<MentionIdentity, 'label'>>;

/**
 * The text and mentions an optimistic turn has to carry to render as the turn
 * the room is about to store.
 *
 * A mention chip is drawn from the message's *text*: a person mention is
 * `[@Name](person://<id>)` Markdown, and `renderIdentity` resolves that href
 * against `mentions` to find the name and avatar. The composer holds neither —
 * it holds the plain `@Name` the person typed and the identities they picked
 * from the popover — so an optimistic turn built straight from the draft
 * renders plain text and becomes a chip only when the canonical turn lands,
 * widening the bubble at exactly the moment an in-flight row exists to make
 * uneventful.
 *
 * `prepareMentionMarkdown` is the room's own rewrite, shared out of
 * `@rally/contracts` rather than reimplemented here, so the two sides cannot
 * disagree about escaping, overlapping selections, ordering, or which
 * selections are dropped for no longer matching their visible text. What it
 * returns is the stored text, byte for byte, for every mention it accepts; a
 * selection it drops stays the plain text the room will also keep.
 *
 * The text is for rendering only — what is *sent* is the draft the person
 * typed, and the room rewrites it there. A selection with no offsets is
 * dropped: the offsets are the span the rewrite replaces, and a wrong pair
 * would rewrite the wrong words.
 */
export function optimisticMentionRendering(
  text: string,
  selected: readonly MentionSpan[],
  members: readonly WorkspaceMember[],
): { text: string; mentions: MessageMention[] } {
  const prepared = prepareDraftMentions(text, selected, members);
  return {
    text: prepared.text,
    mentions: prepared.mentions.map((mention) => ({
      type: mention.type,
      ...(mention.userId ? { personId: mention.userId } : {}),
      ...(mention.connectorType ? { connectorType: mention.connectorType } : {}),
      ...(mention.displayName ? { displayName: mention.displayName } : {}),
      ...(mention.avatarUrl ? { avatarUrl: mention.avatarUrl } : {}),
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
    })),
  };
}

/**
 * The room's rewrite of a draft and its popover selections, in the wire shape
 * a transcript block stores. `optimisticMentionRendering` reads it into a
 * `Message`; a launcher seeding a transcript cache keeps it as is.
 */
export function prepareDraftMentions(
  text: string,
  selected: readonly MentionSpan[],
  members: readonly WorkspaceMember[],
): ReturnType<typeof prepareMentionMarkdown> {
  const offsetSelections = selected.flatMap((mention) =>
    // A Sidekick selection is Markdown before it gets here (`sidekickMentionsAsMarkdown`).
    mention.type === 'sidekick' || mention.startOffset === undefined || mention.endOffset === undefined ? [] : [{
      type: mention.type,
      userId: mention.userId,
      connectorType: mention.connectorType,
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
    }]);
  if (offsetSelections.length === 0) return { text, mentions: [] };
  const people = new Map(members.map((member) => [member.id, {
    id: member.id,
    name: member.name,
    avatarUrl: member.avatarUrl ?? null,
  }]));
  return prepareMentionMarkdown(text, offsetSelections, people);
}

/**
 * Text the app kept without its mentions, such as a thread's description,
 * rendered the way a message is. A name already in durable
 * `[@Name](person://<id>)` form keeps that identity: the description loop
 * (`workstream-description-service.ts`) rewrites from transcript text, which
 * carries those links. Each typed `@Name` outside them that the send path
 * would resolve becomes one too. A person who is not a member here stays as
 * written.
 */
export function typedMentionRendering(
  text: string,
  members: readonly WorkspaceMember[],
): { text: string; mentions: MessageMention[] } {
  if (!text.includes('@') || members.length === 0) return { text, mentions: [] };
  // A link's own `[@Name` label reads as a typed name too; rewriting it again
  // would nest one link inside another.
  const linked = text.includes('person:') ? personMentionMarkdownRanges(text) : [];
  const discovered = members
    .filter((member) => (member.status ?? 'active') === 'active')
    .map((member) => ({ type: 'person' as const, label: member.name, userId: member.id, connectorType: null }));
  const typed = resolveMentionPayload(text, [], discovered).filter((mention) => !linked.some((range) => (
    mention.startOffset < range.endOffset && range.startOffset < mention.endOffset
  )));
  const rendered = typed.length > 0 ? optimisticMentionRendering(text, typed, members).text : text;
  const byId = new Map(members.map((member) => [member.id.toLowerCase(), member]));
  return {
    text: rendered,
    mentions: personMentionMarkdownRanges(rendered).flatMap((range) => {
      const member = byId.get(range.personId);
      return member ? [{
        type: 'person' as const,
        personId: range.personId,
        displayName: member.name,
        ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
        startOffset: range.startOffset,
        endOffset: range.endOffset,
      }] : [];
    }),
  };
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
  // The turns that open a stretch of transcript after one this client has not
  // loaded. A snapshot's coverage is not one interval — the opening one
  // commonly holds an unread island and a separate latest island — and the
  // flatten above puts both in one list with nothing between them. Marking the
  // seam is what stops a pass over adjacent rows from joining work across turns
  // nobody has seen. Computed from the snapshot's own coverage rather than from
  // a jump in `transcriptSequence`, which cannot tell a hidden turn from a
  // sequence the transcript never assigned.
  const gaps = transcriptGaps(snapshot);
  const gapLeadingTurnIds = new Set<string>();
  for (let index = 1; index < orderedTurns.length; index += 1) {
    const previous = orderedTurns[index - 1]!.transcriptSequence;
    const current = orderedTurns[index]!.transcriptSequence;
    const hidden = gaps.some((gap) =>
      gap.startInclusive < current && gap.endExclusive > previous + 1);
    if (hidden) gapLeadingTurnIds.add(orderedTurns[index]!.turnId);
  }
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
      .map((block, blockPosition): Message => {
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
          // Only the turn's first row carries the seam. Repeating it would
          // close the run again between this turn's own blocks, which are
          // contiguous by definition.
          ...(blockPosition === 0 && gapLeadingTurnIds.has(turn.turnId)
            ? { precededByTranscriptGap: true }
            : {}),
          createdAt: turn.createdAtUtc,
        };
        if (block.type === 'text') {
          const structured = block.structuredContent ?? {};
          // A teammate's message is machinery, not a note to the room. It is
          // prose one agent wrote for another — sender identity, a message id
          // to reply to, findings mid-investigation — and the feed used to
          // print it as a clamped system bullet between the tool rows, which
          // put an unaddressed wall of text in front of a reader who was never
          // its audience. As a counted row it sits with the work it belongs to
          // and folds away behind the answer that reports on it, exactly as a
          // plugin's calls do. It also stops closing the plugin run around it,
          // which is the same judgement: a message arriving is not something a
          // person read.
          const opening = opensConversationWithAgentMessage(structured, turn.transcriptSequence === 1);
          const agentMessage = opening ? null : agentMessageActivity(structured);
          if (agentMessage) {
            rememberOrder(block.blockId);
            return {
              ...base,
              id: block.blockId,
              // The turn is the host's, appended on the sender's behalf, so its
              // actor is `system`. The row is Rally's own machinery and takes
              // the author every other work row has; `feedRowKind` already
              // routes on the type, and this keeps the two answers agreeing.
              authorType: 'agent',
              messageType: 'plugin_activity',
              // `base` keeps the turn's attention ordinal, and that is
              // deliberate — this row is NOT the plugin-group case. A grouped
              // plugin row carries no ordinal because the tool turns behind it
              // never had one; an admitted agent message is a non-tool turn, so
              // the server allocates it one and the room's unread waterline
              // moves with it. Nulling it here left no row carrying that
              // ordinal at all, so `highestVisibleAttentionSequence` could
              // never observe it and the unread dot could not be cleared by
              // reading — only by sending. The row is also the whole of what
              // there is to read for this turn, so acknowledging it on scroll
              // is honest in a way acknowledging a tool row is not.
              pluginActivity: agentMessage,
            };
          }
          const imported = ImportedMessageProvenanceSchema.safeParse(structured);
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
          const messageType: Message['messageType'] = opening
            ? 'text'
            : statusKind
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
            ...(opening ? { authorType: 'agent' as const, contextLabel: OPENING_AGENT_MESSAGE_LABEL } : {}),
            id: messageId,
            messageType,
            annotationContent: block.structuredContent ?? undefined,
            text: visibleBlockText(block.text, turn.actor, block.structuredContent),
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
            ...(imported.success ? { importProvenance: imported.data } : {}),
            ...draftProposedFields(structured),
            ...automationActivationFields(structured),
            ...(elicitation.success ? { elicitation: normalizeElicitation(elicitation.data) } : {}),
          };
        }
        if (block.type === 'thinking') {
          rememberOrder(block.blockId);
          const activity = activities.get(block.activityId);
          const timing = activityTiming(activity);
          const spans = activityWorkSpans(activity);
          return {
            ...base,
            authorType: 'agent',
            messageType: 'thought',
            ...(spans === undefined ? {} : { workSpans: spans }),
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
        const toolSpans = activityWorkSpans(activity);
        return {
          ...base,
          authorType: 'agent',
          messageType: 'tool_event',
          ...(toolSpans === undefined ? {} : { workSpans: toolSpans }),
          toolEvent: {
            id: block.toolCallId,
            toolCallId: block.toolCallId,
            ...(block.pluginId ? { pluginId: block.pluginId } : {}),
            ...(pluginName === undefined ? {} : { pluginName }),
            ...((run?.connectorType ?? owner?.connectorType) ? { connectorType: run?.connectorType ?? owner?.connectorType } : {}),
            name: block.toolName,
            wireName: block.toolName,
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
      ...(gapLeadingTurnIds.has(turn.turnId) ? { precededByTranscriptGap: true } : {}),
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
    // A run whose every call now has a counted row of its own has nothing left
    // to aggregate, and printing it anyway puts the exact row this change
    // removes — "Used Background agents for 1s" — back beside the row that
    // replaced it. The server reports the run for the whole plugin; rerouting
    // the blocks alone left it behind, because it is keyed on the plugin id
    // rather than on the calls.
    //
    // A run with calls left keeps its row: it is the plugin's own stretch, gaps
    // and all, which is what a plugin row has always reported, and it remains
    // true that Rally worked there. It does then carry the rerouted calls'
    // share of the time, which is not separable — the server times the plugin,
    // not the calls — and is the same approximation every plugin row makes.
    //
    // A run with no `toolCallIds` cannot answer the question, and a run whose
    // blocks have not all arrived can answer it only for the ones that have.
    // Both keep the row: dropping one on an unknown would take a real row out
    // of the feed, which is the worse of the two failures.
    const runBlocks = lastTurn.blocks.filter((block) => block.type === 'tool' && calls.has(block.toolCallId));
    if (calls.size > 0
      && runBlocks.length === calls.size
      && runBlocks.every((block) => block.type === 'tool'
        && countedGroupForToolCall(block.toolName, block.status) !== null)) {
      continue;
    }
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
    const group = pluginGroup(run.pluginId, run.displayName, run.connectorType);
    if (!group) continue;
    const timing = pluginRunTiming(run);
    // The run's own id is the plugin activity's, so the tree the snapshot
    // happens to carry answers *when* this run worked without another join.
    // The server states the duration either way; only the spans come from
    // here, and a run whose activity did not reach this snapshot simply has
    // none — see `activityWorkSpans`.
    const spans = activityWorkSpans(activities.get(run.pluginRunId));
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
      ...(spans === undefined ? {} : { workSpans: spans }),
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

/**
 * The answered question an admitted elicitation answer carries, if it is one.
 *
 * An answer is not a queued message. It is the only thing that closes the
 * question already on screen, and the canonical question turn carries the
 * status frozen at `open` — only the answer's own turn ever replaces it. Until
 * the loop promotes that turn the answer is a pending input, so a room that
 * projected it as ordinary text put a blank row on the composer queue and
 * showed the question still asking, which every fresh snapshot restored over
 * the reader's own answer.
 */
function pendingInputElicitation(
  block: PendingTranscriptInput['block'],
): ElicitationData | undefined {
  if (block.messageType !== 'elicitation' || !block.structuredContent) return undefined;
  const parsed = ElicitationSchema.safeParse(
    'elicitation' in block.structuredContent
      ? block.structuredContent['elicitation']
      : block.structuredContent,
  );
  return parsed.success ? normalizeElicitation(parsed.data) : undefined;
}

/** Project one server-owned, non-canonical loop input into presentation state. */
export function pendingTranscriptInputOverlay(
  input: PendingTranscriptInput,
  workstreamId: string,
  provenance: Extract<TranscriptOverlayProvenance, {
    source: 'socket_event' | 'socket_snapshot' | 'rest_snapshot';
  }>,
): TranscriptOverlay {
  const elicitation = pendingInputElicitation(input.block);
  // An agent message is machinery before it is promoted as much as after, and
  // `hydratePendingTranscriptInput` carries its structured content through, so
  // the same row is available here. It also keeps the message off the composer
  // queue: a queued row is something a person wrote and can reorder, and a
  // teammate's message is neither.
  //
  // The opener is the exception, drawn as it will be once promoted. Every input
  // admitted before the first turn lands is after sequence 0, so the loop's
  // first admission is what picks it out: inputs are numbered from 1 and
  // delivered in that order.
  const opening = opensConversationWithAgentMessage(
    input.block.structuredContent,
    input.afterTranscriptSequence === 0 && input.inputSequence === 1,
  );
  const agentMessage = opening ? null : agentMessageActivity(input.block.structuredContent);
  if (opening || agentMessage) {
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
        authorType: 'agent',
        ...(agentMessage
          ? { messageType: 'plugin_activity' as const, pluginActivity: agentMessage }
          : {
              messageType: 'text' as const,
              contextLabel: OPENING_AGENT_MESSAGE_LABEL,
              annotationContent: input.block.structuredContent ?? undefined,
      text: input.block.text,
              attachments: input.block.attachments?.map((attachment) => ({ ...attachment })),
            }),
        createdAt: input.admittedAtUtc,
      },
    };
  }
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
    ...(elicitation ? {} : { queueSequence: input.inputSequence }),
    message: {
      id: elicitation ? elicitationMessageId(elicitation.id) : input.futureTurnId,
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
      messageType: elicitation
        ? 'elicitation'
        : input.block.messageType === 'system' ? 'system' : 'text',
      ...(elicitation ? { elicitation } : {}),
      annotationContent: input.block.structuredContent ?? undefined,
      text: visibleBlockText(input.block.text, input.actor, input.block.structuredContent),
      mentions: input.block.mentions?.map((mention) => ({
        type: mention.type,
        ...(mention.userId ? { personId: mention.userId } : {}),
        ...(mention.connectorType ? { connectorType: mention.connectorType } : {}),
        startOffset: mention.startOffset,
        endOffset: mention.endOffset,
      })),
      attachments: input.block.attachments?.map((attachment) => ({ ...attachment })),
      createdAt: input.admittedAtUtc,
      ...(elicitation ? {} : {
        deliveryState: input.deliveryMode === 'steer' ? 'steer_pending' : 'queue_pending',
      }),
    },
  };
}

/**
 * The pending-input id a composer-queue row can send on reorder, or undefined
 * when the overlay is still an optimistic send with no server identity.
 */
export function pendingOverlayInputId(overlay: TranscriptOverlay): string | undefined {
  // An answer to a question is an admitted pending input as well, but it is
  // not a row anyone can reorder: counting it as one would shift the sequences
  // a reorder assigns onto the rows around it. The test is the message kind and
  // nothing wider — a send the room has just accepted is a queued row with a
  // server turn id and no queue sequence yet, and keying on the sequence took
  // its reorder id away for the whole window before the next snapshot.
  if (overlay.message.messageType === 'elicitation') return undefined;
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
 * Answer an already-loaded question in place, and take the overlay out.
 *
 * A question and its answer are one row: the canonical projection gives them
 * one message id and keeps the question's position. An answer still waiting to
 * be promoted has no canonical turn for that projection to fold, and
 * `transcriptOverlaysWithoutCanonicalMatch` does not drop it either — it
 * matches on identity, and this overlay is keyed by its own client message
 * while the canonical row is keyed by the question. Composed as it stood, both
 * were emitted: the question drawn twice, once open and once answered, under
 * one React key. Only the status and the answer move; everything positional
 * stays the question's, because that is the row the reader is looking at.
 */
function answeredElicitationCanonical(
  canonical: readonly Message[],
  overlays: readonly TranscriptOverlay[],
): { canonical: readonly Message[]; overlays: TranscriptOverlay[] } {
  const answers = new Map<string, TranscriptOverlay>();
  for (const overlay of overlays) {
    const elicitation = overlay.message.elicitation;
    if (overlay.message.messageType !== 'elicitation'
      || (elicitation?.status !== 'answered' && elicitation?.status !== 'cancelled')) continue;
    if (!canonical.some((message) => message.elicitation?.id === elicitation.id)) continue;
    answers.set(elicitation.id, overlay);
  }
  if (answers.size === 0) return { canonical, overlays: [...overlays] };
  const folded = new Set(answers.values());
  return {
    canonical: canonical.map((message) => {
      const answer = message.elicitation ? answers.get(message.elicitation.id) : undefined;
      return answer?.message.elicitation
        ? { ...message, elicitation: answer.message.elicitation }
        : message;
    }),
    overlays: overlays.filter((overlay) => !folded.has(overlay)),
  };
}

/**
 * Compose already-ordered canonical rows with explicitly sourced, non-durable
 * overlays. Canonical projection is the expensive side and is memoized by the
 * screen; sorting it again on every reveal tick would put the whole loaded
 * transcript on the display-rate path.
 */
export function composeTranscript(
  canonicalRows: readonly Message[],
  overlays: readonly TranscriptOverlay[],
): Message[] {
  const answered = answeredElicitationCanonical(
    canonicalRows,
    transcriptOverlaysWithoutCanonicalMatch(canonicalRows, overlays),
  );
  const canonical = answered.canonical;
  const live = answered.overlays;
  const activeAssistantTurns = new Set(live.flatMap((overlay) =>
    overlay.identity.type === 'assistant_turn' ? [overlay.identity.turnId] : []));
  let previousCanonicalSequence = 0;
  const visibleCanonical = canonical.filter((message) => {
    const transcriptSequence = message.transcriptSequence;
    if (typeof transcriptSequence !== 'number'
      || !Number.isSafeInteger(transcriptSequence)
      || transcriptSequence < 1
      || transcriptSequence < previousCanonicalSequence) {
      throw new Error('Rally received an invalid transcript order. Reopen this thread.');
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
 * A repeated presentation call beside the card it just presented is one
 * product control, not two transcript rows. Collapse only an uninterrupted run
 * of the same validated connector and scope. Keep the first row's stable id so
 * an existing message anchor still points at the surviving card.
 * Any intervening conversation row or transcript seam starts a new occasion.
 */
export function dedupeAdjacentConnectorConnectionCards(messages: readonly Message[]): Message[] {
  const rows: Message[] = [];
  for (const message of messages) {
    const card = connectorConnectionCardDisplayInputFromToolEvent(message.toolEvent);
    const previous = rows.at(-1);
    const previousCard = connectorConnectionCardDisplayInputFromToolEvent(previous?.toolEvent);
    if (card && previous && previousCard
      && message.precededByTranscriptGap !== true
      && card.connectorId === previousCard.connectorId
      && card.scope === previousCard.scope) {
      rows[rows.length - 1] = {
        ...message,
        id: previous.id,
        ...(previous.precededByTranscriptGap ? { precededByTranscriptGap: true } : {}),
        attentionSequenceNumber: message.attentionSequenceNumber
          ?? previous.attentionSequenceNumber,
      };
      continue;
    }
    rows.push(message);
  }
  return rows;
}

/**
 * What a run's opening row says when a message in its Sidekick's shared
 * conversation started it. The block itself is the prompt the run reads (the
 * sender named as data, the message, how to answer), written for the model;
 * the person reading the run already saw that message where they sent it.
 */
export const RUN_OPENED_BY_MESSAGE_CAPTION = 'Started by a message in the conversation.';

function visibleBlockText(
  text: string,
  actor: Parameters<typeof visibleParticipantText>[1],
  structured: Readonly<Record<string, unknown>> | null | undefined,
): string {
  return structured?.['kind'] === 'sidekick_conversation_message'
    ? RUN_OPENED_BY_MESSAGE_CAPTION
    : visibleParticipantText(text, actor);
}

/** The byline beside the agent message that opened a conversation. */
export const OPENING_AGENT_MESSAGE_LABEL = 'Opening instructions';

/**
 * Whether this block is the agent message that opened its conversation, which
 * is drawn as a message rather than counted. Callers say whether the block is
 * first, since the canonical and pending projections know it differently.
 */
function opensConversationWithAgentMessage(
  structuredContent: Readonly<Record<string, unknown>> | null | undefined,
  opensConversation: boolean,
): boolean {
  return opensConversation && isAgentMessageContent(structuredContent)
    && agentMessageNotice(structuredContent) === null;
}

/**
 * The counted row an agent message gets, or null when the block is not one.
 *
 * Shared by the canonical projection and the pending-input overlay. A message
 * reaches its recipient through the mailbox first and can sit there until the
 * next safe execution boundary, which for a busy recipient is a whole step —
 * so a projection that only the canonical path had left the raw agent-to-agent
 * prose on screen for exactly that window, then swapped it for a counted row
 * on promotion. One message drawn two contradictory ways depending on when it
 * was looked at, and the wall of prose this change exists to remove still
 * being drawn for the length of a step.
 */
function agentMessageActivity(
  structuredContent: Readonly<Record<string, unknown>> | null | undefined,
): PluginActivityData | null {
  if (!isAgentMessageContent(structuredContent)) return null;
  // The host writes two of these on a run's behalf, and they are not messages:
  // one says a worker failed, the other that it finished with nothing to say.
  // Counting them among a teammate's own messages would bury the only two ends
  // of a worker's life the transcript records.
  const notice = agentMessageNotice(structuredContent);
  const group = notice === 'failed'
    ? agentWorkersFailedGroup(agentMessageNoticeReason(structuredContent))
    : notice === 'finished_without_reply'
      ? AGENT_WORKERS_FINISHED_GROUP
      : AGENT_MESSAGES_INBOUND_GROUP;
  return countedActivity(group, false);
}

/**
 * The counted group a tool call belongs to instead of its plugin's row, or
 * null when it stays on that row.
 *
 * One function because two places ask the same question and must not answer it
 * differently: the contribution that builds the counted row, and the plugin
 * run that must not *also* print an aggregate for calls it no longer stands
 * for. Two copies of this test would disagree the first time a status rule
 * moved, and the symptom would be a duplicated row rather than a type error.
 *
 * It takes both status vocabularies — the projected one and the raw block's —
 * because the two callers hold different ones, and the rule is about the call
 * rather than about which of them is asking.
 *
 * A call that failed did not send a message or start a worker, so it is not
 * one of the things these rows count, and it falls back to the plugin row,
 * which says only that Rally reached for the plugin and is still true. That
 * matters beyond tidiness for a send: the host counts only completed and
 * ambiguous effects as a hand-off, so a run whose only send failed is told its
 * worker finished without replying — and a feed that had already claimed the
 * message was sent would be contradicting itself two rows later. `ambiguous`
 * counts, on the same authority: a write whose confirmation was lost most
 * likely landed.
 */
function countedGroupForToolCall(
  name: string | undefined,
  status: ToolEventData['status'] | 'planned' | 'cancelled',
): PluginGroup | null {
  if (status === 'failed' || status === 'cancelled') return null;
  if (isAgentMessageSendWireName(name)) return AGENT_MESSAGES_OUTBOUND_GROUP;
  if (isAgentStartWireName(name)) return AGENT_WORKERS_STARTED_GROUP;
  return null;
}

/**
 * One contribution to a counted group, before the run knows its total.
 *
 * The count is 1 and the duration is null on every one of them: the row this
 * becomes is phrased by `PluginGroup.countPhrase` from the sum, and prints no
 * time. `completedVerb` is the group's own singular, which is what the row
 * reads if it turns out to stand for exactly one contribution and nothing
 * overwrites it.
 */
function countedActivity(group: PluginGroup, active: boolean): PluginActivityData {
  return {
    groupKey: group.key,
    name: group.name,
    icon: group.icon,
    activeVerb: group.activeVerb,
    completedVerb: group.completedVerb,
    active,
    durationMs: null,
    count: 1,
  };
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
  // Ahead of the plugin lookup, because these calls belong to their own subject
  // rather than to the plugin that carries them: `avalon:agents` also owns
  // `list_agents`, `stop_agent`, `sidekicks_list` and `create_sidekick`, which
  // really are the reader using a plugin and keep the Background agents row.
  // Folding all seven together is what produced "Used Background agents for 1s"
  // over a second that contained two messages — a duration standing in for a
  // count nobody could see.
  // `wireName`, not `name`: a live invocation's `name` is the activity's prose.
  const counted = countedGroupForToolCall(tool.wireName ?? tool.name, tool.status);
  if (counted) {
    return {
      key: counted.key,
      activity: countedActivity(counted, tool.status === 'started'),
      authoritativeDuration: false,
    };
  }
  const group = pluginGroup(tool.plugin?.canonicalId ?? tool.pluginId, tool.pluginName ?? tool.plugin?.displayName, tool.connectorType ?? tool.plugin?.connectorType);
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
 *
 * This answers only what a row *is*. A row that opens a stretch of transcript
 * after an unloaded one closes the run too, whatever its type, and each caller
 * checks `precededByTranscriptGap` itself — see `Message`.
 */
function continuesPluginActivityRun(message: Message): boolean {
  // A row that asks the person to act stands on its own, like a connection
  // card. A plugin's write refused for want of Google's one-file grant carries
  // the Allow editing request on its tool event, and folding it into the
  // plugin's row dropped that event: the card never rendered, and the agent
  // told the person three times to press a button that was not there.
  if (isConnectorConnectionCardWireName(message.toolEvent?.name)) return false;
  if (connectorResourceAuthorizationRequestFromToolEvent(message.toolEvent)) return false;
  return message.messageType === 'tool_event'
    || message.messageType === 'plugin_activity'
    || message.messageType === 'thought';
}

/**
 * The transcript without the agent's work (its thinking, tool calls and plugin
 * calls), for a member who turned it off.
 *
 * Messages between agents stay too; they are not calls. The response's own
 * `working` row stays: it is the live "Rally is working"
 * timer and, once settled, the "Worked for" total, and without it a long run
 * shows nothing between the question and the answer. `keep` spares the tool
 * rows that ask the reader to act (connecting an account, authorizing a
 * resource): hiding those would leave the agent waiting on a request nobody
 * can see.
 */
export function withoutAgentWork(
  messages: readonly Message[],
  keep: (message: Message) => boolean,
): Message[] {
  return messages.filter((message) => {
    if (message.messageType === 'thought') {
      return !message.thoughtEvent || !isThinkingEvent(message.thoughtEvent);
    }
    // A counted row is a message between agents, not a call: it carries its
    // turn's attention ordinal and is all that turn has to read, so hiding it
    // would leave the conversation unread with nothing to read.
    if (message.messageType === 'plugin_activity') return message.pluginActivity?.count !== undefined;
    return message.messageType !== 'tool_event' || keep(message);
  });
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
 * measures the plugin, including the time between its calls, and both its
 * duration and its spans displace the calls'. Without one the calls are all
 * there is: their spans union into the row's time where they have them, and
 * their durations are summed where they do not. Both undercount by exactly the
 * gaps between calls; only the sum also double-counts a batch that ran at once.
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
    /**
     * How many contributions this stretch holds, for a counted group.
     *
     * Kept on every group and read only by the counted ones: a timed row has
     * no use for it — the number of Slack calls is the mechanism the row exists
     * to hide — and branching the accumulator on the group's kind would fork
     * the one loop that decides where every row in this feed sits.
     */
    count: number;
    /**
     * The highest ordinal among contributions that are turns in their own
     * right, for a counted group; null for the timed majority.
     *
     * The highest rather than the first: this is one row standing for several
     * messages, so the divider belongs above it whenever *any* of them is
     * unread, and acknowledging the row has to acknowledge all of them or the
     * waterline stalls inside the group. Only rows with no `toolEvent`
     * contribute — a tool row's ordinal is its turn's, shared with that turn's
     * text, which is the ordinal a group row must not carry.
     */
    attentionSequenceNumber: number | null;
    monotonicStartedAt: number[];
    upperBound: boolean;
    /**
     * When the group worked, for a stretch that has to add several rows up.
     *
     * Tiered exactly as the durations above are, and for the same reason: a
     * plugin activity's spans cover its own calls, gaps included, so a tool
     * call that cannot say when it ran subtracts nothing from them. Keeping one
     * flat set instead let that one nullable join — the shape `pluginRuns`
     * exists to route around — take the whole row's timing down with it.
     */
    activitySpans: WorkSpan[];
    activitySpansKnown: boolean;
    toolSpans: WorkSpan[];
    toolSpansKnown: boolean;
  }
  const groups: GroupTiming[] = [];
  let open = new Map<string, GroupTiming>();
  const rows: Message[] = [];
  for (const message of messages) {
    // A seam closes the run before this row is considered, rather than instead
    // of considering it: the first row after a gap is work in its own right and
    // opens the next run, which is why this is not folded into
    // `continuesPluginActivityRun` — that answer would also push the row
    // through unchanged.
    if (message.precededByTranscriptGap) open = new Map();
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
        count: 0,
        attentionSequenceNumber: null,
        monotonicStartedAt: [],
        upperBound: false,
        activitySpans: [],
        activitySpansKnown: true,
        toolSpans: [],
        toolSpansKnown: true,
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
    group.count += 1;
    if (message.toolEvent === undefined && message.attentionSequenceNumber != null) {
      group.attentionSequenceNumber = Math.max(
        group.attentionSequenceNumber ?? message.attentionSequenceNumber,
        message.attentionSequenceNumber,
      );
    }
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
    // Spans are collected on the same two tiers, and all-or-nothing within each
    // one: a stretch adds its rows' spans up, so a tier missing a contribution's
    // would let that stretch report a total with a piece of itself left out.
    const spans = contribution.authoritativeDuration ? group.activitySpans : group.toolSpans;
    if (message.workSpans === undefined) {
      if (contribution.authoritativeDuration) group.activitySpansKnown = false;
      else group.toolSpansKnown = false;
    } else spans.push(...message.workSpans);
  }
  for (const group of groups) {
    const row = rows[group.row]!;
    // A counted group answers "how many", so it is finished here and skips the
    // timing tiers entirely rather than computing a number its row would not
    // print. The phrase is written now because only now is the total known:
    // the row was spread from the run's first contribution, when the stretch
    // was one message long.
    const counted = countedGroup(group.identity.groupKey);
    if (counted?.countPhrase) {
      rows[group.row] = {
        ...row,
        // An agent message is a turn of its own and the server gave it an
        // ordinal; the row standing for it has to carry one or the room's
        // unread waterline can never move past it. Null where no contribution
        // had one, which is every counted group built from tool calls.
        attentionSequenceNumber: group.attentionSequenceNumber,
        // The row was spread from its first contribution and carries that one's
        // spans, which stand for a fraction of what it now says. A counted row
        // reports no interval at all rather than that fraction: a message is an
        // event, and `send_message` returns at once by contract, so there is no
        // stretch of work here for an accordion to add up. `foldedStretchTotal`
        // skips it on that basis instead of reading the absence as a row whose
        // time is unknown, which would silence the whole drawer's total.
        workSpans: undefined,
        pluginActivity: {
          ...group.identity,
          active: group.active,
          durationMs: null,
          count: group.count,
          completedVerb: counted.countPhrase(group.count),
        },
      };
      continue;
    }
    // The activity measures the plugin, calls and the gaps between them alike,
    // so where there is one it answers both questions and the tool tier is not
    // consulted. The row was spread from the run's first contribution, so its
    // own spans are already on it and stand for a fraction of what it now says.
    const spans = group.sawActivity
      ? group.activitySpansKnown && group.activitySpans.length > 0 ? group.activitySpans : undefined
      : group.toolSpansKnown && group.toolSpans.length > 0 ? group.toolSpans : undefined;
    // A tool contribution carries no aggregate accuracy — `pluginGroupContribution`
    // builds one from a tool row and has none to give — so where this row's own
    // number came from those calls' spans, the spans are also the only thing
    // that can say a boundary was recovered rather than observed.
    const upperBound = group.upperBound
      || (spans?.some((span) => span.timingAccuracy === 'upper_bound') ?? false);
    rows[group.row] = {
      ...row,
      workSpans: spans,
      pluginActivity: {
        ...group.identity,
        active: group.active,
        durationMs: group.sawActivity
          ? group.activityDurationKnown ? group.activityDurationMs : null
          // Without an activity the calls are all there is, and Bind runs a
          // batch of them at once: summing three concurrent 5s calls reports
          // 15s of work that took 5, and puts a row inside a folded stretch
          // claiming more than the stretch itself. Their union is the same
          // fallback measured without counting a shared second twice, and it
          // undercounts the gaps between calls exactly as the sum did.
          : spans !== undefined ? unionDurationMs(spans)
            : group.toolDurationKnown ? group.toolDurationMs : null,
        ...(group.monotonicStartedAt.length === 0
          ? {}
          : { monotonicStartedAt: group.monotonicStartedAt }),
        ...(upperBound ? { timingAccuracy: 'upper_bound' as const } : {}),
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

export function activitiesForTurns(
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
 * The snapshot as an opening would have delivered it: the unread and latest
 * ranges and every turn the socket delivered live since, and nothing the
 * reader paged into afterwards.
 *
 * This is the shape the local cache keeps, and the reason is what happens when
 * the socket answers. Its first frame is an `initial` snapshot, which replaces
 * the transcript whole rather than merging — the room has no proof that turns
 * outside its bounded opening ranges did not change while this client was
 * away, so paged history is never relabelled under a new fence. A cached
 * transcript that carried that history would therefore paint three hundred
 * turns and then collapse to sixteen the moment the live frame arrived. Keeping
 * only the opening ranges makes the seed and its replacement the same shape,
 * so the swap is invisible in the common case and never a collapse. Activities
 * and plugin runs follow the turns they belong to, exactly as a reconcile keeps
 * them, so the rows that survive still render their timing.
 */
export function openingTranscriptSnapshot(
  snapshot: WorkstreamTranscriptSnapshot,
): WorkstreamTranscriptSnapshot {
  // `requested` names two different things: history the reader paged into,
  // and a turn the socket delivered live, which `mergeRealtimeTranscriptTurn`
  // appends under the same purpose. Only the first is dropped. A live turn
  // always extends the top of what the opening ranges covered, and a page-in
  // never does, so the ceiling of the opening ranges tells them apart.
  const opening = snapshot.ranges.filter((range) => range.purpose !== 'requested');
  if (opening.length === 0) return snapshot;
  const ceiling = Math.max(...opening.map((range) => range.covered.endExclusive));
  const ranges = snapshot.ranges.filter((range) => range.purpose !== 'requested'
    || range.covered.startInclusive >= ceiling);
  if (ranges.length === snapshot.ranges.length) return snapshot;
  const turns = [...ranges.flatMap((range) => range.turns), ...snapshot.activeTurns];
  const retainedTurnIds = new Set(turns.map((turn) => turn.turnId));
  const activities = activitiesForTurns(snapshot.activities, turns);
  return {
    ...snapshot,
    ranges,
    activities,
    activeActivities: activities.filter((activity) => activity.state === 'active'),
    pluginRuns: snapshot.pluginRuns.filter((run) => retainedTurnIds.has(run.turnId)),
  };
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
      ...(activity.connectorType ? { connectorType: activity.connectorType } : {}),
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

/**
 * The stretches of wall clock an activity occupied, or nothing.
 *
 * Nothing rather than an empty list, and the two mean different things: an
 * empty list would say the activity did no work, while every case answered
 * with `undefined` here is one where this client cannot see *when* the work
 * happened — the activity never reached the snapshot, or it is still running
 * and has no end yet. A caller that sums these has to know the difference,
 * because a stretch missing one row's spans is a stretch whose total is
 * unknown rather than shorter.
 *
 * A duration is deliberately not derived from these. The row's own number
 * comes from the authority that measured it; this exists only so several rows
 * can be added up without counting a second that two of them shared.
 */
function activityWorkSpans(activity: TranscriptActivity | undefined): readonly WorkSpan[] | undefined {
  if (!activity || activity.intervals.length === 0) return undefined;
  const spans: WorkSpan[] = [];
  for (const interval of activity.intervals) {
    // A closed interval that recorded no duration is one the authority calls
    // unmeasurable, and its timestamps do not overrule that: `activityDuration`
    // already counts it as nothing, so deriving a span from them would make a
    // drawer report time the rows inside it do not have.
    if (interval.stoppedAtUtc === null || interval.durationMs === null) return undefined;
    const startedAtMs = Date.parse(interval.startedAtUtc);
    const endedAtMs = Date.parse(interval.stoppedAtUtc);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
      return undefined;
    }
    spans.push({
      startedAtMs,
      endedAtMs,
      // Carried on the span rather than read back off the row: a group built
      // from tool rows alone has no aggregate to read it from, and a recovered
      // boundary is a property of the interval either way.
      ...(interval.timingAccuracy === 'upper_bound'
        ? { timingAccuracy: 'upper_bound' as const }
        : {}),
    });
  }
  return spans;
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
 * The verb a thought row reports, with the projection's default applied.
 *
 * Every reader of a thought row has to resolve the same absent-verb case, and
 * an omitted verb has always meant the response's total — the scope that
 * predates the per-turn thinking row. One function so a reader cannot resolve
 * it a fourth way.
 */
export function thoughtVerb(thought: ThoughtEventData): string {
  return thought.activeVerb ?? 'working';
}

/**
 * Whether a thought row is one turn's own reasoning.
 *
 * The verb is the only thing separating the two rows the projection produces,
 * and three places act on that distinction: this module's collapse, its fold,
 * and the renderer that decides which glyph the row wears. Sharing the
 * predicate makes them move together, rather than each carrying its own copy
 * of the string and the changelog carrying the warning.
 *
 * The fold deliberately does *not* use the negation of this. Not-thinking is a
 * wider set than the response's own total, and a third scope must not be
 * folded into a message header just because it is not reasoning.
 */
export function isThinkingEvent(thought: ThoughtEventData): boolean {
  return thoughtVerb(thought) === 'thinking';
}

/**
 * A row's own reasoning segment, or nothing.
 *
 * Keyed on the verb because that is what separates the two kinds of thought
 * row the projection produces: `thinking` is one turn's own reasoning and
 * several belong to a message, `working` is the response's total and there is
 * one of it, which `foldSettledWorkIntoMessages` moves into the header.
 *
 * A segment's duration is its whole activity's, so summing segments is honest
 * only while each row names a different activity. That holds because the
 * authority writes one thinking block per assistant turn, pointed at that
 * turn's own thinking activity. A second block on one turn would resolve to
 * the same activity, and the collapse would then report that activity's time
 * once per block — as one row quietly doubled, where today it would be two
 * rows visibly repeating the same number.
 */
function thinkingSegment(message: Message): ThoughtEventData | null {
  const thought = message.thoughtEvent;
  if (!thought || message.messageType !== 'thought') return null;
  return isThinkingEvent(thought) ? thought : null;
}

/**
 * Collapse a run of thinking into one row carrying the whole run's time.
 *
 * The model thinks between every pair of tool calls, so a run that used one
 * plugin four times arrives as four thinking rows around a single grouped
 * plugin row — "Thought for 29s / Thought for 38s / Thought for 17s / Thought
 * for 14s", four spent timers stacked in the feed saying one thing each. What
 * a reader wants from them is the same thing the plugin row gives: that Rally
 * was reasoning, and for how long in total. So the run becomes one row,
 * "Thinking for …" while any segment is still going and "Thought for …" once
 * they have all settled.
 *
 * The run is bounded exactly as a plugin group's is — see
 * `continuesPluginActivityRun`. Anything a person reads closes it, so thinking
 * that happens after Rally has said something starts a second row under that
 * sentence rather than being summed into the one above it. Plugin rows do not
 * close it, which is what puts the four rows above into one; the plugin row
 * they surround keeps its own place, because grouping already anchors it at
 * the first call in the run. A row that opens a stretch of transcript after an
 * unloaded one closes it too: the sentence that would have ended the run may
 * be sitting in the part nobody has loaded.
 *
 * The collapsed row sits where the run's *first* thinking row sat and inherits
 * its identity, so the feed's order stays the order work happened in and the
 * row's id does not move as the run grows.
 */
export function groupThinkingMessages(messages: readonly Message[]): Message[] {
  interface Run {
    row: number;
    segments: ThoughtEventData[];
    /** When the run's segments worked; null once one of them cannot say. */
    spans: WorkSpan[] | null;
  }
  const runs: Run[] = [];
  let open: Run | null = null;
  const rows: Message[] = [];
  for (const message of messages) {
    if (message.precededByTranscriptGap || !continuesPluginActivityRun(message)) open = null;
    const segment = thinkingSegment(message);
    if (!segment) {
      rows.push(message);
      continue;
    }
    if (open) {
      open.segments.push(segment);
      open.spans = open.spans === null || message.workSpans === undefined
        ? null
        : [...open.spans, ...message.workSpans];
      continue;
    }
    open = {
      row: rows.length,
      segments: [segment],
      spans: message.workSpans === undefined ? null : [...message.workSpans],
    };
    runs.push(open);
    rows.push(message);
  }
  for (const run of runs) {
    if (run.segments.length === 1) continue;
    const row = rows[run.row]!;
    // One unknown segment makes the whole run unknowable rather than shorter:
    // summing only the segments that reported understates the reasoning by
    // exactly the one that did not, and presents the shortfall as certain. The
    // total is carried as nullable through the fold rather than guarded by a
    // flag beside it, so there is no arm that adds a duration the guard has
    // already ruled out.
    const durationMs = run.segments.reduce<number | null>(
      (total, segment) => total === null || segment.durationMs === null
        ? null
        : total + segment.durationMs,
      0,
    );
    const monotonicStartedAt = run.segments.flatMap((segment) => segment.monotonicStartedAt === undefined
      ? []
      : typeof segment.monotonicStartedAt === 'number'
        ? [segment.monotonicStartedAt]
        : [...segment.monotonicStartedAt]);
    // A wall-clock start cannot be aggregated — the row has one field and
    // several segments could be running — so it survives only when the run has
    // exactly one, which is the case it was written for. Every producer today
    // reports a running segment monotonically, and those do sum.
    const startedAt = run.segments.flatMap((segment) => segment.startedAt === undefined ? [] : [segment.startedAt]);
    const first = run.segments[0]!;
    rows[run.row] = {
      ...row,
      // The row keeps the first segment's identity, and its spans came with it
      // — they say when one segment of a run this row now stands for happened,
      // so they go the same way the first segment's duration did.
      workSpans: run.spans ?? undefined,
      thoughtEvent: {
        status: run.segments.some((segment) => segment.status === 'started') ? 'started' : 'completed',
        durationMs,
        ...(startedAt.length === 1 ? { startedAt: startedAt[0]! } : {}),
        ...(monotonicStartedAt.length === 0 ? {} : { monotonicStartedAt }),
        ...(run.segments.some((segment) => segment.timingAccuracy === 'upper_bound')
          ? { timingAccuracy: 'upper_bound' as const }
          : {}),
        ...(first.activeVerb === undefined ? {} : { activeVerb: first.activeVerb }),
        ...(first.completedVerb === undefined ? {} : { completedVerb: first.completedVerb }),
      },
    };
  }
  return rows.map((message, index) => ({ ...message, sequenceNumber: index + 1 }));
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
 *
 * The header is where the total *lands*, not always where it is printed:
 * {@link collapseSettledWorkIntoAccordion} runs after this and moves it onto
 * the accordion it builds over the run, in the case where that accordion is the
 * whole run — a response that narrated itself into several stretches keeps the
 * total here, since no one of those stretches is what it measured. What this
 * pass answers either way is which message the total belongs to, which is the
 * question the accordion would otherwise have to ask again.
 */
export function foldSettledWorkIntoMessages(messages: readonly Message[]): Message[] {
  const rows: Message[] = [];
  for (const message of messages) {
    const thought = message.thoughtEvent;
    const settledResponseWork = thought !== undefined
      && message.messageType === 'thought'
      && thought.status !== 'started'
      // 'thinking' is a turn's own reasoning; 'working' is the whole response.
      // Named rather than negated, per `isThinkingEvent`: only the response's
      // own total belongs in a message header.
      && thoughtVerb(thought) === 'working';
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
 * A row the accordion swallows: machinery, not something a person read.
 *
 * The same two types `continuesPluginActivityRun` keeps a run open across,
 * minus the tool rows grouping has already removed from this feed. Sharing the
 * *set* with that predicate rather than the predicate itself is deliberate:
 * that one answers whether a row leaves a run open, which a text row does not
 * and an accordion's boundary agrees with; this one answers whether a row goes
 * inside, and a tool row that reached here ungrouped would be the one thing in
 * the drawer wearing a tool name.
 */
function isCollapsedWorkRow(message: Message): boolean {
  return message.messageType === 'plugin_activity' || message.messageType === 'thought';
}

/**
 * A row that is still reporting live work.
 *
 * The accordion's one hard rule is that nothing a reader is still watching gets
 * folded away, and this is what states it. The feed's ordinary shape makes the
 * rule look free — the projection positions a response's own timer after every
 * block of its last turn, so while it runs it is the final row with no answer
 * beneath it — but a streaming overlay is inserted at `transcriptSequence - 1`
 * and can therefore arrive *below* that still-running timer, putting an answer
 * under it. Relying on the ordering was the defect; this asks the rows.
 *
 * It reads each row's own reported state rather than `AgentWorkTiming`'s
 * narrower `running`, which additionally demands a start to count from: a row
 * whose activity is still marked active is a row reporting live work even when
 * its number has frozen, and that is the row that must not disappear.
 */
function isStillRunningWorkRow(message: Message): boolean {
  if (message.messageType === 'thought') return message.thoughtEvent?.status === 'started';
  if (message.messageType === 'plugin_activity') return message.pluginActivity?.active === true;
  return false;
}

/**
 * How long a set of spans covers, counting a shared second once.
 *
 * The union is the only way to add work rows up. Bind runs a batch's tool
 * calls concurrently, and a plugin row covers the gaps between its own calls
 * that the thinking row beside it is filling — so a sum overstates a stretch
 * by however much of it ran at the same time, which is why the accordion never
 * had a total of its own before these spans existed.
 */
function unionDurationMs(spans: readonly WorkSpan[]): number {
  const ordered = [...spans].sort((left, right) => left.startedAtMs - right.startedAtMs);
  let total = 0;
  let openedAt: number | null = null;
  let closesAt = 0;
  for (const span of ordered) {
    if (openedAt === null) {
      openedAt = span.startedAtMs;
      closesAt = span.endedAtMs;
      continue;
    }
    if (span.startedAtMs > closesAt) {
      total += closesAt - openedAt;
      openedAt = span.startedAtMs;
      closesAt = span.endedAtMs;
      continue;
    }
    closesAt = Math.max(closesAt, span.endedAtMs);
  }
  return openedAt === null ? 0 : total + (closesAt - openedAt);
}

/**
 * What a folded stretch says it worked for, from the rows it holds.
 *
 * The response's own total is the better answer where it applies, and
 * {@link collapseSettledWorkIntoAccordion} prefers it: it is the authority's
 * measurement of the whole run, and where the drawer *is* the whole run it
 * moves onto it unchanged. This is what the other drawers get. A stretch of a
 * self-narrating response has no total of its own reported anywhere, and the
 * alternative to computing one here is the bare "Worked" every such drawer
 * used to read — a row asking to be opened while saying nothing about whether
 * that is worth doing.
 *
 * Every work row it holds has to be able to say when it worked, or the stretch
 * reports nothing. A row whose spans never reached this client took an unknown
 * amount of time, and a union over the rest would print a number quietly
 * missing it — the same reason a thinking run with one unmeasured segment
 * reports no total rather than a shorter one.
 *
 * The accuracy comes from the rows themselves: a stretch holding a row whose
 * own timing is an upper bound is a stretch whose total is one too, and it
 * reads "Worked for at most …" exactly as that row does.
 */
function foldedStretchTotal(rows: readonly Message[]): WorkTotal {
  const work = rows.filter(isCollapsedWorkRow);
  // Either source can say the timing is recovered, and both are asked. The row's
  // aggregate is what a plugin row from the server carries; the spans are what a
  // group assembled from tool rows alone has, and that group has no aggregate
  // accuracy of its own to read.
  const rowAccuracy = (row: Message): 'observed' | 'upper_bound' | undefined =>
    row.messageType === 'thought' ? row.thoughtEvent?.timingAccuracy : row.pluginActivity?.timingAccuracy;
  const upperBound = work.some((row) => rowAccuracy(row) === 'upper_bound'
    || row.workSpans?.some((span) => span.timingAccuracy === 'upper_bound'));
  const accuracy = upperBound ? { timingAccuracy: 'upper_bound' as const } : {};
  // One row is the whole stretch, and there is nothing for its own number to be
  // overlapping with, so the drawer can report it even where the transcript
  // cannot say *when* it happened. Withholding a total the drawer plainly has
  // is the failure this label exists to fix.
  const lone = work.length === 1 ? work[0]! : undefined;
  if (lone && lone.workSpans === undefined) {
    const durationMs = lone.messageType === 'thought'
      ? lone.thoughtEvent?.durationMs ?? null
      : lone.pluginActivity?.durationMs ?? null;
    return { durationMs, ...accuracy };
  }
  const spans: WorkSpan[] = [];
  for (const row of work) {
    if (row.workSpans === undefined) {
      // A counted row is the one kind that is missing spans because it has
      // none to have: it stands for messages, which are events rather than
      // stretches of work. Treating that as an unmeasured interval would take
      // the drawer's total down to a bare "Worked" every time a teammate
      // answered mid-run — reporting less because the feed learned more.
      if (row.pluginActivity?.count !== undefined) continue;
      return { durationMs: null };
    }
    spans.push(...row.workSpans);
  }
  return spans.length === 0
    ? { durationMs: null }
    : { durationMs: unionDurationMs(spans), ...accuracy };
}

/**
 * Fold each finished stretch of machinery behind the answer it produced.
 *
 * While a stretch is running, every row of it is progress: the reader watches
 * which places Rally is working in and how long each is taking, and that is the
 * whole point of the rows. An answer is Rally's own report on that work, so the
 * moment one is posted the rows above it stop being progress and become a
 * receipt for a sentence the reader has now read. So they collapse into a single
 * closed row, and a reader who wants the breakdown opens it.
 *
 * **An answer is the signal, not the settled response timer.** A long run
 * narrates itself — it works, says what it found, works again, says what that
 * found — and its response timer settles once, at the very end. Keying the
 * collapse on that timer folded only the last stretch and left every earlier one
 * expanded above the sentence that had already summarized it, which is the
 * stack of spent timers this pass exists to remove. Keying it on the answer
 * folds each stretch as its own report arrives, and the live tail — the rows
 * with no answer under them yet — is the only thing left open, which is exactly
 * the part still worth watching.
 *
 * The rows collapsed are the ones immediately above the answer, back to the
 * first thing a person read, which is the boundary `groupPluginToolMessages`
 * and `groupThinkingMessages` already grouped within — so the accordion holds
 * exactly one stretch's worth of rows, each already collapsed to one per
 * plugin. A stretch of transcript nobody has loaded ends it too, for the reason
 * every pass here stops there: the sentence that closed the earlier run may be
 * sitting in the part nobody loaded. That seam is checked at *both* ends of the
 * scan. An answer that carries it is itself the first row of a newly loaded
 * island, so the machinery above it belongs to an earlier one and is not this
 * answer's to fold — the projection marks only a turn's first row, so an answer
 * that opens its turn is exactly the shape where that happens.
 *
 * **The response's total is printed on an accordion only when that accordion is
 * the whole response.** {@link foldSettledWorkIntoMessages} has already resolved
 * the settled response timer to the answer it belongs to, and where the run
 * produced a single accordion that accordion stands for the whole of the work
 * the timer measured, so the total moves onto it — printing it there *and* in
 * the header a line below would be one duration competing with itself. Where the
 * run narrated itself into several stretches, no one of them is the whole
 * response, and a total covering all of them printed on the last would claim
 * 3m 12s for a drawer holding 21s of rows. It stays in the final answer's header
 * instead, which is the one place it was ever a fact about: "Rally · 11 minutes
 * ago · Worked for 2m 52s".
 *
 * **The remaining accordions report their own stretch**, from the union of when
 * their rows worked — never a sum of those rows, which would overstate the
 * stretch by however much of it ran concurrently; see `foldedStretchTotal` and
 * the invariant in `plugin-activity-rows.md`. A stretch holding a row that
 * cannot say when it worked still reads a plain "Worked".
 *
 * The settled response total is the only response boundary this feed carries,
 * so it is the only thing that starts the count over. A row a person read is
 * not one: a steer is committed as its own canonical turn *between* two answers
 * of a single response, while the response activity — and the total it settles
 * to — spans both sides of it, so counting it as a boundary let the last
 * stretch take a total covering the whole thing.
 *
 * The count is only a proxy for "this accordion is the whole response", and it
 * fails across a seam: a response whose earlier stretches were never loaded
 * shows one accordion here and produced several. So a seam marks coverage
 * **partial**, and a partial response never hands its total to a drawer — the
 * number would claim time the drawer cannot show, and would jump from the
 * drawer back to the header the moment the gap was filled. That mark clears
 * where the count does, at the next settled total: the response it ends is the
 * one that might have been partly unloaded, and what follows it is loaded.
 *
 * Neither is the rule that keeps live work on screen. **Nothing a reader is
 * still watching is folded away** is stated directly, by asking each row of the
 * stretch whether it is still reporting work — see
 * {@link isStillRunningWorkRow}. Position looks like it would answer this, and
 * does not: a streaming overlay is inserted at `transcriptSequence - 1` and can
 * arrive below the response's own still-running timer, putting an answer under
 * a row nobody is finished with.
 *
 * The accordion keeps the attention ordinal of the first row it swallowed,
 * because the unread divider is placed at the first row carrying one and the
 * machinery of an unread turn belongs under that divider with the answer it
 * produced. Carrying the ordinal is not the same as having been read, though:
 * `highestVisibleAttentionSequence` excludes this row for the reason it already
 * excludes a tool row — an accordion scrolling into view, or a long one being
 * scrolled through, must not acknowledge a sentence still below the fold.
 *
 * The accordion sits where the stretch's first row sat and takes a derived id:
 * it is a different row from the one it replaces, and that row is still in the
 * feed — inside it — so reusing the id would put the same `message-<id>` anchor
 * on the document twice.
 */
export function collapseSettledWorkIntoAccordion(messages: readonly Message[]): Message[] {
  const rows: Message[] = [];
  // How many accordions the response being read has produced so far. Its total
  // moves onto an accordion only while that count is one, because only then is
  // the accordion the whole of what the total measured.
  let accordionsInResponse = 0;
  // Whether this response's earlier stretches may be sitting in a part of the
  // transcript nobody has loaded, which makes the count above a count of the
  // rows this client happens to hold rather than of the response's own work.
  let responseCoverageIsPartial = false;
  for (const message of messages) {
    // A row opening a newly loaded island says nothing about what came before
    // it, and what came before it may be more of this same response — so no
    // accordion built from here on is known to be the response's only one.
    if (message.precededByTranscriptGap) responseCoverageIsPartial = true;
    const answer = message.messageType === 'text' && message.authorType === 'agent';
    // An answer carrying the seam is itself the first row of a newly loaded
    // island, so the machinery above it in this list belongs to an earlier one
    // and is not this answer's to fold.
    const foldable = answer && message.precededByTranscriptGap !== true;
    let collapsed: Message[] = [];
    if (foldable) {
      let start = rows.length;
      while (start > 0 && isCollapsedWorkRow(rows[start - 1]!)) {
        start -= 1;
        // The seam's own row opens the visible stretch, so the run starts at it
        // rather than before it.
        if (rows[start]!.precededByTranscriptGap) break;
      }
      // Nothing a reader is still watching is folded away. A stretch holding a
      // row that is still reporting live work stays in the feed until it
      // settles, at which point the next render closes it.
      if (!rows.slice(start).some(isStillRunningWorkRow)) collapsed = rows.splice(start);
    }
    const summary = answer ? message.workSummary : undefined;
    if (collapsed.length === 0) {
      rows.push(message);
    } else {
      accordionsInResponse += 1;
      const movesTotal = summary !== undefined
        && accordionsInResponse === 1
        && !responseCoverageIsPartial;
      const first = collapsed[0]!;
      rows.push({
        ...first,
        id: `${first.id}:work-accordion`,
        messageType: 'work_accordion',
        // The unread divider is placed at the first row carrying an ordinal, so
        // a row that swallowed the ones that carried it has to carry it too or
        // the divider slides down past the accordion and leaves an unread
        // turn's work sitting in the read section above it. Acknowledgement is
        // the separate question, and the answer there is still no: see the
        // docblock.
        attentionSequenceNumber: collapsed.find(
          (row) => row.attentionSequenceNumber != null,
        )?.attentionSequenceNumber ?? null,
        // The row's own work is inside it now; nothing downstream should read
        // the first row's timing back off the wrapper.
        pluginActivity: undefined,
        thoughtEvent: undefined,
        toolEvent: undefined,
        workAccordion: {
          // The response's own total where this drawer is the whole response,
          // and otherwise the stretch's own: the union of when its rows worked,
          // which is what a set of overlapping rows can honestly be added up
          // by. Where even that cannot be established the drawer still reads a
          // plain "Worked" — see `foldedStretchTotal`.
          ...(movesTotal
            ? {
              durationMs: summary.durationMs,
              ...(summary.timingAccuracy === undefined
                ? {}
                : { timingAccuracy: summary.timingAccuracy }),
            }
            : foldedStretchTotal(collapsed)),
          rows: collapsed,
        },
      });
      const host: Message = { ...message };
      if (movesTotal) delete host.workSummary;
      rows.push(host);
    }
    // The settled response total is the only response boundary this feed
    // carries, so it is the only thing that starts the count over. A row a
    // person read is not one: a steer is committed as its own canonical turn
    // *between* two answers of one response, and resetting there let the last
    // stretch take a total covering both sides of it.
    if (summary !== undefined) {
      accordionsInResponse = 0;
      responseCoverageIsPartial = false;
    }
  }
  return rows.map((message, index) => ({ ...message, sequenceNumber: index + 1 }));
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

/**
 * Who delivered an activation row, for the author slot.
 *
 * The name is the one frozen into the row at delivery, not the Sidekick's
 * current name: a rename should not restate who said something last week. A row
 * whose structured content will not parse falls back to the generic label
 * rather than rendering a half-read identity.
 */
function automationActivationFields(
  structured: Record<string, unknown>,
): Pick<Message, 'automationActivation'> | Record<string, never> {
  if (structured['type'] !== 'automation_activation') return {};
  const parsed = AutomationActivationV1Schema.safeParse(structured);
  if (!parsed.success) return {};
  return {
    automationActivation: {
      automationId: parsed.data.automationId,
      automationName: parsed.data.automationName,
      runId: parsed.data.runId,
      ...(parsed.data.trigger ? { trigger: parsed.data.trigger.kind } : {}),
      ...(parsed.data.run ? { run: parsed.data.run } : {}),
    },
  };
}
