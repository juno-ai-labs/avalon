import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIST_MOTION,
  LIST_MOTION_TOTAL_MS,
  enterKeyframes,
  exitKeyframes,
  layoutInsertIndex,
  layoutRowAt,
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

  it('sends the row that changed group out and back, and shifts the row it passed in the group it joined', () => {
    // Leaving Needs input: v2 was alone under its heading, which goes; it
    // lands below t3, the newest row of the recent list. Either row alone
    // explains the swap, and the one that crossed the headings is the mover.
    const before = new Map([['needs', { top: 0 }], ['v2', { top: 48 }], ['pinned', { top: 96 }], ['all', { top: 144 }],
      ['t3', { top: 192 }], ['n', { top: 240 }]]);
    const leaving = planListMotion(before, [
      { key: 'pinned', top: 0, hold: true }, { key: 'all', top: 48, hold: true },
      { key: 't3', top: 96 }, { key: 'v2', top: 144 }, { key: 'n', top: 192 },
    ]);
    expect(leaving.movers).toEqual([{ key: 'v2', fromX: 0, fromY: -96 }]);
    expect(leaving.shifters.map((shifter) => [shifter.key, shifter.fromY])).toEqual([['pinned', 96], ['all', 96], ['t3', 96], ['n', 48]]);
    // Entering it: the same row crosses back above the headings, and t3
    // shifts up into the slot it left rather than leaving the frame.
    const entering = planListMotion(
      new Map([['pinned', { top: 0 }], ['all', { top: 48 }], ['t3', { top: 96 }], ['v2', { top: 144 }], ['n', { top: 192 }]]),
      [{ key: 'needs', top: 0, hold: true }, { key: 'v2', top: 48 }, { key: 'pinned', top: 96, hold: true },
        { key: 'all', top: 144, hold: true }, { key: 't3', top: 192 }, { key: 'n', top: 240 }],
    );
    expect(entering.movers).toEqual([{ key: 'v2', fromX: 0, fromY: 96 }]);
    expect(entering.shifters.map((shifter) => [shifter.key, shifter.fromY])).toEqual([['pinned', -96], ['all', -96], ['t3', -96], ['n', -48]]);
  });

  it('keeps the longest run first, and among the longest the heaviest', () => {
    expect(longestIncreasingRun([1, 0, 2], [3, 4, 3])).toEqual([1, 2]);
    expect(longestIncreasingRun([1, 0, 2], [4, 3, 3])).toEqual([0, 2]);
    expect(longestIncreasingRun([1, 0, 2, 3], [9, 1, 1, 1])).toEqual([0, 2, 3]);
  });

  it('ranks each scope on its own, so a block moving past another shifts as one', () => {
    // Two projects with two members each, the second project dragged above
    // the first: nothing changed place within either, so nothing leaves.
    const before = new Map([['p1', { top: 0 }], ['m1', { top: 48 }], ['m2', { top: 96 }], ['p2', { top: 144 }], ['n1', { top: 192 }]]);
    const after = [
      { key: 'p2', top: 0, hold: true }, { key: 'n1', top: 48, scope: 'project:2' },
      { key: 'p1', top: 96, hold: true }, { key: 'm1', top: 144, scope: 'project:1' }, { key: 'm2', top: 192, scope: 'project:1' },
    ];
    const plan = planListMotion(before, after);
    expect(plan.movers).toEqual([]);
    expect(plan.shifters.map((shifter) => [shifter.key, shifter.fromY])).toEqual([
      ['p2', 144], ['n1', 144], ['p1', -96], ['m1', -96], ['m2', -96],
    ]);
    // Ranked together instead, the members of one project would read as
    // having passed the other's and be sent out and back.
    const flat = planListMotion(before, after.map((row) => ({ ...row, scope: undefined })));
    expect(flat.movers).not.toEqual([]);
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

  // The mover's two halves on their own, for a row that only leaves or only
  // arrives. The exit is held at its end because a stand-in is removed by the
  // finish handler, a frame after; the entrance waits the exit and the
  // stagger so the rows below have opened the gap before it lands.
  it('exposes the exit held off frame, and the entrance parked for the length of an exit and the stagger', () => {
    expect(exitKeyframes({ fromX: 4, fromY: 48 }, -300)).toEqual({
      keyframes: [{ transform: 'translate(4px, 48px)', easing: LIST_MOTION.exitEasing }, { transform: 'translate(-300px, 48px)' }],
      options: { duration: LIST_MOTION.exitMs, fill: 'forwards' },
    });
    const enterStart = (LIST_MOTION.exitMs + LIST_MOTION.enterStaggerMs) / LIST_MOTION_TOTAL_MS;
    expect(enterKeyframes(-300)).toEqual({
      keyframes: [
        { offset: 0, transform: 'translate(-300px, 0px)', easing: 'linear' },
        { offset: enterStart, transform: 'translate(-300px, 0px)', easing: LIST_MOTION.enterEasing },
        { offset: 1, transform: 'translate(0px, 0px)' },
      ],
      options: { duration: LIST_MOTION_TOTAL_MS, fill: 'backwards' },
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

/** A row laid out at `top`, currently drawn `drawnOffBy` pixels away from it. */
function row(top: number, drawnOffBy = 0): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({
    top: top + drawnOffBy, bottom: top + drawnOffBy + ROW, height: ROW, left: 0, right: 100, width: 100, x: 0, y: top + drawnOffBy, toJSON: () => ({}),
  });
  element.dataset.drawnOffBy = String(drawnOffBy);
  return element;
}

/** Reads each row's drawn offset back as the transform its motion would apply. */
function drawnTransforms(): void {
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => ({
    transform: `matrix(1, 0, 0, 1, 0, ${(element as HTMLElement).dataset.drawnOffBy})`,
  }) as CSSStyleDeclaration);
}

describe('layoutRowAt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers by where a row is laid out, not where its motion has drawn it', () => {
    drawnTransforms();
    // `b` is laid out in the second slot but drawn half a slot lower, over the
    // third; the third slot's layout owner is still `c`.
    const [a, b, c] = [row(0), row(ROW, 24), row(2 * ROW)];
    expect(layoutRowAt([a, b, c], 10)).toBe(a);
    expect(layoutRowAt([a, b, c], ROW + 40)).toBe(b);
    expect(layoutRowAt([a, b, c], 2 * ROW + 10)).toBe(c);
    expect(layoutRowAt([a, b, c], 3 * ROW + 10)).toBeUndefined();
  });

  it('answers nothing for rows that have no layout', () => {
    const empty = document.createElement('div');
    expect(layoutRowAt([empty], 0)).toBeUndefined();
  });
});

describe('layoutInsertIndex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts the rows whose middle is above the pointer, the middle itself included', () => {
    drawnTransforms();
    const rows = [row(0), row(ROW), row(2 * ROW)];
    expect(layoutInsertIndex(rows, 0)).toBe(0);
    expect(layoutInsertIndex(rows, ROW / 2 - 1)).toBe(0);
    expect(layoutInsertIndex(rows, ROW / 2)).toBe(1);
    expect(layoutInsertIndex(rows, ROW + ROW / 2)).toBe(2);
    expect(layoutInsertIndex(rows, 3 * ROW)).toBe(3);
  });

  it('measures a row where it is laid out, not where its motion has drawn it', () => {
    drawnTransforms();
    // The second row is laid out in its slot but drawn a whole slot lower, as
    // a row pushed aside is while it glides there. Read where it is drawn, its
    // middle would sit below the pointer.
    const rows = [row(0), row(ROW, ROW), row(2 * ROW)];
    expect(layoutInsertIndex(rows, ROW + ROW / 2 + 4)).toBe(2);
  });
});
