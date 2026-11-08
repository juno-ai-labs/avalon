
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

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
  // Sunday-start. `getDay()` is 0 on Sunday; a Monday-start locale would
  // shift every week bucket by a day.
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

const shortWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const shortMonthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/**
 * A list row's age, in design.html §1's words: "now", "2m", "1h", then the
 * weekday ("Tue") within the week and the date beyond it. Short because it
 * sits beside a title in a 340px column, where a clock time cut the title.
 */
export function formatSidebarActivityTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const elapsed = now.getTime() - date.getTime();
  if (!Number.isFinite(elapsed)) return 'Unknown time';
  if (elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 7 * 86_400_000) return shortWeekday.format(date);
  return shortMonthDay.format(date);
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
