/** How far in from the screen's leading edge a pull may start, in points. */
export const EDGE_SWIPE_WIDTH = 20;
/** How far a touch from the edge travels sideways before it is a pull, not a tap. */
export const EDGE_SWIPE_ACTIVATION = 10;
/** A fling this fast, in points per second, decides the outcome by its direction. */
const FLING_VELOCITY = 500;

/** Whether a released pull settles the drawer open: a fling goes the way it
 * was thrown; otherwise the drawer goes to whichever side is nearer. */
export function edgePullOpens(fraction: number, velocityX: number): boolean {
  if (velocityX >= FLING_VELOCITY) return true;
  if (velocityX <= -FLING_VELOCITY) return false;
  return fraction >= 0.5;
}
