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
 * showing. `scheduled` has no personal state to lose to and is not in the
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
 * Whether this work stream is asking something of this person.
 *
 * The **Needs attention** section's membership rule, beside the ranking it is
 * a subset of: everything a person is the only one who can clear. A run that
 * is merely working is not one of them, however recently it moved.
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
  // `hasUnread` is deliberately not one of them. It was, and it drowned the
  // section: unread is the ordinary condition of a work stream somebody is
  // working in, so a person with a normal backlog saw most of what they had
  // listed here, and the one mention among them was indistinguishable from the
  // rest. The three that remain each name somebody by hand — you were put in
  // this room, you were named in it, or the agent stopped and asked you
  // something — which is what makes the section short enough to be read. The
  // sidebar still marks unread, in its own colour; this section is for the
  // subset that is addressed to this person.
  return workstream.unseen === true
    || workstream.youAreMentioned === true
    || workstream.harnessStatus === 'needs_input';
}

export type RecencyGroup = 'Last hour' | 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Before this month';

const hourInMilliseconds = 3_600_000;

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
