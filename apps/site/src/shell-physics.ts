/**
 * A small physics engine for points that live on the technology schematic's
 * surfaces. Every body moves at a constant speed and bounces elastically off
 * the walls of its region; bodies do not collide with each other.
 *
 * Two kinds of body:
 *
 * - **shell**: held on a sphere of radius `outer`, moving along its surface.
 *   The cut octant (x < 0, y > 0, z > 0) is walled off by the three coordinate
 *   planes, so a body reaching the cut bounces off the plane it would cross.
 * - **wall**: held in one of the three quarter-rings the cut exposes, between
 *   radii `inner` and `outer`. It bounces off the ring's two straight edges and
 *   its two arcs.
 *
 * State is flat typed arrays, so a step over tens of thousands of bodies is a
 * tight loop with no allocation.
 */

export const SHELL = 0;
export const WALL = 1;

/**
 * For each cut wall: the plane it lies in (the axis that is zero there), then
 * the two in-plane axes and the sign each must keep to stay in the quarter.
 * Wall 0 lies in z = 0 with x ≤ 0, y ≥ 0; wall 1 in y = 0 with x ≤ 0, z ≥ 0;
 * wall 2 in x = 0 with y ≥ 0, z ≥ 0 — the three faces of the cut octant.
 */
export const WALL_PLANES = [
  { normal: 2, a: 0, signA: -1, b: 1, signB: 1 },
  { normal: 1, a: 0, signA: -1, b: 2, signB: 1 },
  { normal: 0, a: 1, signA: 1, b: 2, signB: 1 },
] as const;

export type Bodies = {
  readonly count: number;
  readonly kind: Uint8Array;
  readonly plane: Uint8Array;
  readonly inner: Float32Array;
  readonly outer: Float32Array;
  readonly position: Float32Array;
  readonly velocity: Float32Array;
};

export function createBodies(count: number): Bodies {
  return {
    count,
    kind: new Uint8Array(count),
    plane: new Uint8Array(count),
    inner: new Float32Array(count),
    outer: new Float32Array(count),
    position: new Float32Array(count * 3),
    velocity: new Float32Array(count * 3),
  };
}

export const inCut = (x: number, y: number, z: number): boolean => x < 0 && y > 0 && z > 0;

const next = new Float64Array(3);
const vel = new Float64Array(3);

/** Advance every body by `dt` seconds. */
export function step(bodies: Bodies, dt: number): void {
  const { kind, plane, inner, outer, position: p, velocity: v } = bodies;
  for (let i = 0; i < bodies.count; i += 1) {
    const o = i * 3;
    const px = p[o]!, py = p[o + 1]!, pz = p[o + 2]!;
    let vx = v[o]!, vy = v[o + 1]!, vz = v[o + 2]!;
    let nx = px + vx * dt, ny = py + vy * dt, nz = pz + vz * dt;
    let bounced = false;

    if (kind[i] === SHELL) {
      const scale = outer[i]! / Math.hypot(nx, ny, nz);
      nx *= scale; ny *= scale; nz *= scale;
      if (inCut(nx, ny, nz)) {
        // The body was outside the cut, so at least one plane was on the
        // right side before this step; that is the plane it just crossed.
        if (px >= 0) vx = -vx;
        else if (py <= 0) vy = -vy;
        else vz = -vz;
        bounced = true;
      }
    } else {
      const wall = WALL_PLANES[plane[i]!]!;
      next[0] = nx; next[1] = ny; next[2] = nz;
      vel[0] = vx; vel[1] = vy; vel[2] = vz;
      if (next[wall.a]! * wall.signA < 0) { vel[wall.a] = -vel[wall.a]!; bounced = true; }
      if (next[wall.b]! * wall.signB < 0) { vel[wall.b] = -vel[wall.b]!; bounced = true; }
      const r = Math.hypot(nx, ny, nz);
      if (!bounced && r > 0 && (r > outer[i]! || r < inner[i]!)) {
        // Reflect off the arc: flip the radial part of the velocity.
        const dot = (vel[0]! * nx + vel[1]! * ny + vel[2]! * nz) / (r * r);
        vel[0] = vel[0]! - 2 * dot * nx;
        vel[1] = vel[1]! - 2 * dot * ny;
        vel[2] = vel[2]! - 2 * dot * nz;
        bounced = true;
      }
      vx = vel[0]!; vy = vel[1]!; vz = vel[2]!;
    }

    if (bounced) {
      // Stay put this step; the reflected velocity carries the body back in.
      nx = px; ny = py; nz = pz;
    }
    if (kind[i] === SHELL) {
      // Keep the velocity tangent to the sphere at the new point, at its speed.
      const speed = Math.hypot(vx, vy, vz);
      const r2 = nx * nx + ny * ny + nz * nz;
      const radial = (vx * nx + vy * ny + vz * nz) / r2;
      vx -= radial * nx; vy -= radial * ny; vz -= radial * nz;
      const tangent = Math.hypot(vx, vy, vz) || 1;
      vx *= speed / tangent; vy *= speed / tangent; vz *= speed / tangent;
    }
    p[o] = nx; p[o + 1] = ny; p[o + 2] = nz;
    v[o] = vx; v[o + 1] = vy; v[o + 2] = vz;
  }
}
