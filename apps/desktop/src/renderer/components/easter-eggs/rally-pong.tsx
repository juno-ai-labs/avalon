import { useEffect, useRef, useState } from 'react';
import { BALL_RADIUS, FIELD, PADDLE, serve, stepRally, type RallyState } from './rally-pong-physics';

// How far a held arrow key moves the paddle each second.
const KEY_SPEED = 260;

function token(element: Element, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

/**
 * The Pong the "can't connect" screen opens: mouse, arrow keys or W/S move the
 * left paddle, Escape puts it away. Nothing runs until somebody starts it.
 */
export function RallyPong({ onClose }: { onClose: () => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState({ rally: 0, best: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Ours, not the window's: some windows close on Escape.
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const context = canvas.getContext('2d');
    if (!context) return;
    let state: RallyState = serve({ best: 0 });
    let target = state.player;
    const held = new Set<'up' | 'down'>();
    const ink = token(canvas, 'color') || '#111';
    const accent = token(document.documentElement, '--av-sys-color-accent-base') || ink;

    const onPointer = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      target = ((event.clientY - bounds.top) / bounds.height) * FIELD.height;
    };
    const direction = (key: string) => (key === 'ArrowUp' || key === 'w' ? 'up' : key === 'ArrowDown' || key === 's' ? 'down' : null);
    const onKeyDown = (event: KeyboardEvent) => {
      const move = direction(event.key);
      if (move) { event.preventDefault(); held.add(move); }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const move = direction(event.key);
      if (move) held.delete(move);
    };

    let last = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      // A hidden window stops frames; one long step would carry the ball
      // through a paddle, so a resumed game moves at most one short step.
      const seconds = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      if (held.has('up')) target -= KEY_SPEED * seconds;
      if (held.has('down')) target += KEY_SPEED * seconds;
      target = Math.min(FIELD.height, Math.max(0, target));
      state = stepRally(state, target, seconds);
      setScore((current) => current.rally === state.rally && current.best === state.best ? current : { rally: state.rally, best: state.best });

      const scale = canvas.width / FIELD.width;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, FIELD.width, FIELD.height);
      context.fillStyle = ink;
      context.globalAlpha = 0.2;
      for (let y = 4; y < FIELD.height; y += 14) context.fillRect(FIELD.width / 2 - 1, y, 2, 7);
      context.globalAlpha = 1;
      context.fillRect(PADDLE.inset, state.player - PADDLE.height / 2, PADDLE.width, PADDLE.height);
      context.fillRect(FIELD.width - PADDLE.inset - PADDLE.width, state.opponent - PADDLE.height / 2, PADDLE.width, PADDLE.height);
      context.fillStyle = accent;
      context.beginPath();
      context.arc(state.ball.x, state.ball.y, BALL_RADIUS, 0, Math.PI * 2);
      context.fill();
      frame = requestAnimationFrame(draw);
    };

    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.width * (FIELD.height / FIELD.width);
    canvas.addEventListener('pointermove', onPointer);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', onPointer);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  return (
    <div className="rally-pong">
      <canvas aria-label="Pong. Move your paddle with the mouse or the arrow keys." ref={canvasRef} role="img" />
      <p className="rally-pong-score">Rally {score.rally} · Best {score.best}</p>
    </div>
  );
}
