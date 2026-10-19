import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import type { AgentModelOverride } from './agent-models';
import type { MentionIdentity } from './api';
import { prepareDraftMentions } from './transcript';
import type { MessageAttachment, WorkspaceMember, WorkstreamDetail } from './types';

/**
 * The turn a launch surface has already drawn, in the shape the conversation it
 * is about to become will draw it in.
 *
 * Both launchers — a new work stream and a new substream — press enter on a
 * composer and land on a conversation that does not have its first turn yet.
 * What they seed is identical down to the field, so it is built here once: two
 * copies would be two answers to what an optimistic turn's revision, coverage,
 * and identity are, and the second one to drift would be the one whose surface
 * flickers at the swap.
 */
export function optimisticOpeningTranscript(
  turn: {
    /** The canonical identity creation answered with, so the socket upsert replaces this row rather than adding one. */
    turnId: string;
    clientMessageId: string | null;
    createdAt: string;
    text: string;
    annotationContent?: Record<string,unknown> | undefined;
    mentions: readonly MentionIdentity[];
    attachments: readonly MessageAttachment[];
  },
  author: Pick<WorkspaceMember, 'id' | 'name' | 'avatarUrl'>,
  /**
   * Who the opening's mentions can name. The room stores a person mention as
   * `[@Name](person://<id>)` Markdown and the chip is drawn from that, so a
   * seed holding the draft's plain `@Name` reads as text until the canonical
   * turn replaces it.
   */
  members: readonly WorkspaceMember[],
): WorkstreamTranscriptSnapshot {
  const prepared = prepareDraftMentions(turn.text, turn.mentions, members);
  const opening = {
    transcriptSequence: 1,
    turnId: turn.turnId,
    entryKind: 'conversation' as const,
    actor: 'human' as const,
    authorUserId: author.id,
    authorSnapshot: {
      userId: author.id,
      displayName: author.name,
      avatarUrl: author.avatarUrl ?? null,
    },
    clientMessageId: turn.clientMessageId,
    attentionOrdinal: 1,
    createdAtUtc: turn.createdAt,
    // Local seed only. The first authoritative turn starts at revision 1 and
    // must replace this provisional content even when its identity is equal.
    revision: 0,
    blocks: [{
      type: 'text' as const,
      blockId: `${turn.turnId}:text:0`,
      blockIndex: 0,
      text: prepared.text,
      streaming: false,
      messageType: 'text' as const,
      ...(turn.annotationContent ? {structuredContent:turn.annotationContent} : {}),
      mentions: prepared.mentions.map((mention) => ({
        type: mention.type,
        userId: mention.userId,
        connectorType: mention.connectorType,
        startOffset: mention.startOffset,
        endOffset: mention.endOffset,
      })),
      attachments: [...turn.attachments],
    }],
    activityId: null,
  };
  return {
    snapshotId: `optimistic:${turn.turnId}`,
    snapshotThrough: 1,
    eventSequence: 0,
    snapshotAtUtc: turn.createdAt,
    unreadAnchorSequence: null,
    unreadReason: 'no_unread',
    ranges: [{
      purpose: 'latest',
      requested: { startInclusive: 1, endExclusive: 2 },
      covered: { startInclusive: 1, endExclusive: 2 },
      turns: [opening],
      activities: [],
      pluginRuns: [],
    }],
    activities: [],
    activeActivities: [],
    pluginRuns: [],
    activeTurns: [],
    pendingInputs: [],
  };
}

/**
 * The detail a just-created substream is put into the cache under, so its
 * screen paints instead of loading.
 *
 * A child's detail is the parent's identity carrying the child's own title,
 * roster, and run — `id` is the parent's, which is how every reader addresses a
 * conversation — so this starts from the parent detail rather than inventing
 * one, and empties the fields that belong to the main conversation. The
 * inventory a child does show is its parent's, and the sidebar reads that from
 * the parent's own entry.
 */
export function launchedSubstreamDetail(
  parent: WorkstreamDetail,
  context: {
    creator: WorkspaceMember;
    /** The first line of the opening message, standing in until the naming pass answers. */
    title: string;
    createdAt: string;
    /**
     * The model this creation pinned the child to, or null for the ordinary
     * unpinned case. Required rather than optional because the parent carries a
     * pin of its own in the fields this seed spreads, and a caller that forgot
     * this would hand the child its parent's — see the field below.
     */
    modelOverride: AgentModelOverride | null;
  },
): WorkstreamDetail {
  // Pulled off rather than overwritten: a child that inherited the parent's run
  // would show the parent's work timer, and `exactOptionalPropertyTypes` makes
  // writing `undefined` over an optional field an error rather than a way to
  // clear it.
  const {
    latestHarnessRun: _parentRun,
    latestHarnessRunId: _parentRunId,
    ...identity
  } = parent;
  void _parentRun;
  void _parentRunId;
  return {
    ...identity,
    title: context.title,
    // Stated rather than inherited. Every private child is provisioned
    // `personal`, so a child seeded from a workspace-scoped parent would read
    // as workspace-visible until the room's own snapshot corrected it — and its
    // composer would skip the confirmation it owes a mention of somebody who is
    // not in the child.
    scope: 'personal',
    // The naming pass is running against the message that was just sent, and
    // this is what puts the same skeleton in the child's header that the work
    // stream's own launch puts in its own.
    titleStatus: 'naming',
    // Stated rather than inherited, for the same reason `scope` is, and this
    // one is a claim about the model the work will run on: a substream does not
    // take its parent's pin, so a child seeded from a pinned parent would show
    // the parent's model as its own until the room's snapshot corrected it —
    // the exact inheritance the create path refuses. Null is the honest seed
    // for an unpinned child, and reads as **Default** like an untouched
    // composer.
    modelOverride: context.modelOverride,
    createdAt: context.createdAt,
    createdBy: { ...context.creator, role: 'creator' },
    participants: [{ ...context.creator, role: 'creator' }],
    viewers: [],
    resources: [],
    connections: [],
    backgroundTasks: [],
    openElicitations: [],
    firstUnreadSequenceNumber: null,
    // Admitted, not yet started: the substream's loop is being woken by the
    // turn that created it. `scheduled` is what withholds the child's `Ready to
    // begin` empty state until the room's own snapshot arrives with the run.
    //
    // No run is seeded beside it, unlike `launchedWorkstreamDetail`, and it is
    // not an omission: a work stream's creation writes its run and answers with
    // the id, while an opening message admitted into a conversation only leaves
    // a pending input — the run row is written when the child's loop claims it,
    // after this response. There is no id to seed, so the work timer the launch
    // surface was showing is not carried across; the child's own starts when
    // its room reports the run, a socket round trip later. Seeding a fabricated
    // id instead would put a run identity into the cache that the transcript's
    // own timing compares against and would never match.
    harnessStatus: 'scheduled',
    stopRequested: false,
  };
}
