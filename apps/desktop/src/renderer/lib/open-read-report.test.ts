import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useOpenReadReport } from './open-read-report';
import { transcriptTurnsKey } from './transcript';

/** A snapshot of `turns` as `[sequence, revision]`, the newest one still active. */
function snapshot(turns: Array<[number, number]>): WorkstreamTranscriptSnapshot {
  const turn = ([transcriptSequence, revision]: [number, number]) => ({
    transcriptSequence, turnId: `turn-${transcriptSequence}`, entryKind: 'conversation' as const,
    actor: 'assistant' as const, authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
    createdAtUtc: '2026-11-08T10:00:00.000Z', revision, blocks: [], activityId: null,
  });
  const settled = turns.slice(0, -1).map(turn);
  return {
    snapshotId: 's', snapshotThrough: turns.length, eventSequence: 1, snapshotAtUtc: '2026-11-08T10:00:00.000Z',
    unreadAnchorSequence: null, unreadReason: 'no_unread',
    ranges: [{ purpose: 'latest', requested: { startInclusive: 1, endExclusive: turns.length + 1 },
      covered: { startInclusive: 1, endExclusive: turns.length + 1 }, turns: settled, activities: [], pluginRuns: [] }],
    pluginRuns: [], activities: [], activeActivities: [], activeTurns: turns.slice(-1).map(turn), pendingInputs: [],
  } as WorkstreamTranscriptSnapshot;
}

describe('useOpenReadReport', () => {
  it('owes one report per open of a conversation, and again after another was opened', () => {
    const { rerender, result } = renderHook(({ address }) => useOpenReadReport(address), { initialProps: { address: 'canvas-1:0' } });
    expect(result.current.reported()).toBe(false);
    result.current.markReported();
    expect(result.current.reported()).toBe(true);
    // A reconnect or a re-render of the same conversation is the same open.
    rerender({ address: 'canvas-1:0' });
    expect(result.current.reported()).toBe(true);
    rerender({ address: 'canvas-2:0' });
    expect(result.current.reported()).toBe(false);
    result.current.markReported();
    rerender({ address: 'canvas-1:0' });
    expect(result.current.reported()).toBe(false);
  });

  it('owes one more report when a turn is added or revised while the conversation is open, and none for a re-delivery', () => {
    const { rerender, result } = renderHook(
      ({ data }) => useOpenReadReport('sidekick-1:0', transcriptTurnsKey(data)),
      { initialProps: { data: snapshot([[1, 1], [2, 1]]) } },
    );
    result.current.markReported();
    // The same turns delivered again, as a reconnect does.
    rerender({ data: snapshot([[1, 1], [2, 1]]) });
    expect(result.current.reported()).toBe(true);
    // The run's row finishes in place: the same sequence at a newer revision.
    rerender({ data: snapshot([[1, 1], [2, 2]]) });
    expect(result.current.reported()).toBe(false);
    result.current.markReported();
    expect(result.current.reported()).toBe(true);
    // A new turn lands.
    rerender({ data: snapshot([[1, 1], [2, 2], [3, 1]]) });
    expect(result.current.reported()).toBe(false);
  });
});
