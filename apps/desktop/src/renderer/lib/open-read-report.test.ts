import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useOpenReadReport } from './open-read-report';
import { transcriptTurnsKey } from './transcript';

/** A snapshot of `turns` as `[sequence, revision, actor?, streaming?]`, all in the latest range. */
function snapshot(turns: Array<[number, number, ('assistant' | 'human' | 'system')?, boolean?]>): WorkstreamTranscriptSnapshot {
  return {
    snapshotId: 's', snapshotThrough: turns.length, eventSequence: 1, snapshotAtUtc: '2026-11-08T10:00:00.000Z',
    unreadAnchorSequence: null, unreadReason: 'no_unread',
    ranges: [{ purpose: 'latest', requested: { startInclusive: 1, endExclusive: turns.length + 1 },
      covered: { startInclusive: 1, endExclusive: turns.length + 1 },
      turns: turns.map(([transcriptSequence, revision, actor = 'assistant', streaming = false]) => ({
        transcriptSequence, turnId: `turn-${transcriptSequence}`, entryKind: 'conversation' as const,
        actor, authorUserId: actor === 'human' ? 'user-adam' : null, authorSnapshot: null, attentionOrdinal: null,
        createdAtUtc: '2026-11-08T10:00:00.000Z', revision,
        blocks: [{ type: 'text' as const, blockId: `turn-${transcriptSequence}:text:0`, blockIndex: 0, text: '', streaming }],
        activityId: null,
      })),
      activities: [], pluginRuns: [] }],
    pluginRuns: [], activities: [], activeActivities: [], activeTurns: [], pendingInputs: [],
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

  it('owes one more report when a turn settles or a settled one is revised, and none for a re-delivery', () => {
    const { rerender, result } = renderHook(
      ({ data }) => useOpenReadReport('sidekick-1:0', transcriptTurnsKey(data)),
      { initialProps: { data: snapshot([[1, 1], [2, 1, 'system']]) } },
    );
    result.current.markReported();
    // The same turns delivered again, as a reconnect does.
    rerender({ data: snapshot([[1, 1], [2, 1, 'system']]) });
    expect(result.current.reported()).toBe(true);
    // The run's row finishes in place: the same sequence at a newer revision.
    rerender({ data: snapshot([[1, 1], [2, 2, 'system']]) });
    expect(result.current.reported()).toBe(false);
    result.current.markReported();
    // A turn with a block still streaming is live, and counts for nothing yet.
    expect(transcriptTurnsKey(snapshot([[1, 1], [2, 2, 'system'], [3, 3, 'assistant', true]])))
      .toBe(transcriptTurnsKey(snapshot([[1, 1], [2, 2, 'system']])));
    // The viewer's own turn owes none: sending it moved their cursor.
    expect(transcriptTurnsKey(snapshot([[1, 1], [2, 2, 'system'], [4, 1, 'human']]), new Set(), 'user-adam'))
      .toBe(transcriptTurnsKey(snapshot([[1, 1], [2, 2, 'system']])));
  });

  it('owes one report for a streaming reply with three tool revisions, when it settles', () => {
    const settledBefore = snapshot([[1, 1], [2, 1, 'system']]);
    const { rerender, result } = renderHook(
      ({ data, live }) => useOpenReadReport('sidekick-1:0', transcriptTurnsKey(data, live)),
      { initialProps: { data: settledBefore, live: new Set<string>() } },
    );
    result.current.markReported();
    let owed = 0;
    for (const revision of [1, 2, 3]) {
      rerender({ data: snapshot([[1, 1], [2, 1, 'system'], [3, revision]]), live: new Set(['turn-3']) });
      if (!result.current.reported()) { owed += 1; result.current.markReported(); }
    }
    rerender({ data: snapshot([[1, 1], [2, 1, 'system'], [3, 4]]), live: new Set<string>() });
    if (!result.current.reported()) { owed += 1; result.current.markReported(); }
    expect(owed).toBe(1);
  });
});
