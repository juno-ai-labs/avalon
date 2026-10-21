import { conversationNeedsViewer } from '@rally/contracts';
import { compareAlphabeticalTitle } from '@rally/ui/lib/alphabetical';
import { compareRecentChannels } from '../../common/recency-groups';
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
 * The comparator for the unpinned rows under each sort. Selection does not
 * change attention rank; the list holds the open row's displayed position.
 */
export function compareChannels(sort: SidebarChannelSort): WorkstreamComparator {
  if (sort === 'alphabetical') return compareAlphabeticalTitle;
  if (sort === 'recent') return compareRecentChannels;
  // Every bold row first, then the rest, each half in Recent order.
  const needsYou = (workstream: WorkstreamSummary): number => Number(workstreamHasActivityForViewer(workstream));
  return (left, right) => needsYou(right) - needsYou(left) || compareRecentChannels(left, right);
}

