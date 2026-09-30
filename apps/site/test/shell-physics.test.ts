import "../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import { createBodies, inCut, SHELL, step, WALL } from '../src/shell-physics';

const shell = (x: number, y: number, z: number, vx: number, vy: number, vz: number) => {
  const bodies = createBodies(1);
  bodies.kind[0] = SHELL;
  bodies.outer[0] = Math.hypot(x, y, z);
  bodies.position.set([x, y, z]);
  bodies.velocity.set([vx, vy, vz]);
  return bodies;
};

describe('shell physics', () => {
  it('bounces a shell body off the cut plane it runs into', () => {
    // On the unit sphere just right of the x = 0 plane, heading into the cut.
    const bodies = shell(0.01, 0.7, 0.714, -1, 0, 0);
    step(bodies, 0.05);
    expect(bodies.velocity[0]).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) step(bodies, 0.05);
    const [x, y, z] = bodies.position;
    expect(inCut(x!, y!, z!)).toBe(false);
    expect(x).toBeGreaterThan(0.01);
  });

  it('keeps shell bodies on their sphere, out of the cut, and at their speed', () => {
    const count = 400;
    const bodies = createBodies(count);
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2;
      const y = Math.cos(i * 2.4) * 0.9;
      const r = Math.sqrt(1 - y * y);
      let x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (inCut(x, y, z)) x = -x;
      bodies.kind[i] = SHELL;
      bodies.outer[i] = 2;
      bodies.position.set([x * 2, y * 2, z * 2], i * 3);
      // A tangent direction: the cross product of the radius with the y axis,
      // or with the x axis near the poles.
      const t = Math.abs(y) < 0.8 ? [-z, 0, x] : [0, z, -y];
      const n = Math.hypot(t[0]!, t[1]!, t[2]!);
      bodies.velocity.set(t.map((c) => (c / n) * 0.3), i * 3);
    }
    for (let s = 0; s < 3000; s += 1) step(bodies, 1 / 30);
    for (let i = 0; i < count; i += 1) {
      const [x, y, z] = bodies.position.subarray(i * 3, i * 3 + 3);
      const [vx, vy, vz] = bodies.velocity.subarray(i * 3, i * 3 + 3);
      expect(Math.hypot(x!, y!, z!)).toBeCloseTo(2, 3);
      expect(inCut(x!, y!, z!)).toBe(false);
      expect(Math.hypot(vx!, vy!, vz!)).toBeCloseTo(0.3, 3);
    }
  });

  it('keeps wall bodies inside their quarter-ring and bounces them off its arcs', () => {
    const bodies = createBodies(2);
    // Wall 0 lies in z = 0 with x <= 0 and y >= 0, between radii 1 and 2.
    for (const i of [0, 1]) {
      bodies.kind[i] = WALL;
      bodies.plane[i] = 0;
      bodies.inner[i] = 1;
      bodies.outer[i] = 2;
    }
    bodies.position.set([-1.5, 0.5, 0, -1.2, 1.1, 0]);
    bodies.velocity.set([-0.7, 0.2, 0, 0.3, -0.9, 0]);
    let hitOuter = false;
    for (let s = 0; s < 2000; s += 1) {
      step(bodies, 1 / 30);
      for (const i of [0, 1]) {
        const [x, y, z] = bodies.position.subarray(i * 3, i * 3 + 3);
        const r = Math.hypot(x!, y!, z!);
        expect(z).toBe(0);
        expect(x).toBeLessThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(2);
        if (r > 1.9) hitOuter = true;
      }
    }
    expect(hitOuter).toBe(true);
  });
});
