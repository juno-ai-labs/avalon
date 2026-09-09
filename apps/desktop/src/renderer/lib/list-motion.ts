/**
 * The arithmetic behind a list whose rows move: which rows changed place, which
 * rows were only pushed aside by them, and the keyframes each kind plays.
 *
 * Pure over measured positions, so it owns no DOM and no timer.
 * `use-list-motion.ts` measures, calls `planListMotion`, and plays what it
 * returns; `docs/list-motion.md` owns the design.
 */

/**
 * The choreography's clock, in milliseconds from the moment the list changes.
 *
 * Everything starts at once: the moved row begins leaving its old slot, and
 * the rows between its two slots begin closing the gap, on the same frame. The
 * one thing that waits is the row's return — it cannot be in two places, so it
 * comes back in at its new slot only once it has cleared the frame, and a short
 * stagger after that is what reads as "left, and came back" rather than a
 * bounce off the edge. The durations are short because a sidebar row moves on
 * somebody else's message as often as on the reader's own action, and a long
 * animation in the corner of the eye is an interruption. Every number is
 * tunable here and nowhere else.
 */
export const LIST_MOTION = {
  /** The moved row sliding out of frame, right to left. */
  exitMs: 160,
  /** The pause between the row clearing the frame and starting back in. */
  enterStaggerMs: 40,
  /** The row sliding back in at its new slot, left to right. */
  enterMs: 220,
  /** The rows between its two slots closing the gap, from the same first frame. */
  shiftMs: 260,
  /** Clearance past the container's edge, so a row is fully out of frame. */
  exitClearancePx: 8,
  /**
   * The standard three curves, one per kind of motion: a row leaving the frame
   * accelerates away, a row arriving decelerates into place, and a row moving
   * from one place on screen to another starts and ends at rest.
   */
  exitEasing: 'cubic-bezier(.4, 0, 1, 1)',
  enterEasing: 'cubic-bezier(0, 0, .2, 1)',
  shiftEasing: 'cubic-bezier(.4, 0, .2, 1)',
} as const;

/** The whole choreography, exit to settled. */
export const LIST_MOTION_TOTAL_MS = LIST_MOTION.exitMs + LIST_MOTION.enterStaggerMs + LIST_MOTION.enterMs;

/** A row as measured after the list changed. */
export interface ListMotionRow {
  key: string;
  /**
   * The list this row is ranked within. Rows in different scopes never pass
   * one another: a project's members keep their order among themselves while
   * the whole project moves past another, and shift with it rather than
   * leaving as if each had been moved on its own.
   */
  scope?: string;
  /** Its layout position, in a frame the caller keeps stable across renders. */
  top: number;
  /**
   * The row is being placed rather than moved — its position is following the
   * pointer during a drag, say, or it is a heading that travels with the rows
   * under it — so it is shifted into place like a neighbour instead of leaving
   * and re-entering, and it takes no part in deciding which rows moved.
   */
  hold?: boolean;
}

/** A row the reader last saw somewhere else. */
export interface ListMotionFrom {
  /** Its layout position when the list was last seen. */
  top: number;
  /**
   * The translation an earlier animation was applying at the moment of
   * interruption, so the next one starts from where the row visibly is rather
   * than from where it was laid out.
   */
  x?: number;
  y?: number;
}

export interface ListMotionPlan {
  /** Rows that changed their place in the order: leave, then re-enter. */
  movers: Array<{ key: string; fromX: number; fromY: number }>;
  /** Rows whose place held while others moved past them: shift straight over. */
  shifters: Array<{ key: string; fromX: number; fromY: number }>;
}

/**
 * The positions (as indices into `sequence`) of one longest strictly
 * increasing subsequence. Patience sorting, O(n log n): a sidebar can hold a
 * few hundred rows, and this runs on every render that changed one.
 */
export function longestIncreasingRun(sequence: readonly number[]): number[] {
  const tailIndexAtLength: number[] = [];
  const predecessor = new Array<number>(sequence.length).fill(-1);
  for (let index = 0; index < sequence.length; index += 1) {
    const value = sequence[index]!;
    let low = 0;
    let high = tailIndexAtLength.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sequence[tailIndexAtLength[middle]!]! < value) low = middle + 1;
      else high = middle;
    }
    predecessor[index] = low > 0 ? tailIndexAtLength[low - 1]! : -1;
    tailIndexAtLength[low] = index;
  }
  const run: number[] = [];
  let cursor = tailIndexAtLength.at(-1) ?? -1;
  while (cursor >= 0) {
    run.push(cursor);
    cursor = predecessor[cursor]!;
  }
  return run.reverse();
}

/**
 * Which rows moved and which were merely displaced.
 *
 * A row is a *mover* when its place in the order changed relative to the rows
 * around it; everything else that ended up at a different position is a
 * *shifter*, pushed up or down by a mover passing it. The two are told apart
 * by the largest set of rows that kept their relative order — the longest
 * increasing run of old ranks read in the new order — which is the smallest
 * set of moves that explains the change: one message arriving moves one row to
 * the top and everything it passed shifts down by one, and that is what the
 * plan says, rather than "every row above it moved".
 *
 * Held rows are shifters whatever happened around them, and are left out of
 * the ranking: a row leaving the pinned section for the top of the recent list
 * passes that list's heading, and the heading must not be the thing that is
 * seen to leave. The ranking is per scope, so a block of rows moving as one —
 * a project and its members, reordered past another project — shifts as one.
 *
 * Rows that were not there before are left alone: they have no old position to
 * leave from, and a page of them arriving at once is not a move. Rows that are
 * gone cannot be animated, since there is nothing left to animate.
 */
