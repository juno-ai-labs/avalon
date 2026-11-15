/**
 * The marketing pages' motion: the Canvas demo's timeline and the scroll
 * reveals. Both are progressive: with no script, or with reduced motion, every
 * element is in its final state and nothing moves.
 *
 * The demo is a set of steps, set with `applyStep` (steps.ts): CSS places the
 * cursors per step. The loop only runs while the figure is on screen.
 */
import { applyStep, reducedMotion as reduced, whenVisible } from './steps';

/**
 * Seconds each step holds before the next. The last one holds, then the loop
 * restarts. The story is a reactive Canvas first, then the team in it: a Linear
 * issue closes (1), a Slack message moves the date (2) and a call's notes land
 * (3), each publishing a new version; then Maya asks (4), and Rally answers
 * while Theo comments (5).
 */
const STEP_HOLD = [1.4, 2.8, 2.8, 2.8, 2.2, 5.5] as const;
const LAST = STEP_HOLD.length - 1;

function runDemo(demo: HTMLElement): void {
  const show = (step: number): void => applyStep(demo, step, LAST);
  if (reduced) {
    show(LAST);
    return;
  }
  let step = 0;
  let timer = 0;
  let visible = false;
  let held = false;
  const schedule = (): void => {
    window.clearTimeout(timer);
    if (visible && !held) timer = window.setTimeout(tick, (STEP_HOLD[step] ?? 2) * 1000);
  };
  // Moving content needs a way to stop it (WCAG 2.2.2).
  const pause = demo.querySelector<HTMLButtonElement>('[data-demo-pause]');
  if (pause) {
    pause.hidden = false;
    pause.addEventListener('click', () => {
      held = !held;
      pause.setAttribute('aria-pressed', String(held));
      pause.setAttribute('aria-label', held ? 'Play the demo' : 'Pause the demo');
      schedule();
    });
  }
  const tick = (): void => {
    step = step >= LAST ? 0 : step + 1;
    show(step);
    schedule();
  };
  show(0);
  whenVisible(demo, (next) => { visible = next; schedule(); });
}

function reveal(): void {
  const items = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (reduced || items.length === 0) return;
  document.documentElement.classList.add('reveals');
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  items.forEach((item) => observer.observe(item));
}

document.querySelectorAll<HTMLElement>('[data-demo]').forEach(runDemo);
reveal();

