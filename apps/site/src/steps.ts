/**
 * The step primitive the Canvas demo (site-motion.ts) and the hero carousel
 * (live-carousel.ts) share. A figure is drawn in its finished state at build
 * time; `applyStep` puts it at any step n:
 *
 * - `s1` … `s<n>` on the root, so CSS can place things per step;
 * - `is-on` on every `[data-at]` at or below n;
 * - `is-done` on every `[data-done]` at or below n;
 * - `is-current` on the `[data-status]` equal to n;
 * - `is-new` on what changed at n, when the step is played rather than set.
 *
 * Each caller owns its own timing and what else it draws.
 */
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function applyStep(root: HTMLElement, step: number, last: number, played = true): void {
  root.dataset.step = String(step);
  for (let n = 1; n <= last; n += 1) root.classList.toggle(`s${n}`, n <= step);
  for (const part of root.querySelectorAll<HTMLElement>('[data-at]')) {
    const at = Number(part.dataset.at);
    part.classList.toggle('is-on', at <= step);
    part.classList.toggle('is-new', played && at === step && at > 0);
  }
  for (const part of root.querySelectorAll<HTMLElement>('[data-done]')) {
    const done = Number(part.dataset.done);
    part.classList.toggle('is-done', done <= step);
    if (played && done === step && step > 0) part.classList.add('is-new');
  }
  for (const line of root.querySelectorAll<HTMLElement>('[data-status]')) {
    line.classList.toggle('is-current', Number(line.dataset.status) === step);
  }
}

/** Calls `change` with whether `element` is on screen, each time that flips. */
export function whenVisible(element: Element, change: (visible: boolean) => void, threshold = 0): void {
  let visible: boolean | undefined;
  new IntersectionObserver(([entry]) => {
    const next = entry?.isIntersecting ?? false;
    if (next === visible) return;
    visible = next;
    change(next);
  }, { threshold }).observe(element);
}