export function planListMotion(
  before: ReadonlyMap<string, ListMotionFrom>,
  after: readonly ListMotionRow[],
): ListMotionPlan {
  const shared = after.flatMap((row) => {
    const from = before.get(row.key);
    return from === undefined ? [] : [{ row, from }];
  });
  const kept = new Set<string>();
  const scopes = new Map<string, typeof shared>();
  for (const entry of shared) {
    if (entry.row.hold) continue;
    const scope = entry.row.scope ?? '';
    scopes.set(scope, [...(scopes.get(scope) ?? []), entry]);
  }
  for (const ranked of scopes.values()) {
    const oldRank = new Map(
      [...ranked]
        .sort((left, right) => left.from.top - right.from.top)
        .map((entry, rank) => [entry.row.key, rank] as const),
    );
    for (const index of longestIncreasingRun(ranked.map((entry) => oldRank.get(entry.row.key)!))) {
      kept.add(ranked[index]!.row.key);
    }
  }
  const plan: ListMotionPlan = { movers: [], shifters: [] };
  for (const { row, from } of shared) {
    const fromX = from.x ?? 0;
    const fromY = from.top + (from.y ?? 0) - row.top;
    if (!kept.has(row.key) && !row.hold) {
      plan.movers.push({ key: row.key, fromX, fromY });
    } else if (Math.abs(fromX) >= 0.5 || Math.abs(fromY) >= 0.5) {
      plan.shifters.push({ key: row.key, fromX, fromY });
    }
  }
  return plan;
}

/**
 * What a moved row plays: out of its old slot to the left, dark while its
 * neighbours close the gap, then in from the left at its new slot. One
 * animation rather than three chained ones, so an interruption has one thing
 * to cancel and the phases cannot drift apart under load.
 *
 * `exitDistance` is how far left the row has to travel to clear the container,
 * measured by the caller — a fraction of the row's own width would leave a
 * narrow row's edge showing in a wider container.
 */
export function moverKeyframes(
  { fromX, fromY }: { fromX: number; fromY: number },
  exitDistance: number,
): { keyframes: Keyframe[]; options: KeyframeAnimationOptions } {
  const total = LIST_MOTION_TOTAL_MS;
  const exitEnd = LIST_MOTION.exitMs / total;
  const enterStart = (LIST_MOTION.exitMs + LIST_MOTION.enterStaggerMs) / total;
  const away = `translate(${exitDistance}px, 0px)`;
  return {
    keyframes: [
      { offset: 0, transform: `translate(${fromX}px, ${fromY}px)`, easing: LIST_MOTION.exitEasing },
      // The old slot, cleared. The same offset twice is a jump: the row is
      // parked off frame at its new slot without travelling there vertically.
      { offset: exitEnd, transform: `translate(${exitDistance}px, ${fromY}px)` },
      { offset: exitEnd, transform: away, easing: 'linear' },
      { offset: enterStart, transform: away, easing: LIST_MOTION.enterEasing },
      { offset: 1, transform: 'translate(0px, 0px)' },
    ],
    options: { duration: total, fill: 'backwards' },
  };
}

/**
 * What a displaced row plays: from where it was to where it is, starting on
 * the same frame as everything else.
 */
export function shifterKeyframes(
  { fromX, fromY }: { fromX: number; fromY: number },
): { keyframes: Keyframe[]; options: KeyframeAnimationOptions } {
  return {
    keyframes: [
      { transform: `translate(${fromX}px, ${fromY}px)` },
      { transform: 'translate(0px, 0px)' },
    ],
    options: { duration: LIST_MOTION.shiftMs, easing: LIST_MOTION.shiftEasing, fill: 'backwards' },
  };
}

/**
 * The translation a computed `transform` is applying, for reading an
 * interrupted animation's current offset. Anything but a plain 2D matrix —
 * `none`, or a 3D matrix a row never has — reads as no offset.
 */
export function translationOf(transform: string): { x: number; y: number } {
  const match = /^matrix\(([^)]+)\)$/u.exec(transform);
  if (match === null) return { x: 0, y: 0 };
  const parts = match[1]!.split(',').map((part) => Number.parseFloat(part));
  const x = parts[4];
  const y = parts[5];
  return parts.length === 6 && Number.isFinite(x) && Number.isFinite(y)
    ? { x: x!, y: y! }
    : { x: 0, y: 0 };
}

/**
 * The row whose *layout* box contains the viewport y, net of any motion it is
 * playing. A list that reorders on `dragover` needs this rather than the row
 * the event reached: a row gliding through the pointer's position mid-motion
 * is on its way somewhere else, and taking it for the row that belongs there
 * would reorder against it and send it straight back the way it came. Rows
 * with no layout — `display: none`, or a test environment that lays nothing
 * out — contain nothing, so a caller falls back to the row the event reached.
 */
export function layoutRowAt<T extends Element>(rows: Iterable<T>, clientY: number): T | undefined {
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const drawnOffBy = translationOf(getComputedStyle(row).transform).y;
    const top = rect.top - drawnOffBy;
    if (clientY >= top && clientY < top + rect.height) return row;
  }
  return undefined;
}
