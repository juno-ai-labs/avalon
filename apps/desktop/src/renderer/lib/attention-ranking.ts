import type { Workstream, WorkstreamAppearance } from '@rally/contracts';
import type { WorkstreamMarkerStatus } from '@rally/ui/lib/format';

/**
 * The one ranking, most urgent first.
 *
 * Written as an order rather than as a chain of conditionals because the
 * question it answers — which of several true things does a person see — is a
 * product decision that gets revisited, and a list can be reordered without
 * anyone having to re-derive what the old nesting meant. The three personal
 * states are deliberately not grouped together: being mentioned outranks a run
 * that is working, while merely being unread does not.
 */
export const MARKER_PRECEDENCE: readonly WorkstreamMarkerStatus[] = [
  'unseen',
  'mentioned',
  'running',
  'needs_input',
  'unread',
  'completed',
  'stopped',
  'failed',
];

/** The markers that belong to the reader alone rather than to the run. */
export type ReaderMarkerStatus = Extract<WorkstreamMarkerStatus, 'unseen' | 'mentioned' | 'unread'>;

/**
 * The reader's own marker on a conversation, ignoring its run, or null when
 * the reader is caught up.
 *
 * The attention list is what is waiting for *this person*, and a running
 * agent is not: nobody has to do anything about it yet. The order between the
 * three is `MARKER_PRECEDENCE`'s, so it moves when that list does.
 */
export function readerMarkerStatus(
  conversation: { hasUnread?: boolean; unseen?: boolean; youAreMentioned?: boolean },
): ReaderMarkerStatus | null {
  const active = new Set<WorkstreamMarkerStatus>();
  if (conversation.unseen === true) active.add('unseen');
  if (conversation.youAreMentioned === true) active.add('mentioned');
  if (conversation.hasUnread === true) active.add('unread');
  return (MARKER_PRECEDENCE.find((status) => active.has(status)) as ReaderMarkerStatus | undefined) ?? null;
}

/** Where a marker sits in the one ranking; lower is more urgent. */
export function markerRank(status: WorkstreamMarkerStatus): number {
  const index = MARKER_PRECEDENCE.indexOf(status);
  return index === -1 ? MARKER_PRECEDENCE.length : index;
}

export type Breakout = NonNullable<Workstream['privateChildren']>[number];

/** Breakout lists by Channel id, as the Organization socket last wrote them. */
export type BreakoutLists = Readonly<Record<string, readonly Breakout[] | undefined>>;

/**
 * The fields of a Channel row the attention list reads. Structural, so any
 * cached summary of a Channel fits.
 */
export interface AttentionChannel {
  readonly id: string;
  readonly title: string;
  readonly lastActivityAt: string;
  readonly appearance?: WorkstreamAppearance;
  readonly pending?: boolean;
  readonly archivedAt?: string | null;
  readonly systemKind?: string | null;
  readonly mainWithheld?: true;
  readonly associativeSubstreamId?: string;
  readonly hasUnread?: boolean;
  readonly unseen?: boolean;
  readonly youAreMentioned?: boolean;
  readonly isParticipant?: boolean;
}

/**
 * One conversation waiting for this reader: a Channel's Main or one of its
 * Breakouts. `substreamId` is null for Main.
 */
export interface AttentionItem {
  key: string;
  workstreamId: string;
  substreamId: string | null;
  title: string;
  /** The Channel a Breakout sits in; null for Main. */
  channelTitle: string | null;
  /** The Channel's, for Main and Breakout alike, as the Space dashboard draws them. */
  appearance?: WorkstreamAppearance;
  reason: ReaderMarkerStatus;
  at: string;
}

/** Whether Main is the reader's and in their Threads list (`WorkstreamSchema.isParticipant`). */
function mainIsViewers(workstream: AttentionChannel): boolean {
  return workstream.mainWithheld !== true
    && workstream.isParticipant !== false
    && (!workstream.associativeSubstreamId || workstream.associativeSubstreamId === '0');
}

/**
 * Every conversation that is waiting for this reader, most urgent first and
 * newest first within a reason.
 *
 * The Channel rows say whether Main is unseen, mentions the reader or is
 * unread, and each Channel's Breakout list says the same per Breakout. A
 * mention written by Rally sets the same flag as one written by a person.
 */
export function attentionItems(workstreams: readonly AttentionChannel[], breakouts: BreakoutLists): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const workstream of workstreams) {
    if (workstream.pending || workstream.archivedAt || workstream.systemKind) continue;
    const main = mainIsViewers(workstream) ? readerMarkerStatus(workstream) : null;
    if (main) {
      items.push({
        key: workstream.id,
        workstreamId: workstream.id,
        substreamId: null,
        title: workstream.title,
        channelTitle: null,
        ...(workstream.appearance ? { appearance: workstream.appearance } : {}),
        reason: main,
        at: workstream.lastActivityAt,
      });
    }
    for (const breakout of breakouts[workstream.id] ?? []) {
      const reason = readerMarkerStatus({ ...breakout, hasUnread: (breakout.unreadCount ?? 0) > 0 });
      if (!reason) continue;
      items.push({
        key: `${workstream.id}:${breakout.substreamId}`,
        workstreamId: workstream.id,
        substreamId: breakout.substreamId,
        title: breakout.title,
        channelTitle: workstream.title,
        ...(workstream.appearance ? { appearance: workstream.appearance } : {}),
        reason,
        at: breakout.lastActivityAt ?? breakout.updatedAt,
      });
    }
  }
  return items.sort((left, right) => markerRank(left.reason) - markerRank(right.reason)
    || Date.parse(right.at) - Date.parse(left.at)
    || left.title.localeCompare(right.title));
}
