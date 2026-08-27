/**
 * The Rally seam — the brand mark as a closed curve on a unit sphere, projected
 * to a flat path on demand.
 *
 * Everywhere else in the renderer the mark is a still image behind a CSS mask
 * (`RallyMark`). That image cannot be turned: a `transform: rotate()` spins the
 * whole drawing like a sticker, so its crossings never pass over one another and
 * the result reads as a flat sign being twisted rather than as an object turning
 * in the hand. Turning it properly means re-solving the curve every frame, which
 * is what this module is for.
 *
 * The curve is closed and lies exactly on the unit sphere: the seam's own
 * identity `x^2 + z^2 = A^2 + B^2 + 2AB*cos(4t)` and `y^2 = 2AB(1 - cos(4t))`
 * sum to `(A + B)^2 = 1`. Every projected point is therefore within `scale` of
 * the centre under any rotation, which is why a `scale` of 46 and a stroke of 6
 * fit the 100x100 viewBox at every angle without clipping. Changing one without
 * the other reintroduces clipping at some angles only.
 */

/** Seam lobe depth. Part of the drawing, not a tuning knob. */
const LOBE_DEPTH = 0.19;
const SPAN = 1 - LOBE_DEPTH;
const CROSS = 2 * Math.sqrt(SPAN * LOBE_DEPTH);

/** The resting angle the still master is drawn at, and where a turn begins. */
export const SEAM_START_RADIANS = (25 * Math.PI) / 180;

/**
 * Radians per millisecond about the vertical: one turn in about 4.8 seconds.
 * Slower reads as stalled, faster as anxious.
 */
export const SEAM_SPIN_RATE = 0.0013;

/**
 * Radians per millisecond about the horizontal. Deliberately incommensurate
 * with `SEAM_SPIN_RATE`, so the pair never returns to the same relative
 * position and the two-axis turn has no visible period to catch.
 */
export const SEAM_TILT_RATE = 0.00079;

/**
 * The seam's `d` at one rotation, as an orthographic projection.
 *
 * With `tilt` at zero the projection is mirror-exact about the vertical —
 * `t -> t + pi` maps `(x, y)` to `(-x, y)` — and the drawing reads as a turn at
 * any size. A non-zero tilt is what makes the motion gyroscopic, and it costs
 * that symmetry: most frames are asymmetric about the vertical, which reads as a
 * wobble rather than a turn below roughly 40px. Tilt at display sizes only.
 *
 * @param spin Rotation about the vertical, in radians.
 * @param tilt Rotation about the horizontal, in radians.
 * @param scale Radius in viewBox units; the viewBox is `0 0 100 100`.
 * @param segments Polyline resolution. 168 is smooth to about 200px.
 */
export function seamPath(spin: number, tilt = 0, scale = 46, segments = 168): string {
  const spinCos = Math.cos(spin);
  const spinSin = Math.sin(spin);
  const tiltCos = Math.cos(tilt);
  const tiltSin = Math.sin(tilt);

  let d = '';
  for (let step = 0; step <= segments; step++) {
    const t = (step / segments) * Math.PI * 2;
    const x = SPAN * Math.cos(t) + LOBE_DEPTH * Math.cos(3 * t);
    const y = CROSS * Math.sin(2 * t);
    const z = SPAN * Math.sin(t) - LOBE_DEPTH * Math.sin(3 * t);

    // Rotate about the vertical, then about the horizontal, then drop the depth.
    const spun = x * spinCos + z * spinSin;
    const depth = z * spinCos - x * spinSin;

    d += `${step ? 'L' : 'M'}${(50 + spun * scale).toFixed(2)},${(50 + (y * tiltCos - depth * tiltSin) * scale).toFixed(2)}`;
  }
  return `${d}Z`;
}
