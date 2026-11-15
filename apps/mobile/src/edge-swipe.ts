/** How far in from the screen's leading edge a swipe may start, in points. */
export const EDGE_SWIPE_WIDTH = 20;
/** How far a swipe travels inward before it counts. */
const EDGE_SWIPE_DISTANCE = 40;
/** A quick flick counts sooner, once it has clearly left the edge. */
const EDGE_SWIPE_FLICK_DISTANCE = 12;
const EDGE_SWIPE_FLICK_VELOCITY = 0.5;

/** Whether a pan from the leading edge has gone far or fast enough inward,
 * and more sideways than vertical, to count as pulling the sidebar in. */
export function edgeSwipeCompletes(dx: number, dy: number, vx: number): boolean {
  if (dx <= Math.abs(dy)) return false;
  return dx >= EDGE_SWIPE_DISTANCE || (dx >= EDGE_SWIPE_FLICK_DISTANCE && vx >= EDGE_SWIPE_FLICK_VELOCITY);
}
