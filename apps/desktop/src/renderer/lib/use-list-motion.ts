import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  LIST_MOTION,
  moverKeyframes,
  planListMotion,
  shifterKeyframes,
  translationOf,
  type ListMotionFrom,
  type ListMotionRow,
} from './list-motion';

/** The animation in flight on a row, with the offset it started from. */
interface Running {
  animation: Animation;
  from: { x: number; y: number };
}

/** A row as last measured: where it was, and which element it was. */
interface Seen extends ListMotionFrom {
  element: HTMLElement;
}

/**
 * Animates the rows of a list into their new places whenever the list changes.
 *
 * Rows are whatever inside `containerRef` carries `data-motion-key`; the key
 * has to be stable for as long as the row is the same thing to the reader, and
 * a row's element may be replaced between renders — a work stream moving
 * between two sections is unmounted and remounted, and it is still one row.
 * `data-motion-scope` on any ancestor separates rows that would otherwise
 * share a key, such as a work stream listed both under its project and in the
 * recent list, and ranks the rows inside it only against one another, so a
 * scope moving as a block shifts as a block. A row is *held* — shifted into
 * place like a neighbour rather than made to leave and re-enter — when it
 * carries `data-motion-hold`, or when it kept its element and has focus
 * inside it: a row the reader is acting on, by keyboard or by the click that
 * opened it, stays under them rather than flying off through the slot they
 * are looking at. A remounted row with focus is not the reader's doing — the
 * sidebar repairs focus onto a pinned row — and travels.
 *
 * A row with no layout — `display: none` — is neither measured nor
 * remembered; it is closer to not being there than to being at the top of the
 * container, which is what its empty rect would say.
 *
 * `layoutKey` names the layout the rows are in. When it changes, every row is
 * measured afresh and nothing plays: the sidebar's compact toggle moves every
 * row's position for a reason that is not a reorder.
 *
 * The container is the scroll box the rows live in: positions are measured
 * relative to its content, so scrolling between two renders is not read as
 * every row having moved. Runs after every commit rather than on a dependency
 * list, because which rows changed place is exactly what a dependency list
 * would have to know already. A render that moved a row's layout is the only
 * kind that touches that row: the rest — and most renders are the rest, since
 * the component re-renders for state that has nothing to do with the list —
 * leave whatever the row is playing alone, which matters because a render
 * lands within milliseconds of the one that moved the row, before its
 * animation has drawn a frame.
 *
 * Every animation is a compositor-driven `transform` through the Web
 * Animations API, so the rows travel at the display's own frame rate and
 * nothing here runs per frame. Rows stay pointer targets throughout; a caller
 * that reorders on `dragover` resolves the target by layout — see
 * `layoutRowAt` — rather than by the row drawn under the pointer, which mid-
 * motion is a row on its way somewhere else. `docs/list-motion.md` owns the
 * design.
 */
