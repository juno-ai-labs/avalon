import { asSpaceId, type WorkstreamBatchFilter } from '@rally/contracts';

import { groupActivityItems, hourInMilliseconds, workstreamRecencyAt, type RecencyGroup } from '../../common/recency-groups';

import type { HarnessStatus, WorkstreamSummary } from './types';

export {
  groupActivityItems,
  nextRecencyBoundary,
  recencyTimestamp,
  workstreamRecencyAt,
  type RecencyGroup,
} from '../../common/recency-groups';

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function compareWorkstreamRecency(left: WorkstreamSummary, right: WorkstreamSummary): number {
  return Date.parse(workstreamRecencyAt(right)) - Date.parse(workstreamRecencyAt(left))
    || left.id.localeCompare(right.id);
}

export function formatRelative(value: string, now = new Date()): string {
  const date = new Date(value);
  const delta = date.getTime() - now.getTime();
  const absolute = Math.abs(delta);
  if (!Number.isFinite(delta)) return 'Unknown time';
  if (absolute < 60_000) return 'just now';
  if (absolute < 3_600_000) return relativeTime.format(Math.round(delta / 60_000), 'minute');
  if (absolute < 86_400_000) return relativeTime.format(Math.round(delta / 3_600_000), 'hour');
  if (absolute < 604_800_000) return relativeTime.format(Math.round(delta / 86_400_000), 'day');
  return dateTime.format(date);
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? shortTime.format(date) : 'Unknown time';
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateTime.format(date) : 'Unknown time';
}

const SPARSE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type SparseRelativeDate =
  | 'today'
  | 'yesterday'
  | 'this week'
  | 'last week'
  | 'this month'
  | 'last month'
  | 'Unknown time'
  | `${(typeof SPARSE_MONTHS)[number]} ${number}`;

/**
 * A coarse calendar label for a version row, where an exact timestamp is
 * more precision than the list can use.
 *
 * Today and yesterday win over the week they sit in; last week wins over the
 * month it sits in. Anything older than last month is the month and year
 * ("Aug 2025"), so a year-old row does not pretend to be "last month".
 * Weeks start on Sunday, matching the recency groups in this file, and the
 * month shorts are English rather than `Intl` so ICU's narrow no-break space
 * cannot flake a test.
 */
export function formatSparseRelativeDate(value: string, now = new Date()): SparseRelativeDate {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  // Sunday-start, same as `groupActivityItems` below. `getDay()` is 0 on
  // Sunday; a Monday-start locale would shift every week bucket by a day.
  const startOfWeek = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  ).getTime();
  const startOfLastWeek = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay() - 7,
  ).getTime();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const timestamp = date.getTime();

  if (timestamp >= startOfToday && timestamp < startOfTomorrow) return 'today';
  if (timestamp >= startOfYesterday && timestamp < startOfToday) return 'yesterday';
  if (timestamp >= startOfWeek && timestamp < startOfYesterday) return 'this week';
  if (timestamp >= startOfLastWeek && timestamp < startOfWeek) return 'last week';
  if (timestamp >= startOfThisMonth && timestamp < startOfNextMonth) return 'this month';
  if (timestamp >= startOfLastMonth && timestamp < startOfThisMonth) return 'last month';
  const month = SPARSE_MONTHS[date.getMonth()];
  if (!month) return 'Unknown time';
  return `${month} ${date.getFullYear()}`;
}

/**
 * A sidebar row's activity time: the time today, then the day as
 * `formatDayLabel` names it. The attention menu uses it too.
 */
export function formatSidebarActivityTime(value: string, now = new Date()): string {
  const label = formatDayLabel(value, now);
  return label === 'Today' ? formatTime(value) : label;
}

export function formatDuration(milliseconds?: number): string | undefined {
  if (milliseconds === undefined) return undefined;
  const normalizedMilliseconds = Math.max(0, milliseconds);
  if (normalizedMilliseconds < 1_000) return `${Math.round(normalizedMilliseconds)}ms`;
  const seconds = Math.round(normalizedMilliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
}

export { formatDayLabel, statusLabel, statusDescription, harnessMarkerStatus, type WorkstreamMarkerStatus } from '@rally/ui/lib/format';
import { formatDayLabel, harnessMarkerStatus, type WorkstreamMarkerStatus } from '@rally/ui/lib/format';
import { MARKER_PRECEDENCE } from './attention-ranking';

export { markerRank, readerMarkerStatus, type ReaderMarkerStatus } from './attention-ranking';

/**
 * The marker a work stream shows this viewer.
 *
 * The single answer every surface asks for, so the sidebar and the home screen
 * cannot disagree about which of a work stream's states is the one worth
 * showing. Surfaces may omit that result: the sidebar hides `completed`. The
 * run's own status arrives through `harnessMarkerStatus`, so `scheduled` is
 * ranked as `running` and never reaches the list under its own name.
 */
export function workstreamMarkerStatus(
  workstream: { harnessStatus: HarnessStatus; hasUnread?: boolean; unseen?: boolean; youAreMentioned?: boolean },
): WorkstreamMarkerStatus {
  const own = harnessMarkerStatus(workstream.harnessStatus);
  const active = new Set<WorkstreamMarkerStatus>([own]);
  if (workstream.unseen === true) active.add('unseen');
  if (workstream.youAreMentioned === true) active.add('mentioned');
  if (workstream.hasUnread === true) active.add('unread');
  // The fallback is unreachable — `scheduled` was the only member of the union
  // outside the ranking, and it cannot reach here now — but `find` is typed
  // `| undefined`, so the arm has to say something.
  return MARKER_PRECEDENCE.find((status) => active.has(status)) ?? own;
}

/** The server-side range that describes one visible recency heading. */
export function recencyGroupBatchFilter(
  label: RecencyGroup,
  now = new Date(),
  spaceId?: string,
): WorkstreamBatchFilter {
  const nowTimestamp = now.getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const startOfWeek = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  ).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const range = (() => {
    switch (label) {
      case 'Last hour': return { atOrAfter: new Date(nowTimestamp - hourInMilliseconds).toISOString() };
      case 'Today': return {
        atOrAfter: new Date(startOfToday).toISOString(),
        before: new Date(nowTimestamp - hourInMilliseconds).toISOString(),
      };
      case 'Yesterday': return {
        atOrAfter: new Date(startOfYesterday).toISOString(),
        before: new Date(startOfToday).toISOString(),
      };
      case 'This week': return {
        atOrAfter: new Date(startOfWeek).toISOString(),
        before: new Date(startOfYesterday).toISOString(),
      };
      case 'This month': return {
        atOrAfter: new Date(startOfMonth).toISOString(),
        before: new Date(startOfWeek).toISOString(),
      };
      case 'Before this month': return { before: new Date(startOfMonth).toISOString() };
    }
  })();
  return {
    lastActivityAt: range,
    ...(spaceId === undefined ? {} : { pinned: false, spaceId: asSpaceId(spaceId) }),
    includeSystem: false,
  };
}

export function groupWorkstreams(
  streams: WorkstreamSummary[],
  now = new Date(),
): Array<{ label: RecencyGroup; streams: WorkstreamSummary[] }> {
  return groupActivityItems(streams, now);
}
