import { useSyncExternalStore } from 'react';

/**
 * How often every relative label on screen re-reads the clock.
 *
 * A product number rather than a defensive one: it is how far "just now" or
 * "7 minutes ago" may drift from the truth before the screen corrects it. Ten
 * seconds was the team's choice — a label crosses a minute boundary within a
 * blink of it doing so, and the whole feed pays one timer for that, not one per
 * row.
 */
export const RELATIVE_TIME_REFRESH_MS = 10_000;

let now = Date.now();
let timer: number | undefined;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

// Chromium throttles a hidden window's timers to once a minute, so a person
// switching back to Rally after a while would otherwise read labels that stopped
// while they were away until the throttled tick came round.
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // The first subscriber starts the clock; React re-checks the snapshot after
    // subscribing, so a stale first render corrects itself at once.
    now = Date.now();
    timer = window.setInterval(tick, RELATIVE_TIME_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

function getSnapshot(): number {
  // With no interval running nothing has moved `now` since the last subscriber
  // left, so a component mounting later would render against a clock that
  // stopped. Re-read it here, but only across at least the interval a tick
  // would have crossed: two reads in one render must agree, or React reports an
  // unstable snapshot.
  if (timer === undefined && Math.abs(Date.now() - now) >= RELATIVE_TIME_REFRESH_MS) now = Date.now();
  return now;
}

/**
 * The instant every relative label is read against, shared by all of them.
 *
 * One interval serves every subscriber, and it runs only while at least one is
 * mounted. A component that renders a relative time reads this rather than
 * `Date.now()` so that the whole screen advances together and each label
 * re-renders on the tick without its host knowing.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
