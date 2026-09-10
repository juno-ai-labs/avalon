import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  LIST_MOTION,
  enterKeyframes,
  exitKeyframes,
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
  /**
   * An entrance travels horizontally only, so a change of layout does not
   * stale it the way it stales a move measured between slots that no longer
   * exist; it is the one kind of animation a relayout leaves playing.
   */
  entrance: boolean;
}

/** A row as last measured: its layout box in the container's content, and which element it was. */
interface Seen extends ListMotionFrom {
  element: HTMLElement;
  left: number;
  width: number;
  height: number;
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
 * A row that carries `data-motion-insert` is one whose arrival and departure
 * are themselves the change: it slides in from the left when it first appears,
 * and slides out to the left when it is removed, through a stand-in placed
 * over the slot it left, since React has already taken its element out of the
 * document. Every other row appears and disappears in place — a page of rows
 * arriving at once is not a move — and nothing at all plays on the hook's
 * first commit, whatever the rows carry. The container of a list that marks
 * rows this way is their positioning context.
 *
 * A row with no layout — `display: none` — is neither measured nor
 * remembered; it is closer to not being there than to being at the top of the
 * container, which is what its empty rect would say.
 *
 * `layoutKey` names the layout the rows are in. When it changes, every row is
 * measured afresh and nothing plays: the sidebar's compact toggle moves every
 * row's position for a reason that is not a reorder. `layoutSettling` says the
 * rows are still travelling to that layout — the sidebar's rows change shape
 * under CSS transitions for as long as its box's width does — so every render
 * while it holds measures afresh and plays nothing, as does the first render
 * after it clears, so that the last mid-flight positions are not the ones the
 * next change is planned from.
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
export function useListMotion(
  containerRef: RefObject<HTMLElement | null>,
  layoutKey?: unknown,
  layoutSettling = false,
): void {
  const lastSeen = useRef<Map<string, Seen>>(new Map());
  const lastLayoutKey = useRef<unknown>(layoutKey);
  const lastLayoutSettling = useRef(false);
  const committed = useRef(false);
  const running = useRef<Map<HTMLElement, Running>>(new Map());
  /** The exits in flight, each on a stand-in its own settling removes. */
  const leaving = useRef<Set<Animation>>(new Set());

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
    const play = (
      element: HTMLElement,
      from: { fromX: number; fromY: number },
      { keyframes, options }: { keyframes: Keyframe[]; options: KeyframeAnimationOptions },
      entrance = false,
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
      running.current.set(element, { animation, from: { x: from.fromX, y: from.fromY }, entrance });
    };

    // A row whose element has gone was unmounted mid-animation; nothing is left
    // to draw it, and the row's new element, if any, starts from its slot.
    for (const element of [...running.current.keys()]) {
      if (!element.isConnected) interrupt(element);
    }

    const previous = lastSeen.current;
    const containerRect = container.getBoundingClientRect();
    // The content frame: the container's padding box, as scrolled. A stand-in
    // is placed in it absolutely, so the same numbers that say where a row was
    // say where its copy goes.
    const originX = containerRect.left + container.clientLeft - container.scrollLeft;
    const originY = containerRect.top + container.clientTop - container.scrollTop;
    const rows = [...container.querySelectorAll<HTMLElement>('[data-motion-key]')].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return [];
      const offset = applied.get(element) ?? { x: 0, y: 0 };
      const scope = element.closest<HTMLElement>('[data-motion-scope]')?.dataset.motionScope ?? '';
      const key = `${scope}\n${element.dataset.motionKey ?? ''}`;
      const row: ListMotionRow = {
        key,
        scope,
        top: rect.top - offset.y - originY,
        hold: element.hasAttribute('data-motion-hold')
          || (previous.get(key)?.element === element && element.contains(document.activeElement)),
      };
      const box = { left: rect.left - offset.x - originX, width: rect.width, height: rect.height };
      // To the container's visible edge, whatever it is scrolled to.
      const exitDistance = -(rect.right - offset.x - containerRect.left - container.clientLeft + LIST_MOTION.exitClearancePx);
      return [{ element, row, box, exitDistance }];
    });
    // Remembered whatever happens next, so a change made while the window was
    // hidden is not replayed when it is shown again.
    lastSeen.current = new Map(rows.map(({ element, row, box }) => [row.key, { top: row.top, element, ...box }]));

    const first = !committed.current;
    committed.current = true;
    // A new layout is not a move: the rows are where they now are, and what
    // they were playing was measured against a layout that no longer exists.
    // Nor is a layout still being travelled to one the rows are in yet.
    const relaid = lastLayoutKey.current !== layoutKey || layoutSettling || lastLayoutSettling.current;
    lastLayoutKey.current = layoutKey;
    lastLayoutSettling.current = layoutSettling;
    if (relaid) {
      for (const [element, entry] of [...running.current]) {
        if (!entry.entrance) interrupt(element);
      }
    }

    const playing = !first
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true
      && document.visibilityState !== 'hidden';

    // The rows whose arrival and departure are the change. They play through a
    // relayout, since they are the change the relayout was made for.
    if (playing) {
      for (const { element, row, exitDistance } of rows) {
        if (previous.has(row.key) || !element.hasAttribute('data-motion-insert')) continue;
        play(element, { fromX: exitDistance, fromY: 0 }, enterKeyframes(exitDistance), true);
      }
      for (const [key, seen] of previous) {
        if (lastSeen.current.has(key) || !seen.element.hasAttribute('data-motion-insert')) continue;
        leaveThrough(container, seen, leaving.current);
      }
    }

    if (relaid) return;

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

    if (!playing) return;

    const plan = planListMotion(before, rows.map(({ row }) => row));
    const byKey = new Map(changed.map((entry) => [entry.row.key, entry]));
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
    for (const animation of [...leaving.current]) animation.cancel();
  }, []);
}

