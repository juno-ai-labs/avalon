import type { HarnessStatus, WorkstreamSummary } from './types';

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

export function formatCompactNumber(value?: number): string | undefined {
  if (value === undefined) return undefined;
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export const statusLabel: Record<HarnessStatus, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  needs_input: 'Needs input',
  completed: 'Latest run completed',
  failed: 'Needs intervention',
};

export type RecencyGroup = 'Last hour' | 'Last day' | 'Last week' | 'This month' | 'The rest';

const hourInMilliseconds = 3_600_000;
const dayInMilliseconds = 24 * hourInMilliseconds;
const weekInMilliseconds = 7 * dayInMilliseconds;

function activityTimestamp(item: { lastActivityAt: string }): number {
  const timestamp = new Date(item.lastActivityAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function groupActivityItems<T extends { lastActivityAt: string }>(
  items: T[],
  now = new Date(),
): Array<{ label: RecencyGroup; streams: T[] }> {
  const groups = new Map<RecencyGroup, T[]>();
  const nowTimestamp = now.getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const ordered = [...items].sort(
    (a, b) => activityTimestamp(b) - activityTimestamp(a),
  );

  for (const stream of ordered) {
    let label: RecencyGroup;
    const timestamp = activityTimestamp(stream);
    if (timestamp >= nowTimestamp - hourInMilliseconds) label = 'Last hour';
    else if (timestamp >= nowTimestamp - dayInMilliseconds) label = 'Last day';
    else if (timestamp >= nowTimestamp - weekInMilliseconds) label = 'Last week';
    else if (timestamp >= startOfMonth) label = 'This month';
    else label = 'The rest';
    groups.set(label, [...(groups.get(label) ?? []), stream]);
  }

  const priority: RecencyGroup[] = [
    'Last hour',
    'Last day',
    'Last week',
    'This month',
    'The rest',
  ];
  return priority.flatMap((label) => {
    const grouped = groups.get(label);
    return grouped?.length ? [{ label, streams: grouped }] : [];
  });
}

export function groupWorkstreams(
  streams: WorkstreamSummary[],
  now = new Date(),
): Array<{ label: RecencyGroup; streams: WorkstreamSummary[] }> {
  return groupActivityItems(streams, now);
}
