import clsx from 'clsx';
import { useEffect, useState, type Key, type ReactNode } from 'react';

/** The roll itself: the `background-agent-digit-in/out` keyframes' duration. */
export const ROLL_MS = 280;
/** One step of `useRollingCycle`: the item holds, then rolls. */
export const ROLLING_CYCLE_PERIOD_MS = 2400 + ROLL_MS;

/**
 * One place a value rolls in: when `valueKey` changes, the old content leaves
 * and the new arrives on the composer's count wheel, upward unless
 * `direction` says otherwise. It tracks the outgoing item itself, so callers
 * only say what shows now.
 */
export function RollingSlot({ children, className, direction = 'up', itemClassName, valueKey }: {
  children: ReactNode;
  className?: string;
  direction?: 'up' | 'down';
  itemClassName?: string;
  valueKey: Key;
}): React.JSX.Element {
  const [display, setDisplay] = useState({ key: valueKey, node: children, previous: null as { key: Key; node: ReactNode } | null });
  if (valueKey !== display.key) setDisplay({ key: valueKey, node: children, previous: { key: display.key, node: display.node } });
  return <span className={clsx('rolling-slot', className)} data-direction={direction}>
    {display.previous && <span
      className={clsx('rolling-slot-item rolling-slot-out', itemClassName)}
      key={`out-${String(display.previous.key)}`}
      onAnimationEnd={(event) => {
        if (event.animationName === 'background-agent-digit-out') setDisplay((current) => ({ ...current, previous: null }));
      }}
    >{display.previous.node}</span>}
    <span className={clsx('rolling-slot-item', display.previous && 'rolling-slot-in', itemClassName)} key={`in-${String(valueKey)}`}>{children}</span>
  </span>;
}

/**
 * Which of `length` items shows, stepping every `ROLLING_CYCLE_PERIOD_MS`.
 * Holds the first item under reduced motion, following the setting while the
 * app is open, and does no work while the window is hidden.
 */
export function useRollingCycle(length: number): number {
  const [index, setIndex] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) setIndex(0);
    if (length < 2 || reduced) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setIndex((current) => (current + 1) % length);
    }, ROLLING_CYCLE_PERIOD_MS);
    return () => window.clearInterval(timer);
  }, [length, reduced]);
  return index;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const update = (): void => setReduced(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
}
