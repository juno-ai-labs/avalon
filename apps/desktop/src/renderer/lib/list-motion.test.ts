import { describe, expect, it } from 'vitest';
import {
  LIST_MOTION,
  LIST_MOTION_TOTAL_MS,
  longestIncreasingRun,
  moverKeyframes,
  planListMotion,
  shifterKeyframes,
  translationOf,
} from './list-motion';

const ROW = 48;

/** Rows laid out top to bottom in the given order, one slot each. */
function laidOut(keys: string[], hold: string[] = []): Array<{ key: string; top: number; hold: boolean }> {
  return keys.map((key, index) => ({ key, top: index * ROW, hold: hold.includes(key) }));
}

function seen(keys: string[]): Map<string, { top: number }> {
  return new Map(keys.map((key, index) => [key, { top: index * ROW }]));
}

describe('longestIncreasingRun', () => {
  it('finds the positions of one longest strictly increasing run', () => {
    expect(longestIncreasingRun([2, 0, 1, 3])).toEqual([1, 2, 3]);
    expect(longestIncreasingRun([3, 2, 0, 1])).toEqual([2, 3]);
    expect(longestIncreasingRun([])).toEqual([]);
    expect(longestIncreasingRun([5])).toEqual([0]);
  });
});

describe('planListMotion', () => {
  it('names the one row that moved and shifts only the rows it passed', () => {
    const plan = planListMotion(seen(['a', 'b', 'c', 'd']), laidOut(['c', 'a', 'b', 'd']));
    expect(plan.movers).toEqual([{ key: 'c', fromX: 0, fromY: 2 * ROW }]);
    expect(plan.shifters).toEqual([
      { key: 'a', fromX: 0, fromY: -ROW },
      { key: 'b', fromX: 0, fromY: -ROW },
    ]);
  });

  it('names two rows that moved together rather than everything they passed', () => {
    const plan = planListMotion(seen(['a', 'b', 'c', 'd']), laidOut(['d', 'c', 'a', 'b']));
    expect(plan.movers.map((mover) => mover.key)).toEqual(['d', 'c']);
    expect(plan.shifters.map((shifter) => shifter.key)).toEqual(['a', 'b']);
  });

  it('plans nothing for a list that did not change', () => {
    expect(planListMotion(seen(['a', 'b']), laidOut(['a', 'b']))).toEqual({ movers: [], shifters: [] });
  });

  it('leaves a row it has never seen alone, and still shifts the rows it displaced', () => {
    const plan = planListMotion(seen(['a', 'b']), laidOut(['new', 'a', 'b']));
    expect(plan.movers).toEqual([]);
    expect(plan.shifters).toEqual([
      { key: 'a', fromX: 0, fromY: -ROW },
      { key: 'b', fromX: 0, fromY: -ROW },
    ]);
  });

  it('shifts a row that moved between two containers the same way, by its measured positions', () => {
    // A pin: the row leaves the recent list far down the sidebar for the
    // pinned section at the top, and the rows above its old slot move down.
    const before = new Map([['p', { top: 0 }], ['a', { top: 100 }], ['b', { top: 148 }], ['c', { top: 196 }]]);
    const after = [
      { key: 'p', top: 0 }, { key: 'c', top: 48 }, { key: 'a', top: 148 }, { key: 'b', top: 196 },
    ];
    const plan = planListMotion(before, after);
    expect(plan.movers).toEqual([{ key: 'c', fromX: 0, fromY: 148 }]);
    expect(plan.shifters).toEqual([
      { key: 'a', fromX: 0, fromY: -48 },
      { key: 'b', fromX: 0, fromY: -48 },
    ]);
  });

  it('never makes a held row the one that moved, whatever passed it', () => {
    // A heading between two rows: the row below it moves above it, and the
    // heading — held — shifts down rather than being sent out and back.
    const plan = planListMotion(seen(['a', 'heading', 'b']), laidOut(['heading', 'a', 'b'], ['heading']));
    expect(plan.movers).toEqual([]);
    expect(plan.shifters).toEqual([
      { key: 'heading', fromX: 0, fromY: ROW },
      { key: 'a', fromX: 0, fromY: -ROW },
    ]);
    // The same with a row that does pass another: the heading still only shifts.
    const passed = planListMotion(seen(['heading', 'a', 'b']), laidOut(['b', 'heading', 'a'], ['heading']));
    expect(passed.movers).toEqual([{ key: 'b', fromX: 0, fromY: 2 * ROW }]);
    expect(passed.shifters.map((shifter) => shifter.key)).toEqual(['heading', 'a']);
  });

  it('places a held row like a neighbour instead of moving it', () => {
    const plan = planListMotion(seen(['a', 'b', 'c']), laidOut(['c', 'a', 'b'], ['c']));
    expect(plan.movers).toEqual([]);
    expect(plan.shifters).toEqual([
      { key: 'c', fromX: 0, fromY: 2 * ROW },
      { key: 'a', fromX: 0, fromY: -ROW },
      { key: 'b', fromX: 0, fromY: -ROW },
    ]);
  });

  it('starts from where an interrupted animation had got to', () => {
    const before = new Map([['a', { top: 0, x: -30, y: 20 }], ['b', { top: ROW }]]);
    const plan = planListMotion(before, laidOut(['a', 'b']));
    expect(plan.movers).toEqual([]);
    expect(plan.shifters).toEqual([{ key: 'a', fromX: -30, fromY: 20 }]);
  });
});

