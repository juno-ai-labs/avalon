// Browser timers use a signed 32-bit delay; ordinary sessions can last longer.
// MDN Window.setTimeout, verified 2026-09-17:
// https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#maximum_delay_value
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Wait for a server timestamp without overflowing the browser timer range. */
export function scheduleSessionDeadline(at: number, callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = at - Date.now();
    timer = setTimeout(() => {
      if (Date.now() < at) schedule();
      else callback();
    }, Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS)));
  };
  schedule();
  return () => clearTimeout(timer);
}
