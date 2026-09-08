import { describe, expect, it } from 'vitest';
import {
  advanceStreamReveal,
  alignRevealBoundary,
  applyRevealedText,
  flushStreamReveal,
  revealBudget,
  recordStreamArrival,
  STREAM_REVEAL_CADENCE_MS,
} from './streaming-reveal';
import type { Message } from './types';
import type { StreamCursor } from './workstream-socket-resume';

function cursor(overrides: Partial<StreamCursor> = {}): StreamCursor {
  return {
    streamId: 'stream-one',
    turnId: 'turn-one',
    epoch: 0,
    streamSeq: 1,
    seenTurnIds: new Set(['turn-one']),
    turnStartText: '',
    roomSequence: 1,
    completed: false,
    receivedText: '',
    revealed: 0,
    lastRevealAt: null,
    ...overrides,
  };
}

function streamingMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-one',
    workstreamId: 'workstream-one',
    sequenceNumber: 1,
    authorType: 'agent',
    messageType: 'text',
    text: '',
    createdAt: '2026-08-23T12:00:00.000Z',
    streaming: true,
    ...overrides,
  };
}

describe('revealBudget', () => {
  it('integrates the explicit draw rate over elapsed time', () => {
    expect(revealBudget(STREAM_REVEAL_CADENCE_MS, STREAM_REVEAL_CADENCE_MS / 2, 1)).toBe(STREAM_REVEAL_CADENCE_MS / 2);
    expect(revealBudget(1_000, STREAM_REVEAL_CADENCE_MS, 10)).toBe(1_000);
  });

  it('does not advance without elapsed time', () => {
    expect(revealBudget(3, 0, 1)).toBe(0);
  });

  it('never reveals more than the backlog and nothing for an empty one', () => {
    expect(revealBudget(2, 10 * STREAM_REVEAL_CADENCE_MS, 1)).toBe(2);
    expect(revealBudget(0, 100, 1)).toBe(0);
  });
});

describe('advanceStreamReveal', () => {
  it('advances the revealed prefix and reports remaining backlog', () => {
    const cursors = new Map([['message-one', cursor({ receivedText: 'x'.repeat(STREAM_REVEAL_CADENCE_MS) })]]);
    const first = advanceStreamReveal(cursors, 1_000);
    expect(first).toEqual({ changed: true, backlogRemains: true });
    const advanced = cursors.get('message-one')!;
    expect(advanced.revealed).toBeGreaterThan(0);
    expect(advanced.revealed).toBeLessThan(advanced.receivedText.length);
    expect(advanced.lastRevealAt).toBe(1_000);
  });

  it('reveals almost nothing extra when a second loop ticks in the same frame', () => {
    // The foreground and background hook instances share one cursor map, so
    // two reveal loops can both tick it. The rate integrates over the time
    // since the last advance, which makes the second tick nearly free instead
    // of doubling the reveal speed.
    const cursors = new Map([['message-one', cursor({ receivedText: 'x'.repeat(2_000) })]]);
    advanceStreamReveal(cursors, 1_000);
    const afterFirst = cursors.get('message-one')!.revealed;
    advanceStreamReveal(cursors, 1_000);
    expect(cursors.get('message-one')!.revealed).toBe(afterFirst);
  });

  it('skips completed cursors and clears the clock on a drained one', () => {
    const done = cursor({ completed: true, receivedText: 'held back', revealed: 0 });
    const drained = cursor({ receivedText: 'all shown', revealed: 'all shown'.length, lastRevealAt: 500 });
    const cursors = new Map([['done', done], ['drained', drained]]);
    expect(advanceStreamReveal(cursors, 1_000)).toEqual({ changed: false, backlogRemains: false });
    expect(done.revealed).toBe(0);
    expect(drained.lastRevealAt).toBeNull();
  });
});

