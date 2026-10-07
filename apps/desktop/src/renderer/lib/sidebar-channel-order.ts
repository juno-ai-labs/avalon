import { conversationNeedsViewer } from '@rally/contracts';
import { compareAlphabeticalTitle } from '@rally/ui/lib/alphabetical';
import { compareRecentChannels } from '../../common/recency-groups';
import { orderByStoredIds } from './personal-order';
import type { WorkstreamSummary } from './types';
import type { SidebarChannelSort } from './ui-store';

/**
 * The order the sidebar draws a Space's Channels in, for every reader that has
 * to agree with it: the sidebar itself, and the landing a leave opens, which is
 * the top row the reader sees.
 */

export type WorkstreamComparator = (left: WorkstreamSummary, right: WorkstreamSummary) => number;

/**
 * How many of this Channel's conversations need this reader: its Breakouts,
 * plus Main when the row shows Main. One count for the row's bold title, its
 * dot, and the Needs you sort, so the three cannot disagree.
 */
export function workstreamAttentionCount(workstream: WorkstreamSummary): number {
  const mainVisible = !workstream.associativeSubstreamId || workstream.associativeSubstreamId === '0';
  return (workstream.breakoutAttentionCount ?? 0)
    + Number(mainVisible && conversationNeedsViewer(workstream));
}

/** Whether the row reads as unread: the input to its bold title. */
export function workstreamHasActivityForViewer(workstream: WorkstreamSummary): boolean {
  return workstream.hasUnread === true || workstreamAttentionCount(workstream) > 0;
}

/**
 * The comparator for the unpinned rows under each sort. `heldId` is the open
 * Channel that was bold when the reader opened it; only Needs you reads it.
 */
export function compareChannels(sort: SidebarChannelSort, heldId: string | null = null): WorkstreamComparator {
  if (sort === 'alphabetical') return compareAlphabeticalTitle;
  if (sort === 'recent') return compareRecentChannels;
  // Every bold row first, then the rest, each half in Recent order. Opening a
  // bold row reads it, and without the hold it would drop out from under the
  // pointer while the reader is still in it; it stays until they move on.
  const needsYou = (workstream: WorkstreamSummary): number => Number(
    workstream.id === heldId || workstreamHasActivityForViewer(workstream),
  );
  return (left, right) => needsYou(right) - needsYou(left) || compareRecentChannels(left, right);
}

/**
 * The pinned work streams, in the order to render them.
 *
 * `pinPosition` is the server's answer and the only order that survives a
 * reload. `dragOrder` is the arrangement a drag is currently building, and wins
 * while it exists so rows move under the pointer rather than after the round
 * trip. Ids in `dragOrder` that are no longer pinned — unpinned in another
 * window mid-drag — drop out, and anything pinned that the drag never saw is
 * appended, so the section always shows every pin exactly once.
 */
export function orderPinnedWorkstreams(
  workstreams: WorkstreamSummary[],
  dragOrder: readonly string[] | null,
): WorkstreamSummary[] {
  const pinned = workstreams
    .filter((workstream) => workstream.pinPosition !== null)
    // The id breaks a tie the way both server readers do. Positions are unique
    // today, so this cannot fire — it is here because "readers of this list
    // agree on the order" is stated as an invariant, and a third reader that
    // fell back to arrival order would be the one place it was not true.
    .sort((left, right) =>
      (left.pinPosition ?? 0) - (right.pinPosition ?? 0) || left.id.localeCompare(right.id));
  // The same arrangement rule every other hand-ordered list in the app is
  // drawn by, with the drag standing in for the stored order: ids it names
  // first, then everything it never saw, and an id that is no longer pinned —
  // unpinned in another window mid-drag — dropped rather than drawn as a gap.
  return orderByStoredIds(pinned, dragOrder ?? [], (workstream) => workstream.id);
}

/** Where a Channel sits in one Space's Pinned section, or null when it is not pinned there. */
export function spacePinPosition(
  workstream: Pick<WorkstreamSummary, 'spaceIds' | 'spacePins'>,
  spaceId: string,
): number | null {
  return workstream.spaceIds.includes(spaceId)
    ? workstream.spacePins?.find((pin) => pin.spaceId === spaceId)?.position ?? null
    : null;
}

/**
 * The top row of a Space's list in the sidebar: its first pin, or else the
 * first unpinned Channel under the reader's sort. Only Channels in that Space
 * are considered, and never a create still in flight.
 */
export function firstSidebarChannelInSpace(
  workstreams: WorkstreamSummary[],
  spaceId: string,
  sort: SidebarChannelSort,
): WorkstreamSummary | undefined {
  const inSpace = workstreams
    .filter((workstream) => !workstream.pending && workstream.spaceIds.includes(spaceId))
    .map((workstream) => ({ ...workstream, pinPosition: spacePinPosition(workstream, spaceId) }));
  return orderPinnedWorkstreams(inSpace, null)[0]
    ?? inSpace.filter((workstream) => workstream.pinPosition === null).sort(compareChannels(sort))[0];
}