/**
 * Plays a removed row's exit on a copy of it, placed over the slot it left:
 * React has taken the row's own element out of the document, and nothing else
 * is left to draw it. The copy is a picture of the row and nothing more —
 * inert, hidden from assistive technology, stripped of its ids so the document
 * keeps one of each, and of its motion attributes so the next render does not
 * measure it as a row — and it is taken out again the moment the exit finishes
 * or is cancelled. Where the row cannot be animated at all, it is simply gone.
 */
function leaveThrough(container: HTMLElement, seen: Seen, leaving: Set<Animation>): void {
  const standIn = seen.element.cloneNode(true) as HTMLElement;
  if (typeof standIn.animate !== 'function') return;
  for (const node of [standIn, ...standIn.querySelectorAll('*')]) {
    node.removeAttribute('id');
    for (const name of node.getAttributeNames()) {
      if (name.startsWith('data-motion-')) node.removeAttribute(name);
    }
  }
  standIn.setAttribute('aria-hidden', 'true');
  standIn.setAttribute('inert', '');
  standIn.setAttribute('data-motion-stand-in', '');
  Object.assign(standIn.style, {
    position: 'absolute',
    top: `${seen.top}px`,
    left: `${seen.left}px`,
    width: `${seen.width}px`,
    height: `${seen.height}px`,
    margin: '0',
    boxSizing: 'border-box',
    pointerEvents: 'none',
  });
  container.append(standIn);
  const exitDistance = -(seen.left + seen.width + LIST_MOTION.exitClearancePx);
  const { keyframes, options } = exitKeyframes({ fromX: 0, fromY: 0 }, exitDistance);
  const animation = standIn.animate(keyframes, options);
  const settle = (): void => {
    leaving.delete(animation);
    standIn.remove();
  };
  animation.onfinish = settle;
  animation.oncancel = settle;
  leaving.add(animation);
}