describe('alignRevealBoundary', () => {
  it('steps past a split surrogate pair and leaves whole characters alone', () => {
    const text = 'A😀B';
    // Index 2 lands between the emoji's high and low surrogates.
    expect(alignRevealBoundary(text, 2)).toBe(3);
    expect(alignRevealBoundary(text, 1)).toBe(1);
    expect(alignRevealBoundary(text, 3)).toBe(3);
    expect(alignRevealBoundary(text, 0)).toBe(0);
    expect(alignRevealBoundary(text, text.length)).toBe(text.length);
  });

  it('never exposes an unpaired surrogate through repeated one-unit ticks', () => {
    const cursors = new Map([['message-one', cursor({ receivedText: 'A😀B😀C' })]]);
    const seen: string[] = [];
    // Small budgets must still preserve surrogate pairs.
    for (let tick = 0; tick < 12; tick += 1) {
      advanceStreamReveal(cursors, 1_000 + tick * 17);
      const current = cursors.get('message-one')!;
      seen.push(current.receivedText.slice(0, current.revealed));
    }
    for (const prefix of seen) {
      const last = prefix.charCodeAt(prefix.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(seen.at(-1)).toBe('A😀B😀C');
  });
});

describe('flushStreamReveal', () => {
  it('reveals everything held back and says whether anything was', () => {
    const held = cursor({ receivedText: 'the whole reply', revealed: 4, lastRevealAt: 100 });
    const cursors = new Map([['message-one', held]]);
    expect(flushStreamReveal(cursors)).toBe(true);
    expect(held.revealed).toBe(held.receivedText.length);
    expect(held.lastRevealAt).toBeNull();
    expect(flushStreamReveal(cursors)).toBe(false);
  });
});

describe('applyRevealedText', () => {
  it('writes each streaming message its revealed prefix', () => {
    const messages = [streamingMessage()];
    const cursors = new Map([['message-one', cursor({ receivedText: 'Hello world', revealed: 5 })]]);
    expect(applyRevealedText(messages, cursors)[0]?.text).toBe('Hello');
  });

  it('returns the array untouched when nothing visible changed', () => {
    const settled = streamingMessage({ id: 'message-two', streaming: false, text: 'Done.' });
    const current = streamingMessage({ text: 'Hel' });
    const messages = [settled, current];
    const cursors = new Map([['message-one', cursor({ receivedText: 'Hello', revealed: 3 })]]);
    expect(applyRevealedText(messages, cursors)).toBe(messages);
  });

  it('leaves completed cursors and cursorless messages alone', () => {
    const completed = streamingMessage({ text: 'canonical text' });
    const cursors = new Map([['message-one', cursor({ completed: true, receivedText: 'stale', revealed: 1 })]]);
    expect(applyRevealedText([completed], cursors)).toEqual([completed]);
    expect(applyRevealedText([streamingMessage({ id: 'unknown', text: 'kept' })], new Map())[0]?.text).toBe('kept');
  });
});

describe('arrival-rate pacing', () => {
  it('drains a packet at its measured rate without an exponential tail', () => {
    const current = cursor({ receivedText: 'x'.repeat(100), pacing: recordStreamArrival(undefined, 100, 100, 0), lastRevealAt: 0 });
    const cursors = new Map([['one', current]]);
    for (let now = 10; now <= 100; now += 10) advanceStreamReveal(cursors, now);
    expect(current.revealed).toBe(100);
  });

  it('follows a speedup and catches up within the next packet interval', () => {
    const slow = recordStreamArrival(undefined, 10, 10, 0);
    const fast = recordStreamArrival(slow, 100, 110, 100);
    const current = cursor({ receivedText: 'x'.repeat(110), pacing: fast, lastRevealAt: 100 });
    const cursors = new Map([['one', current]]);
    advanceStreamReveal(cursors, 150);
    expect(current.revealed).toBeGreaterThanOrEqual(55);
    advanceStreamReveal(cursors, 200);
    expect(current.revealed).toBe(110);
  });

  it('carries fractional characters equally at different refresh rates', () => {
    // Hold drawRate fixed to isolate integration from arrival estimation.
    const run = (step: number) => {
      const current = cursor({ receivedText: 'x'.repeat(100), pacing: { ...recordStreamArrival(undefined, 1, 1, 0), drawRate: 0.01 }, lastRevealAt: 0 });
      const cursors = new Map([['one', current]]);
      for (let now = step; now <= 1000; now += step) advanceStreamReveal(cursors, now);
      return current.revealed;
    };
    expect(run(10)).toBeGreaterThanOrEqual(9);
    expect(Math.abs(run(10) - run(20))).toBeLessThanOrEqual(1);
  });

  it('accumulates simultaneous arrivals without infinite rates', () => {
    const first = recordStreamArrival(undefined, 10, 10, 0);
    const simultaneous = recordStreamArrival(first, 20, 30, 0);
    expect(simultaneous.pendingCharacters).toBe(20);
    const next = recordStreamArrival(simultaneous, 10, 40, 100);
    expect(next.rate).toBeCloseTo(0.2);
    expect(next.pendingCharacters).toBe(0);
  });
});


describe('pacing across idle gaps', () => {
  it('parks both clocks and clears fractional credit on the draining frame', () => {
    const current = cursor({ receivedText: 'abc', lastRevealAt: 0,
      pacing: { ...recordStreamArrival(undefined, 3, 3, 0), credit: 0.5 } });
    expect(advanceStreamReveal(new Map([['one', current]]), 1000))
      .toEqual({ changed: true, backlogRemains: false });
    expect(current.lastRevealAt).toBeNull();
    expect(current.pacing?.credit).toBe(0);
    expect(current.pacing?.lastArrivalAt).toBeNull();
  });

  it.each([250, 2000, 10000])('does not learn a drained %ims gap as slow production', (gap) => {
    const current = cursor({ receivedText: 'x'.repeat(10), lastRevealAt: 0,
      pacing: recordStreamArrival(undefined, 10, 10, 0) });
    advanceStreamReveal(new Map([['one', current]]), 100);
    const resumed = recordStreamArrival(current.pacing, 10, 10, gap);
    expect(resumed.cadenceMs).toBe(100);
    expect(resumed.drawRate).toBeCloseTo(0.1);
  });

  it('uses the measured rate when a smaller packet follows a fast packet', () => {
    const first = recordStreamArrival(undefined, 100, 100, 0);
    const next = recordStreamArrival(first, 10, 10, 100);
    expect(next.rate).toBeGreaterThan(10 / next.cadenceMs);
    expect(next.drawRate).toBe(next.rate);
  });

  it('keeps sub-millisecond samples finite without a draw-speed ceiling', () => {
    let pacing = recordStreamArrival(undefined, 100, 100, 0);
    for (let i = 1; i <= 10; i += 1) {
      pacing = recordStreamArrival(pacing, 100, 100 * (i + 1), i * 0.001);
      expect(Number.isFinite(pacing.rate)).toBe(true);
      expect(pacing.rate).toBeLessThanOrEqual(i + 1);
    }
  });

  it('repays a surrogate unit before revealing the following character', () => {
    const current = cursor({ receivedText: '😀ab', lastRevealAt: 0,
      pacing: { ...recordStreamArrival(undefined, 4, 4, 0), drawRate: 0.01 } });
    const cursors = new Map([['one', current]]);
    advanceStreamReveal(cursors, 100);
    expect(current.revealed).toBe(2);
    expect(current.pacing?.credit).toBe(-1);
    advanceStreamReveal(cursors, 150);
    expect(current.revealed).toBe(2);
    advanceStreamReveal(cursors, 200);
    expect(current.revealed).toBe(2);
    advanceStreamReveal(cursors, 300);
    expect(current.revealed).toBe(3);
    advanceStreamReveal(cursors, 400);
    expect(current.revealed).toBe(4);
  });
});
