import { describe, expect, it } from 'vitest';
import { FIELD, PADDLE, serve, stepRally, type RallyState } from './rally-pong-physics';

function ballAt(state: RallyState, x: number, y: number, vx: number): RallyState {
  return { ...state, ball: { x, y, vx, vy: 0 } };
}

describe('stepRally', () => {
  it('returns a ball that meets the person’s paddle and counts the return', () => {
    const start = ballAt(serve({ best: 0 }), PADDLE.inset + PADDLE.width + 6, 100, -220);
    const next = stepRally(start, 100, 0.02);
    expect(next.ball.vx).toBeGreaterThan(0);
    expect(next.rally).toBe(1);
    expect(next.best).toBe(1);
  });

  it('ends the rally on a miss, serves again, and keeps the best', () => {
    const start = { ...ballAt(serve({ best: 4 }), 1, 20, -220), rally: 3 };
    const next = stepRally(start, FIELD.height - 10, 0.05);
    expect(next.rally).toBe(0);
    expect(next.best).toBe(4);
    expect(next.ball.x).toBe(FIELD.width / 2);
  });

  it('keeps the person’s paddle inside the field', () => {
    const next = stepRally(serve({ best: 0 }), -500, 0.01);
    expect(next.player).toBe(PADDLE.height / 2);
  });

  it('bounces off the top wall', () => {
    const start = { ...serve({ best: 0 }), ball: { x: 200, y: 5, vx: 100, vy: -200 } };
    expect(stepRally(start, 100, 0.02).ball.vy).toBeGreaterThan(0);
  });
});
