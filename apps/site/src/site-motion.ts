/**
 * The marketing pages' motion: the Canvas demo's timeline and the scroll
 * reveals. Both are progressive: with no script, or with reduced motion, every
 * element is in its final state and nothing moves.
 *
 * The demo is a set of steps. Each step adds a class `s<n>` to the figure, so
 * CSS can place cursors per step, and turns on every `[data-at]` element whose
 * step has arrived. The loop only runs while the figure is on screen.
 */
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Seconds each step holds before the next. The last one holds, then the loop restarts. */
const STEP_HOLD = [1.2, 2.4, 2.8, 2.6, 2.2, 4.8] as const;
const LAST = STEP_HOLD.length - 1;

function runDemo(demo: HTMLElement): void {
  const parts = Array.from(demo.querySelectorAll<HTMLElement>('[data-at]'));
  const show = (step: number): void => {
    for (let n = 1; n <= LAST; n += 1) demo.classList.toggle(`s${n}`, n <= step);
    for (const part of parts) part.classList.toggle('is-on', Number(part.dataset.at) <= step);
  };
  if (reduced) {
    show(LAST);
    return;
  }
  let step = 0;
  let timer = 0;
  let visible = false;
  const tick = (): void => {
    step = step >= LAST ? 0 : step + 1;
    show(step);
    timer = window.setTimeout(tick, (STEP_HOLD[step] ?? 2) * 1000);
  };
  show(0);
  new IntersectionObserver(([entry]) => {
    const next = entry?.isIntersecting ?? false;
    if (next === visible) return;
    visible = next;
    window.clearTimeout(timer);
    if (visible) timer = window.setTimeout(tick, (STEP_HOLD[step] ?? 2) * 1000);
  }).observe(demo);
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

export {};
