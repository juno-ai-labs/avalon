import { useEffect, useState, type ReactNode } from 'react';

/**
 * How long each item shows before the next rolls in. The roll itself is the
 * background-agent count wheel's 280 ms (`background-agent-digit-in/out`).
 */
export const ROLLING_CYCLE_HOLD_MS = 2400;
const ROLL_MS = 280;

/**
 * Steps through `length` items on a timer, for one or more `RollingSlot`s that
 * roll together. With reduced motion it stays on the first item. `previous`
 * is the item rolling out, until `settle` clears it at the end of the roll.
 */
export function useRollingCycle(length: number): { index: number; previous: number | null; settle: () => void } {
  const [state, setState] = useState({ index: 0, previous: null as number | null });
  useEffect(() => {
    if (length < 2 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setState((current) => ({
      index: (current.index + 1) % length,
      previous: current.index,
    })), ROLLING_CYCLE_HOLD_MS + ROLL_MS);
    return () => window.clearInterval(timer);
  }, [length]);
  return { ...state, settle: () => setState((current) => ({ ...current, previous: null })) };
}

/**
 * One place an item rolls in: the outgoing item leaves upward and the incoming
 * one arrives from below, on the same wheel as the composer's running count.
 * Keyed by index so each step starts its animation afresh.
 */
export function RollingSlot({ className, items, cycle }: {
  className?: string;
  items: readonly ReactNode[];
  cycle: { index: number; previous: number | null; settle?: () => void };
}): React.JSX.Element {
  return <span className={`rolling-slot${className ? ` ${className}` : ''}`}>
    {cycle.previous != null && <span className="rolling-slot-item rolling-slot-out" key={`out-${cycle.previous}`} onAnimationEnd={(event) => {
      if (event.animationName === 'background-agent-digit-out') cycle.settle?.();
    }}>{items[cycle.previous]}</span>}
    <span className={`rolling-slot-item${cycle.previous != null ? ' rolling-slot-in' : ''}`} key={`in-${cycle.index}`}>{items[cycle.index]}</span>
  </span>;
}