export function useListMotion(containerRef: RefObject<HTMLElement | null>, layoutKey?: unknown): void {
  const lastSeen = useRef<Map<string, Seen>>(new Map());
  const lastLayoutKey = useRef<unknown>(layoutKey);
  const running = useRef<Map<HTMLElement, Running>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // What each row still playing is doing to its box right now. A measured
    // rect includes it, so it is taken back out to get the layout position —
    // reading a row half-way through a shift as having moved would interrupt
    // it every render, and remember its half-way point as its slot. Where the
    // reader sees the row is the same offset; for an animation that has not
    // started, the offset it is about to start from says the same thing.
    const applied = new Map<HTMLElement, { x: number; y: number }>();
    const visible = new Map<HTMLElement, { x: number; y: number }>();
    for (const [element, entry] of running.current) {
      if (!element.isConnected) continue;
      const offset = translationOf(getComputedStyle(element).transform);
      applied.set(element, offset);
      visible.set(element, entry.animation.pending ? entry.from : offset);
    }
    /** Stop what a row is playing, answering where the reader saw it. */
    const interrupt = (element: HTMLElement): { x: number; y: number } | undefined => {
      const entry = running.current.get(element);
      if (entry === undefined) return undefined;
      running.current.delete(element);
      entry.animation.cancel();
      return visible.get(element) ?? { x: 0, y: 0 };
    };

    // A row whose element has gone was unmounted mid-animation; nothing is left
    // to draw it, and the row's new element, if any, starts from its slot.
    for (const element of [...running.current.keys()]) {
      if (!element.isConnected) interrupt(element);
    }

    const previous = lastSeen.current;
    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const rows = [...container.querySelectorAll<HTMLElement>('[data-motion-key]')].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return [];
      const offset = applied.get(element) ?? { x: 0, y: 0 };
      const scope = element.closest<HTMLElement>('[data-motion-scope]')?.dataset.motionScope ?? '';
      const key = `${scope}\n${element.dataset.motionKey ?? ''}`;
      const row: ListMotionRow = {
        key,
        scope,
        top: rect.top - offset.y - containerRect.top + scrollTop,
        hold: element.hasAttribute('data-motion-hold')
          || (previous.get(key)?.element === element && element.contains(document.activeElement)),
      };
      return [{ element, row, exitDistance: -(rect.right - offset.x - containerRect.left + LIST_MOTION.exitClearancePx) }];
    });
    // Remembered whatever happens next, so a change made while the window was
    // hidden is not replayed when it is shown again.
    lastSeen.current = new Map(rows.map(({ element, row }) => [row.key, { top: row.top, element }]));

    // A new layout is not a move: the rows are where they now are, and what
    // they were playing was measured against a layout that no longer exists.
    if (lastLayoutKey.current !== layoutKey) {
      lastLayoutKey.current = layoutKey;
      for (const element of [...running.current.keys()]) interrupt(element);
      return;
    }

    const changed = rows.filter(({ row }) => {
      const seen = previous.get(row.key);
      return seen !== undefined && Math.abs(seen.top - row.top) >= 0.5;
    });
    if (changed.length === 0) return;

    // Only a row whose layout moved is interrupted; it continues from where it
    // visibly was. The rest keep playing, and enter the plan at rest so the
    // planner can rank the whole list.
    const before = new Map<string, ListMotionFrom>();
    for (const { element, row } of changed) {
      before.set(row.key, { top: previous.get(row.key)!.top, ...interrupt(element) });
    }
    for (const { row } of rows) {
      const seen = previous.get(row.key);
      if (seen !== undefined && !before.has(row.key)) before.set(row.key, { top: seen.top });
    }

    if (
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
      || document.visibilityState === 'hidden'
    ) return;

    const plan = planListMotion(before, rows.map(({ row }) => row));
    const byKey = new Map(changed.map((entry) => [entry.row.key, entry]));
    const play = (
      element: HTMLElement,
      from: { fromX: number; fromY: number },
      { keyframes, options }: { keyframes: Keyframe[]; options: KeyframeAnimationOptions },
    ): void => {
      if (typeof element.animate !== 'function') return;
      const animation = element.animate(keyframes, options);
      // A cancelled animation settles asynchronously, after the one that
      // replaced it has been registered; only the animation still on record
      // clears the record.
      const settle = (): void => {
        if (running.current.get(element)?.animation === animation) running.current.delete(element);
      };
      animation.onfinish = settle;
      animation.oncancel = settle;
      running.current.set(element, { animation, from: { x: from.fromX, y: from.fromY } });
    };
    // A mover the layout did not move — two rows of equal height trading
    // places can read that way — is left where it is rather than sent out.
    for (const mover of plan.movers) {
      const entry = byKey.get(mover.key);
      if (entry !== undefined) play(entry.element, mover, moverKeyframes(mover, entry.exitDistance));
    }
    for (const shifter of plan.shifters) {
      const entry = byKey.get(shifter.key);
      if (entry !== undefined) play(entry.element, shifter, shifterKeyframes(shifter));
    }
  });

  useLayoutEffect(() => () => {
    for (const entry of running.current.values()) entry.animation.cancel();
    running.current.clear();
  }, []);
}
