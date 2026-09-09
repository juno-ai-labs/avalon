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

/** An animation in flight on a row, with the offset it started from. */
interface Running {
  animation: Animation;
  from: { x: number; y: number };
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
 * recent list; `data-motion-hold` on a row asks for it to be shifted into
 * place like a neighbour rather than leave and re-enter.
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
 * nothing here runs per frame. `docs/list-motion.md` owns the design.
 */
export function useListMotion(containerRef: RefObject<HTMLElement | null>): void {
  const lastSeen = useRef<Map<string, ListMotionFrom>>(new Map());
  const running = useRef<Map<HTMLElement, Running[]>>(new Map());
  const pointerEventsBefore = useRef<WeakMap<HTMLElement, string>>(new WeakMap());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    /** Back to being a target, once nothing is playing on the row any more. */
    const release = (element: HTMLElement): void => {
      if (running.current.has(element) || !pointerEventsBefore.current.has(element)) return;
      element.style.pointerEvents = pointerEventsBefore.current.get(element) ?? '';
      pointerEventsBefore.current.delete(element);
    };
    // What each row still playing is doing to its box right now. A measured
    // rect includes it, so it is taken back out to get the layout position —
    // reading a row half-way through a shift as having moved would interrupt
    // it every render, and remember its half-way point as its slot. Where the
    // reader sees the row is the same offset, except for an animation that has
    // not drawn a frame yet and so applies nothing: that row is wherever it
    // was about to start from.
    const applied = new Map<HTMLElement, { x: number; y: number }>();
    const visible = new Map<HTMLElement, { x: number; y: number }>();
    for (const [element, entries] of running.current) {
      if (!element.isConnected) continue;
      const last = entries.at(-1)!;
      const offset = translationOf(getComputedStyle(element).transform);
      applied.set(element, offset);
      visible.set(element, last.animation.pending ? last.from : offset);
    }
    /** Stop what a row is playing, answering where the reader saw it. */
    const interrupt = (element: HTMLElement): { x: number; y: number } | undefined => {
      const entries = running.current.get(element);
      if (entries === undefined) return undefined;
      running.current.delete(element);
      for (const entry of entries) entry.animation.cancel();
      return visible.get(element) ?? { x: 0, y: 0 };
    };

    // A row whose element has gone was unmounted mid-animation; nothing is left
    // to draw it, and the row's new element, if any, starts from its slot.
    for (const element of [...running.current.keys()]) {
      if (!element.isConnected) interrupt(element);
    }

    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const rows = [...container.querySelectorAll<HTMLElement>('[data-motion-key]')].map((element) => {
      const rect = element.getBoundingClientRect();
      const offset = applied.get(element) ?? { x: 0, y: 0 };
      const scope = element.closest<HTMLElement>('[data-motion-scope]')?.dataset.motionScope ?? '';
      const row: ListMotionRow = {
        key: `${scope}\n${element.dataset.motionKey ?? ''}`,
        top: rect.top - offset.y - containerRect.top + scrollTop,
        hold: element.hasAttribute('data-motion-hold'),
      };
      return {
        element,
        row,
        exitDistance: -(rect.right - offset.x - containerRect.left + LIST_MOTION.exitClearancePx),
      };
    });
    const previous = lastSeen.current;
    // Remembered whatever happens next, so a change made while the window was
    // hidden is not replayed when it is shown again.
    lastSeen.current = new Map(rows.map(({ row }) => [row.key, { top: row.top }]));

    const changed = rows.filter(({ row }) => {
      const seen = previous.get(row.key);
      return seen !== undefined && Math.abs(seen.top - row.top) >= 0.5;
    });
    if (changed.length === 0) return;

    // Only a row whose layout moved is interrupted; it continues from where it
    // visibly was. The rest keep playing, and enter the plan at rest so the
    // planner can rank the whole list.
    const before = new Map<string, ListMotionFrom>();
    const interrupted: HTMLElement[] = [];
    for (const { element, row } of changed) {
      const offset = interrupt(element);
      if (offset !== undefined) interrupted.push(element);
      before.set(row.key, { top: previous.get(row.key)!.top, ...offset });
    }
    for (const { row } of rows) {
      const seen = previous.get(row.key);
      if (seen !== undefined && !before.has(row.key)) before.set(row.key, { top: seen.top });
    }

    const plays = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true
      && document.visibilityState !== 'hidden';
    if (plays) {
      const plan = planListMotion(before, rows.map(({ row }) => row));
      const byKey = new Map(changed.map((entry) => [entry.row.key, entry]));
      const play = (
        element: HTMLElement,
        from: { fromX: number; fromY: number },
        { keyframes, options }: { keyframes: Keyframe[]; options: KeyframeAnimationOptions },
      ): void => {
        if (typeof element.animate !== 'function') return;
        // A row on its way somewhere is not a target: the pointer resting where
        // it is about to pass would otherwise hover it, and during a drag would
        // reorder against it, sending it straight back the way it came. The
        // value it had is kept from the first animation to the last, because a
        // cancelled animation settles asynchronously — after the one that
        // replaced it has started — and must not undo its successor.
        if (!pointerEventsBefore.current.has(element)) {
          pointerEventsBefore.current.set(element, element.style.pointerEvents);
        }
        element.style.pointerEvents = 'none';
        const animation = element.animate(keyframes, options);
        const settle = (): void => {
          const remaining = running.current.get(element)?.filter((entry) => entry.animation !== animation) ?? [];
          if (remaining.length > 0) running.current.set(element, remaining);
          else running.current.delete(element);
          release(element);
        };
        animation.onfinish = settle;
        animation.oncancel = settle;
        running.current.set(element, [
          ...(running.current.get(element) ?? []),
          { animation, from: { x: from.fromX, y: from.fromY } },
        ]);
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
    }
    // Interrupted and given nothing new to play: a target again now, rather
    // than whenever the cancelled animation gets round to saying so.
    for (const element of interrupted) release(element);
  });

  useLayoutEffect(() => () => {
    for (const entries of running.current.values()) {
      for (const entry of entries) entry.animation.cancel();
    }
    running.current.clear();
  }, []);
}
