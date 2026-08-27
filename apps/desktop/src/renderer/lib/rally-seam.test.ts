import { describe, expect, it } from 'vitest';
import { SEAM_START_RADIANS, seamPath } from './rally-seam';

/** The `M`/`L` coordinates of a path, in the order they are drawn. */
function points(d: string): Array<{ x: number; y: number }> {
  return [...d.matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/gu)]
    .map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
}

/** How far the furthest point of a drawing sits from the centre of the box. */
function reach(d: string): number {
  return Math.max(...points(d).map(({ x, y }) => Math.hypot(x - 50, y - 50)));
}

const ANGLES = [0, 0.4, 1.1, SEAM_START_RADIANS, 2.3, 3.9, 5.2];

describe('the seam projection', () => {
  /**
   * The one thing a host has to be able to rely on when it picks a size and a
   * stroke weight: no angle of the turn is wider than any other, so nothing
   * clips and the mark does not appear to breathe as it goes round.
   *
   * It holds because the curve lies exactly on the unit sphere, which no amount
   * of rotating changes — but the projection is where that could be lost, and a
   * frame that escaped would only show up as a clipped edge at one angle of a
   * five-second loop.
   */
  it('keeps every angle of the turn inside the radius the scale names', () => {
    for (const spin of ANGLES) {
      for (const tilt of ANGLES) {
        expect(reach(seamPath(spin, tilt, 46))).toBeLessThanOrEqual(46.01);
      }
    }
  });

  // And the bound above is the drawing's actual size rather than a ceiling it
  // never comes near, which is what would make that assertion vacuous.
  it('fills the radius it is given', () => {
    expect(reach(seamPath(SEAM_START_RADIANS, 0, 46))).toBeGreaterThan(45.9);
  });

  /**
   * With no tilt the projection is mirror-exact about the vertical: `t` and
   * `t + pi` are the same height and opposite sides. That symmetry is what lets
   * the single-axis drawing read as a turn at small sizes, and it is the reason
   * the resting master is drawn without tilt.
   */
  it('is mirror-exact about the vertical while the tilt is zero', () => {
    const drawn = points(seamPath(SEAM_START_RADIANS, 0, 46, 120));
    const half = 60;

    for (let step = 0; step < half; step++) {
      const near = drawn[step];
      const far = drawn[step + half];
      if (!near || !far) throw new Error('the path is shorter than its segment count');
      expect(far.x).toBeCloseTo(100 - near.x, 1);
      expect(far.y).toBeCloseTo(near.y, 1);
    }
  });

  /**
   * And the tilt is what spends that symmetry. If it did not, the second axis
   * would be doing nothing visible and the mark would be turning on one.
   */
  it('loses the mirror once the tilt is not zero', () => {
    const drawn = points(seamPath(SEAM_START_RADIANS, 0.6, 46, 120));
    const mirrored = drawn.slice(0, 60).map((near, step) => {
      const far = drawn[step + 60];
      if (!far) throw new Error('the path is shorter than its segment count');
      return Math.abs(far.y - near.y);
    });

    expect(Math.max(...mirrored)).toBeGreaterThan(1);
  });

  it('draws a closed polyline of one point per segment plus the return', () => {
    const d = seamPath(SEAM_START_RADIANS, 0, 46, 24);
    expect(points(d)).toHaveLength(25);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('draws a different frame at a different spin', () => {
    expect(seamPath(0)).not.toEqual(seamPath(0.4));
  });
});