describe('keyframes', () => {
  it('takes a moved row out to the left from its old slot, parks it, and brings it in at the new one', () => {
    const { keyframes, options } = moverKeyframes({ fromX: 0, fromY: 96 }, -300);
    expect(options).toEqual({ duration: LIST_MOTION_TOTAL_MS, fill: 'backwards' });
    const exitEnd = LIST_MOTION.exitMs / LIST_MOTION_TOTAL_MS;
    const enterStart = (LIST_MOTION.exitMs + LIST_MOTION.enterStaggerMs) / LIST_MOTION_TOTAL_MS;
    expect(keyframes).toEqual([
      { offset: 0, transform: 'translate(0px, 96px)', easing: LIST_MOTION.exitEasing },
      { offset: exitEnd, transform: 'translate(-300px, 96px)' },
      { offset: exitEnd, transform: 'translate(-300px, 0px)', easing: 'linear' },
      { offset: enterStart, transform: 'translate(-300px, 0px)', easing: LIST_MOTION.enterEasing },
      { offset: 1, transform: 'translate(0px, 0px)' },
    ]);
    // The row is back on its way in while its neighbours are still closing
    // the gap: the three run together, with only the stagger between the
    // row leaving and returning.
    expect(LIST_MOTION.exitMs + LIST_MOTION.enterStaggerMs).toBeLessThan(LIST_MOTION.shiftMs);
  });

  it('shifts a displaced row straight over, from the same first frame as everything else', () => {
    expect(shifterKeyframes({ fromX: 0, fromY: -48 })).toEqual({
      keyframes: [{ transform: 'translate(0px, -48px)' }, { transform: 'translate(0px, 0px)' }],
      options: { duration: LIST_MOTION.shiftMs, easing: LIST_MOTION.shiftEasing, fill: 'backwards' },
    });
  });
});

describe('translationOf', () => {
  it('reads the translation out of a computed 2D matrix and nothing else', () => {
    expect(translationOf('matrix(1, 0, 0, 1, -30.5, 20)')).toEqual({ x: -30.5, y: 20 });
    expect(translationOf('none')).toEqual({ x: 0, y: 0 });
    expect(translationOf('')).toEqual({ x: 0, y: 0 });
    expect(translationOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)')).toEqual({ x: 0, y: 0 });
  });
});
