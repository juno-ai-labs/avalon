import { describe, expect, it } from 'vitest';
import {
  formatDayLabel,
  formatDuration,
  formatSparseRelativeDate,
  statusDescription,
  statusLabel,
  harnessMarkerStatus,
} from './format';

describe('presentation rules', () => {
  const localDate = (year: number, month: number, day: number, hour = 0, minute = 0): string => (
    new Date(year, month, day, hour, minute).toISOString()
  );

  it('does not describe a gray harness state as a finished project', () => {
    expect(statusLabel.completed).toBe('Latest run completed');
    expect(statusLabel.scheduled).toBe('Scheduled');
    expect(statusLabel.stopped).toBe('Latest run stopped');
  });

  it('presents a queued run as one already working, and leaves every other run alone', () => {
    expect(harnessMarkerStatus('scheduled')).toBe('running');
    expect(harnessMarkerStatus('running')).toBe('running');
    expect(harnessMarkerStatus('needs_input')).toBe('needs_input');
    expect(harnessMarkerStatus('completed')).toBe('completed');
    expect(harnessMarkerStatus('stopped')).toBe('stopped');
    expect(harnessMarkerStatus('failed')).toBe('failed');
    // The running marker now speaks for a queued run as well, so its tooltip
    // must not claim the agent is at work in this moment.
    expect(statusDescription.running).not.toMatch(/\bnow\b/u);
  });

  it('formats concise task durations', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(8_000)).toBe('8s');
    expect(formatDuration(125_000)).toBe('2m 05s');
  });

  it('labels a timestamp with a sparse calendar bucket', () => {
    // Sunday 30 Aug 2026, 15:00 local. Week starts Sunday here, same as the
    // recency groups, so "this week" on a Sunday is only today — which already
    // has a more specific label.
    const now = new Date(2026, 7, 30, 15);

    expect(formatSparseRelativeDate(localDate(2026, 7, 30, 9), now)).toBe('today');
    expect(formatSparseRelativeDate(localDate(2026, 7, 29, 18), now)).toBe('yesterday');
    expect(formatSparseRelativeDate(localDate(2026, 7, 23, 12), now)).toBe('last week');
    expect(formatSparseRelativeDate(localDate(2026, 7, 22, 12), now)).toBe('this month');
    expect(formatSparseRelativeDate(localDate(2026, 6, 15, 12), now)).toBe('last month');
    expect(formatSparseRelativeDate(localDate(2025, 7, 1, 12), now)).toBe('Aug 2025');
    expect(formatSparseRelativeDate('not-a-date', now)).toBe('Unknown time');
    // A server stamp ahead of the desktop clock used to fall through an
    // unbounded "this month" and group next year with August.
    expect(formatSparseRelativeDate(localDate(2026, 7, 31, 9), now)).toBe('this month');
    expect(formatSparseRelativeDate(localDate(2026, 8, 1, 9), now)).toBe('Sep 2026');
    expect(formatSparseRelativeDate(localDate(2027, 0, 1, 9), now)).toBe('Jan 2027');
  });

  it('lets this week win over this month for a weekday that is neither today nor yesterday', () => {
    // Wednesday 5 Aug 2026. Sunday 2 Aug is this week, not last week, and not
    // merely this month.
    const now = new Date(2026, 7, 5, 15);

    expect(formatSparseRelativeDate(localDate(2026, 7, 5, 9), now)).toBe('today');
    expect(formatSparseRelativeDate(localDate(2026, 7, 4, 9), now)).toBe('yesterday');
    expect(formatSparseRelativeDate(localDate(2026, 7, 2, 9), now)).toBe('this week');
    expect(formatSparseRelativeDate(localDate(2026, 6, 30, 9), now)).toBe('last week');
    expect(formatSparseRelativeDate(localDate(2026, 7, 1, 9), now)).toBe('last week');
    expect(formatSparseRelativeDate(localDate(2026, 6, 15, 9), now)).toBe('last month');
  });
});

describe('formatDayLabel', () => {
  const now = new Date(2026, 9, 12, 9, 30);

  it('names today and yesterday by local calendar day, not by 24 hours', () => {
    expect(formatDayLabel(new Date(2026, 9, 12, 0, 5).toISOString(), now)).toBe('Today');
    expect(formatDayLabel(new Date(2026, 9, 11, 23, 55).toISOString(), now)).toBe('Yesterday');
    expect(formatDayLabel(new Date(2026, 9, 11, 0, 0).toISOString(), now)).toBe('Yesterday');
  });

  it('says an unreadable time is unknown rather than inventing a day', () => {
    expect(formatDayLabel('not a date', now)).toBe('Unknown time');
  });
});
