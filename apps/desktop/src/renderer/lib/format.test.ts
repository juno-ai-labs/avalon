import { describe, expect, it } from 'vitest';
import { formatDuration, groupWorkstreams, statusLabel } from './format';
import type { WorkstreamSummary } from './types';

function stream(
  id: string,
  harnessStatus: WorkstreamSummary['harnessStatus'],
  lastActivityAt: string,
): WorkstreamSummary {
  return {
    id,
    title: id,
    origin: 'ad_hoc',
    harnessStatus,
    lastActivityAt,
  };
}

describe('work-stream presentation rules', () => {
  const now = new Date('2026-07-31T20:00:00.000Z');

  it('groups and orders work streams only by their latest activity', () => {
    const groups = groupWorkstreams(
      [
        stream('month-old-running', 'running', '2026-07-10T12:00:00.000Z'),
        stream('day-newer-failed', 'failed', '2026-07-31T08:00:00.000Z'),
        stream('rest', 'needs_input', '2026-06-12T12:00:00.000Z'),
        stream('hour-older', 'completed', '2026-07-31T19:20:00.000Z'),
        stream('week', 'scheduled', '2026-07-28T12:00:00.000Z'),
        stream('hour-newer', 'completed', '2026-07-31T19:55:00.000Z'),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Last hour',
      'Last day',
      'Last week',
      'This month',
      'The rest',
    ]);
    expect(groups[0]?.streams.map((item) => item.id)).toEqual(['hour-newer', 'hour-older']);
    expect(groups.flatMap((group) => group.streams.map((item) => item.id))).toEqual([
      'hour-newer',
      'hour-older',
      'day-newer-failed',
      'week',
      'month-old-running',
      'rest',
    ]);
  });

  it('uses rolling recency boundaries and omits empty sections', () => {
    const groups = groupWorkstreams(
      [
        stream('one-hour', 'completed', '2026-07-31T19:00:00.000Z'),
        stream('one-day', 'completed', '2026-07-30T20:00:00.000Z'),
        stream('one-week', 'completed', '2026-07-24T20:00:00.000Z'),
        stream('invalid', 'completed', 'not-a-date'),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual(['Last hour', 'Last day', 'Last week', 'The rest']);
    expect(groups.map((group) => group.streams[0]?.id)).toEqual(['one-hour', 'one-day', 'one-week', 'invalid']);
  });

  it('does not describe a gray harness state as a finished project', () => {
    expect(statusLabel.completed).toBe('Latest run completed');
    expect(statusLabel.scheduled).toBe('Scheduled');
  });

  it('formats concise task durations', () => {
    expect(formatDuration(8_000)).toBe('8s');
    expect(formatDuration(125_000)).toBe('2m 05s');
  });
});
