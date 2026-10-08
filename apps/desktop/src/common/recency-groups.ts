import { compareAlphabeticalTitle } from '@rally/ui/lib/alphabetical';

/**
 * How Rally groups a list of things by when they last moved.
 *
 * This lives in `common/` rather than beside the sidebar because the main
 * process's menu bar item orders the same Channels the sidebar does, and has no
 * renderer to ask on a launch that opens no window. It takes the Recent sort
 * from here rather than keeping a near-identical copy.
 */

/** A work stream or note, reduced to the one field grouping reads. */
export interface RecencyItem {
  readonly lastActivityAt: string;
}

export type RecencyGroup =
  | 'Last hour'
  | 'Today'
  | 'Yesterday'
  | 'This week'
  | 'This month'
  | 'Before this month';

/** Newest first, which is the order both surfaces render the headings in. */
export const RECENCY_GROUP_ORDER: readonly RecencyGroup[] = [
  'Last hour',
  'Today',
  'Yesterday',
  'This week',
  'This month',
  'Before this month',
];

export const hourInMilliseconds = 3_600_000;

/**
 * The recency timestamp a work stream is grouped and sorted by.
 *
 * A visit counts as activity: the list answers "what have I been working on",
 * and a work stream someone opened an hour ago belongs above one that a
 * background run touched. Missing metadata means an older server that does not
 * report visits at all; an explicit null means it exists and nobody has
 * visited, which falls back to creation rather than to somebody else's message.
 */
export function workstreamRecencyAt(
  workstream: {
    readonly lastAccessedAt?: string | null;
    readonly createdAt?: string;
    readonly lastActivityAt: string;
  },
): string {
  return workstream.lastAccessedAt === undefined
    ? workstream.lastActivityAt
    : workstream.lastAccessedAt ?? workstream.createdAt ?? workstream.lastActivityAt;
}

/** Sorts unparseable timestamps to the bottom rather than throwing the order. */
export function recencyTimestamp(item: RecencyItem): number {
  const timestamp = new Date(item.lastActivityAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/**
 * The sidebar's **Recent** sort: newest last activity first, ties A to Z. The
 * Channel's own last activity, not when this reader last opened it: the row's
 * time shows the same value, so the order and the times down the list agree.
 * Shared so the menu bar's Most recent section orders Channels exactly as the
 * sidebar does under All.
 */
export function compareRecentChannels(
  left: { readonly id: string; readonly title: string; readonly lastActivityAt: string },
  right: { readonly id: string; readonly title: string; readonly lastActivityAt: string },
): number {
  return recencyTimestamp(right) - recencyTimestamp(left) || compareAlphabeticalTitle(left, right);
}

/** The next instant when a recency heading can change without new data. */
export function nextRecencyBoundary(
  items: readonly RecencyItem[],
  now = new Date(),
): number {
  const nowTimestamp = now.getTime();
  let next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  ).getTime();
  for (const item of items) {
    const timestamp = recencyTimestamp(item);
    const leavesLastHourAt = timestamp + hourInMilliseconds;
    if (Number.isFinite(leavesLastHourAt) && leavesLastHourAt > nowTimestamp) {
      next = Math.min(next, leavesLastHourAt);
    }
  }
  return next;
}

/**
 * Groups by recency, newest heading first, dropping every heading with nothing
 * under it. Sorts first, so a caller may pass an unordered list.
 */
export function groupActivityItems<T extends RecencyItem>(
  items: readonly T[],
  now = new Date(),
): Array<{ label: RecencyGroup; streams: T[] }> {
  const groups = new Map<RecencyGroup, T[]>();
  const nowTimestamp = now.getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  // Sunday-start, matching `startOfWeekWindow` in the renderer's formatter.
  const startOfWeek = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  ).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const ordered = [...items].sort(
    (a, b) => recencyTimestamp(b) - recencyTimestamp(a),
  );

  for (const stream of ordered) {
    let label: RecencyGroup;
    const timestamp = recencyTimestamp(stream);
    if (timestamp >= nowTimestamp - hourInMilliseconds) label = 'Last hour';
    else if (timestamp >= startOfToday) label = 'Today';
    else if (timestamp >= startOfYesterday) label = 'Yesterday';
    else if (timestamp >= startOfWeek) label = 'This week';
    else if (timestamp >= startOfMonth) label = 'This month';
    else label = 'Before this month';
    groups.set(label, [...(groups.get(label) ?? []), stream]);
  }

  return RECENCY_GROUP_ORDER.flatMap((label) => {
    const grouped = groups.get(label);
    return grouped?.length ? [{ label, streams: grouped }] : [];
  });
}
