/**
 * Pong for the "can't connect" screen, as plain state and one step function so
 * the rules run without a canvas. Units are field units; the canvas scales them.
 * The person plays the left paddle, Rally the right one.
 */

export const FIELD = { width: 480, height: 200 } as const;
export const PADDLE = { width: 6, height: 40, inset: 12 } as const;
export const BALL_RADIUS = 4;

const SERVE_SPEED = 220;
// Each return speeds the ball up, so a long rally ends on its own.
const SPEEDUP = 1.05;
// Rally's paddle is slower than the ball gets, so it can be beaten.
const RALLY_PADDLE_SPEED = 170;

export interface RallyState {
  ball: { x: number; y: number; vx: number; vy: number };
  /** Paddle centres. */
  player: number;
  opponent: number;
  /** Returns by the person in the current rally, and the best so far. */
  rally: number;
  best: number;
}

export function serve(state: Pick<RallyState, 'best'> & Partial<RallyState>, direction: 1 | -1 = 1): RallyState {
  return {
    ball: { x: FIELD.width / 2, y: FIELD.height / 2, vx: SERVE_SPEED * direction, vy: SERVE_SPEED * 0.35 },
    player: state.player ?? FIELD.height / 2,
    opponent: state.opponent ?? FIELD.height / 2,
    rally: 0,
    best: state.best,
  };
}

function clampPaddle(y: number): number {
  return Math.min(FIELD.height - PADDLE.height / 2, Math.max(PADDLE.height / 2, y));
}

function hits(paddleY: number, ballY: number): boolean {
  return Math.abs(ballY - paddleY) <= PADDLE.height / 2 + BALL_RADIUS;
}

/** The ball leaves a paddle at an angle set by where on the paddle it landed. */
function returned(speed: number, paddleY: number, ballY: number, direction: 1 | -1): { vx: number; vy: number } {
  const offset = (ballY - paddleY) / (PADDLE.height / 2);
  const angle = offset * (Math.PI / 4);
  return { vx: Math.cos(angle) * speed * direction, vy: Math.sin(angle) * speed };
}

/** Advance by `seconds`, with the person's paddle aimed at `playerTarget`. */
export function stepRally(state: RallyState, playerTarget: number, seconds: number): RallyState {
  const player = clampPaddle(playerTarget);
  const chase = Math.max(-RALLY_PADDLE_SPEED * seconds, Math.min(RALLY_PADDLE_SPEED * seconds, state.ball.y - state.opponent));
  const opponent = clampPaddle(state.opponent + chase);
  let { x, y, vx, vy } = state.ball;
  x += vx * seconds;
  y += vy * seconds;
  if (y < BALL_RADIUS) { y = BALL_RADIUS; vy = Math.abs(vy); }
  if (y > FIELD.height - BALL_RADIUS) { y = FIELD.height - BALL_RADIUS; vy = -Math.abs(vy); }

  const speed = Math.hypot(vx, vy) * SPEEDUP;
  const playerFace = PADDLE.inset + PADDLE.width;
  const opponentFace = FIELD.width - PADDLE.inset - PADDLE.width;
  let { rally, best } = state;

  if (vx < 0 && x - BALL_RADIUS <= playerFace && x >= PADDLE.inset && hits(player, y)) {
    ({ vx, vy } = returned(speed, player, y, 1));
    x = playerFace + BALL_RADIUS;
    rally += 1;
    best = Math.max(best, rally);
  } else if (vx > 0 && x + BALL_RADIUS >= opponentFace && x <= FIELD.width - PADDLE.inset && hits(opponent, y)) {
    ({ vx, vy } = returned(speed, opponent, y, -1));
    x = opponentFace - BALL_RADIUS;
  }

  // Past either paddle the rally is over; serve again toward whoever missed.
  if (x < -BALL_RADIUS) return serve({ best, player, opponent }, -1);
  if (x > FIELD.width + BALL_RADIUS) return serve({ best, player, opponent }, 1);
  return { ball: { x, y, vx, vy }, player, opponent, rally, best };
}
