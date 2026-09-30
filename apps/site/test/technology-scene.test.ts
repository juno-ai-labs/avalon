import "../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import { LOOP, MOMENTS, stateAt } from '../src/technology-scene';

describe('technology schematic timeline', () => {
  it('starts as a bare starfield', () => {
    const state = stateAt(MOMENTS.starfield);
    expect(state.form).toEqual([0, 0, 0, 0, 0]);
    expect(state.labels).toEqual([0, 0, 0, 0]);
    expect(state.ball).toBe(0);
    expect(state.scatter).toBe(0);
  });

  it('forms the layers from the core outward, labeling each once it stands', () => {
    const sidekicks = stateAt(MOMENTS.layers[1]!);
    expect(sidekicks.form).toEqual([1, 1, 0, 0, 0]);
    expect(sidekicks.labels).toEqual([1, 1, 0, 0]);
  });

  it('holds every layer and label in the final state with the cut still open', () => {
    const state = stateAt(MOMENTS.final);
    expect(state.form).toEqual([1, 1, 1, 1, 0]);
    expect(state.labels).toEqual([1, 1, 1, 1]);
    expect(state.ball).toBe(0);
  });

  it('fills the cut and drops the labels before the ball spins', () => {
    const filled = stateAt(MOMENTS.filled);
    expect(filled.form[4]).toBe(1);
    expect(filled.labels).toEqual([0, 0, 0, 0]);
    expect(filled.spin).toBe(0);
    const ball = stateAt(MOMENTS.ball);
    expect(ball.ball).toBe(1);
    expect(ball.spin).toBeGreaterThan(0);
  });

  it('ends fully scattered and wraps to the same starfield it began with', () => {
    expect(stateAt(LOOP - 0.001).scatter).toBeCloseTo(1, 2);
    expect(stateAt(LOOP + MOMENTS.starfield)).toEqual(stateAt(MOMENTS.starfield));
  });
});
