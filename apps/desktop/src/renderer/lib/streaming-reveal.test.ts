import { describe, expect, it } from 'vitest';
import {
  advanceStreamReveal,
  alignRevealBoundary,
  applyRevealedText,
  flushStreamReveal,
  revealBudget,
  recordStreamArrival,
  STREAM_REVEAL_DRAIN_MS,
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
  it('reveals the backlog proportionally to elapsed time over the drain window', () => {
    expect(revealBudget(STREAM_REVEAL_DRAIN_MS, STREAM_REVEAL_DRAIN_MS / 2)).toBe(STREAM_REVEAL_DRAIN_MS / 2);
    expect(revealBudget(1_000, STREAM_REVEAL_DRAIN_MS)).toBe(1_000);
  });

  it('does not advance without elapsed time', () => {
    expect(revealBudget(3, 0)).toBe(0);
  });

  it('never reveals more than the backlog and nothing for an empty one', () => {
    expect(revealBudget(2, 10 * STREAM_REVEAL_DRAIN_MS)).toBe(2);
    expect(revealBudget(0, 100)).toBe(0);
  });
});

describe('advanceStreamReveal', () => {
  it('advances the revealed prefix and reports remaining backlog', () => {
    const cursors = new Map([['message-one', cursor({ receivedText: 'x'.repeat(STREAM_REVEAL_DRAIN_MS) })]]);
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
