import type { WorkstreamBatchFilter } from '@rally/contracts';

import type { HarnessStatus, WorkstreamSummary } from './types';

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Missing metadata means an older server; explicit null means never visited. */
export function workstreamRecencyAt(workstream: Pick<WorkstreamSummary, 'lastAccessedAt' | 'createdAt' | 'lastActivityAt'>): string {
  return workstream.lastAccessedAt === undefined
    ? workstream.lastActivityAt
    : workstream.lastAccessedAt ?? workstream.createdAt ?? workstream.lastActivityAt;
}

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

/**
 * What a work-stream marker can say, which is more than the run can.
 *
 * Five of these are the harness's own status. Three — `unread`, `mentioned`,
 * `unseen` — are the reader's, and they are in the same vocabulary because
 * they compete for the same dot: a work stream is never showing a person two
 * markers, so the states have to be ranked against each other rather than
 * drawn side by side.
 */
export type WorkstreamMarkerStatus = HarnessStatus | 'unread' | 'mentioned' | 'unseen';

export const statusLabel: Record<WorkstreamMarkerStatus, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  needs_input: 'Needs input',
  completed: 'Latest run completed',
  failed: 'Needs intervention',
  stopped: 'Latest run stopped',
  unread: 'Unread',
  mentioned: 'You were mentioned',
  unseen: 'New to you',
};

/** What each dot color means, for the surfaces that show the dot on its own.
 * Each sentence opens with the label itself, so rewording one carries here. */
export const statusDescription: Record<WorkstreamMarkerStatus, string> = {
  scheduled: `${statusLabel.scheduled} — the next run has not started yet.`,
  running: `${statusLabel.running} — the agent is working on it now.`,
  needs_input: `${statusLabel.needs_input} — the agent is waiting on an answer.`,
  completed: `${statusLabel.completed} — nothing is running now.`,
  failed: `${statusLabel.failed} — the last run failed and stopped.`,
  stopped: `${statusLabel.stopped} — the run was stopped by request.`,
  unread: `${statusLabel.unread} — there are messages here you have not read.`,
  mentioned: `${statusLabel.mentioned} — somebody named you in a message you have not read.`,
  unseen: `${statusLabel.unseen} — you were added to this work stream and have not opened it yet.`,
};

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
const MARKER_PRECEDENCE: readonly WorkstreamMarkerStatus[] = [
  'unseen',
  'mentioned',
  'running',
  'needs_input',
  'unread',
  'completed',
  'stopped',
  'failed',
];

/**
 * The marker a work stream shows this viewer.
 *
 * The single answer every surface asks for, so the sidebar and the home screen
 * cannot disagree about which of a work stream's states is the one worth
 * showing. Surfaces may omit that result — see `workstreamMarkerIsQuiet`.
 * `scheduled` has no personal state to lose to and is not in the
 * ranking; it falls through as the run's own status.
 */
export function workstreamMarkerStatus(
  workstream: { harnessStatus: HarnessStatus; hasUnread?: boolean; unseen?: boolean; youAreMentioned?: boolean },
): WorkstreamMarkerStatus {
  const active = new Set<WorkstreamMarkerStatus>([workstream.harnessStatus]);
  if (workstream.unseen === true) active.add('unseen');
  if (workstream.youAreMentioned === true) active.add('mentioned');
  if (workstream.hasUnread === true) active.add('unread');
  return MARKER_PRECEDENCE.find((status) => active.has(status)) ?? workstream.harnessStatus;
}

/**
 * The markers that say nothing is happening, which a list may leave undrawn.
 *
 * A dot earns its place by reporting that something is under way or that
 * somebody is owed an answer. `completed` and `scheduled` report neither: one
 * run has finished and the next has not begun, which is the resting condition
 * of every work stream a person is not currently watching. Drawn on a list,
 * they mark the ordinary as though it were news.
 *
 * This is a predicate rather than a condition inside a component so the two
 * quiet states cannot drift apart surface by surface, the same reason
 * `MARKER_PRECEDENCE` is a single array. A surface still decides whether to
 * honour it: the work-stream header names the run's state in words, and there
 * a resting run is exactly what somebody opened the header to read.
 */
export function workstreamMarkerIsQuiet(status: WorkstreamMarkerStatus): boolean {
  return status === 'completed' || status === 'scheduled';
}

/**
 * Whether somebody has put this work stream in front of this person.
 *
 * The **Needs attention** section's membership rule: they were added to it,
 * named in it, or asked a question by its agent. Not "everything only they can
 * clear" — that was the rule until unread swamped the section, and unread is
 * squarely something only they can clear. What separates the three is that a
 * person is behind each one, which is what makes a short list worth reading.
 */
export function workstreamNeedsAttention(
  // `hasUnread` is accepted and deliberately not read. Callers pass a whole
  // work stream, and the tests pass the field explicitly to state that being
  // unread does not put a row in this section — a signature that refused it
  // could not say that.
  workstream: { harnessStatus: HarnessStatus; hasUnread?: boolean; unseen?: boolean; youAreMentioned?: boolean },
): boolean {
  // Asked of the states rather than of the marker, so a work stream whose dot
  // shows something else can still be listed: a room somebody was added to
  // reads as `unseen` here whatever its run is doing.
  //
  // What dropping unread cost, for whoever considers putting it back: it is
  // the ordinary condition of a work stream somebody is working in, so a person
  // with a normal backlog saw most of what they had listed here and the one
  // mention among them was indistinguishable from the rest. The sidebar still
  // marks unread, in its own colour.
  return workstream.unseen === true
    || workstream.youAreMentioned === true
    || workstream.harnessStatus === 'needs_input';
}

export type RecencyGroup = 'Last hour' | 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Before this month';

const hourInMilliseconds = 3_600_000;

/** The next instant when a recency heading can change without new data. */
export function nextRecencyBoundary(
  items: ReadonlyArray<{ lastActivityAt: string }>,
  now = new Date(),
): number {
  const nowTimestamp = now.getTime();
  let next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  ).getTime();
  for (const item of items) {
    const timestamp = activityTimestamp(item);
    const leavesLastHourAt = timestamp + hourInMilliseconds;
    if (Number.isFinite(leavesLastHourAt) && leavesLastHourAt > nowTimestamp) {
      next = Math.min(next, leavesLastHourAt);
    }
  }
  return next;
}

/** The server-side range that describes one visible recency heading. */
export function recencyGroupBatchFilter(
  label: RecencyGroup,
  now = new Date(),
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
  return { lastActivityAt: range, pinned: false, includeSystem: false };
}

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
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const startOfWeek = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  ).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const ordered = [...items].sort(
    (a, b) => activityTimestamp(b) - activityTimestamp(a),
  );

  for (const stream of ordered) {
    let label: RecencyGroup;
    const timestamp = activityTimestamp(stream);
    if (timestamp >= nowTimestamp - hourInMilliseconds) label = 'Last hour';
    else if (timestamp >= startOfToday) label = 'Today';
    else if (timestamp >= startOfYesterday) label = 'Yesterday';
    else if (timestamp >= startOfWeek) label = 'This week';
    else if (timestamp >= startOfMonth) label = 'This month';
    else label = 'Before this month';
    groups.set(label, [...(groups.get(label) ?? []), stream]);
  }

  const priority: RecencyGroup[] = [
    'Last hour',
    'Today',
    'Yesterday',
    'This week',
    'This month',
    'Before this month',
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
