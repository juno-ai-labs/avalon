import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  groupWorkstreams,
  nextRecencyBoundary,
  recencyGroupBatchFilter,
  statusLabel,
  workstreamMarkerStatus,
  workstreamNeedsAttention,
} from './format';
import type { WorkstreamSummary } from './types';

function stream(
  id: string,
  harnessStatus: WorkstreamSummary['harnessStatus'],
  lastActivityAt: string,
): WorkstreamSummary {
  return {
    id,
    title: id,
    titleStatus: 'settled' as const,
    origin: 'ad_hoc',
    harnessStatus,
    scope: 'workspace',
    lastActivityAt,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
  };
}

describe('work-stream presentation rules', () => {
  const localDate = (year: number, month: number, day: number, hour = 0, minute = 0): string => (
    new Date(year, month, day, hour, minute).toISOString()
  );
  const now = new Date(2026, 7, 7, 10, 30);

  it('groups and orders work streams only by their latest activity', () => {
    const groups = groupWorkstreams(
      [
        stream('month-old-running', 'running', localDate(2026, 7, 1, 12)),
        stream('today-failed', 'failed', localDate(2026, 7, 7, 8)),
        stream('before-month', 'needs_input', localDate(2026, 6, 31, 23, 59)),
        stream('hour-older', 'completed', localDate(2026, 7, 7, 10)),
        stream('yesterday', 'scheduled', localDate(2026, 7, 6, 12)),
        stream('week', 'scheduled', localDate(2026, 7, 2, 12)),
        stream('hour-newer', 'completed', localDate(2026, 7, 7, 10, 25)),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Last hour',
      'Today',
      'Yesterday',
      'This week',
      'This month',
      'Before this month',
    ]);
    expect(groups[0]?.streams.map((item) => item.id)).toEqual(['hour-newer', 'hour-older']);
    expect(groups.flatMap((group) => group.streams.map((item) => item.id))).toEqual([
      'hour-newer',
      'hour-older',
      'today-failed',
      'yesterday',
      'week',
      'month-old-running',
      'before-month',
    ]);
  });

  it('uses exact local-time calendar boundaries and omits empty sections', () => {
    const groups = groupWorkstreams(
      [
        stream('one-hour', 'completed', localDate(2026, 7, 7, 9, 30)),
        stream('today', 'completed', localDate(2026, 7, 7)),
        stream('yesterday', 'completed', localDate(2026, 7, 6)),
        stream('week-start', 'completed', localDate(2026, 7, 2)),
        stream('month-start', 'completed', localDate(2026, 7, 1)),
        stream('before-month', 'completed', localDate(2026, 6, 31, 23, 59)),
        stream('invalid', 'completed', 'not-a-date'),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Last hour',
      'Today',
      'Yesterday',
      'This week',
      'This month',
      'Before this month',
    ]);
    expect(groups.flatMap((group) => group.streams.map((item) => item.id))).toEqual([
      'one-hour',
      'today',
      'yesterday',
      'week-start',
      'month-start',
      'before-month',
      'invalid',
    ]);
  });

  it('describes recency headings as generic half-open batch filters', () => {
    expect(recencyGroupBatchFilter('This week', now)).toEqual({
      lastActivityAt: {
        atOrAfter: localDate(2026, 7, 2),
        before: localDate(2026, 7, 6),
      },
      pinned: false,
      includeSystem: false,
    });
    expect(recencyGroupBatchFilter('Before this month', now)).toEqual({
      lastActivityAt: { before: localDate(2026, 7, 1) },
      pinned: false,
      includeSystem: false,
    });
  });

  it('names the first data-free boundary that can move a row', () => {
    expect(nextRecencyBoundary([
      { lastActivityAt: localDate(2026, 7, 7, 10, 0) },
      { lastActivityAt: localDate(2026, 7, 6, 12, 0) },
    ], now)).toBe(new Date(2026, 7, 7, 11, 0).getTime());
  });

  it('does not describe a gray harness state as a finished project', () => {
    expect(statusLabel.completed).toBe('Latest run completed');
    expect(statusLabel.scheduled).toBe('Scheduled');
    expect(statusLabel.stopped).toBe('Latest run stopped');
  });

  it('ranks the states a work stream can show one person, most urgent first', () => {
    const running = { harnessStatus: 'running' as const };

    // Every pair the ranking actually decides, walked down the order: each
    // state beats the one below it while both are true.
    expect(workstreamMarkerStatus({ ...running, unseen: true, youAreMentioned: true, hasUnread: true }))
      .toBe('unseen');
    expect(workstreamMarkerStatus({ ...running, youAreMentioned: true, hasUnread: true })).toBe('mentioned');
    expect(workstreamMarkerStatus({ ...running, hasUnread: true })).toBe('running');
    expect(workstreamMarkerStatus({ harnessStatus: 'needs_input', hasUnread: true })).toBe('needs_input');
    expect(workstreamMarkerStatus({ harnessStatus: 'completed', hasUnread: true })).toBe('unread');
    expect(workstreamMarkerStatus({ harnessStatus: 'stopped', hasUnread: true })).toBe('unread');
    expect(workstreamMarkerStatus({ harnessStatus: 'failed', hasUnread: true })).toBe('unread');
    // Nothing personal is true, so the run answers for itself — including the
    // one state the ranking does not mention.
    expect(workstreamMarkerStatus({ harnessStatus: 'scheduled' })).toBe('scheduled');
    expect(workstreamMarkerStatus({ harnessStatus: 'failed' })).toBe('failed');
  });

  it('asks for attention only where somebody named this person: unseen, mentioned, needs_input', () => {
    expect(workstreamNeedsAttention({ harnessStatus: 'needs_input' })).toBe(true);
    expect(workstreamNeedsAttention({ harnessStatus: 'completed', unseen: true })).toBe(true);
    expect(workstreamNeedsAttention({ harnessStatus: 'completed', youAreMentioned: true })).toBe(true);
    // Unread on its own is the ordinary condition of a work stream somebody is
    // working in. Listing it here buried the states that are addressed to this
    // person among everything they simply had not got to yet.
    expect(workstreamNeedsAttention({ harnessStatus: 'running', hasUnread: true })).toBe(false);
    expect(workstreamNeedsAttention({ harnessStatus: 'completed', hasUnread: true })).toBe(false);
    // Unread beside one of the three still qualifies — on their account, and
    // for each of them, not just the one that happened to get a test.
    expect(workstreamNeedsAttention({ harnessStatus: 'completed', hasUnread: true, unseen: true })).toBe(true);
    expect(workstreamNeedsAttention({ harnessStatus: 'completed', hasUnread: true, youAreMentioned: true })).toBe(true);
    expect(workstreamNeedsAttention({ harnessStatus: 'needs_input', hasUnread: true })).toBe(true);
    expect(workstreamNeedsAttention({ harnessStatus: 'running' })).toBe(false);
    expect(workstreamNeedsAttention({ harnessStatus: 'failed' })).toBe(false);
  });

  it('formats concise task durations', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(8_000)).toBe('8s');
    expect(formatDuration(125_000)).toBe('2m 05s');
  });
});
