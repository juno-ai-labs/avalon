/**
 * The site's motion, all optional: the page reads the same without it.
 *
 * - `.reveal` elements rise in as they reach the screen. They are only hidden
 *   once this script has added `motion` to the root, so a page whose script
 *   fails still shows everything.
 * - `[data-live-canvas]` plays its scene. The markup ships with every step on
 *   (the finished scene); this clears the steps and turns them on one at a
 *   time while the scene is on screen, then holds and starts again.
 * - The header gains its rule once the page has scrolled, and turns to ink
 *   while an ink block (`.night`, or the footer) sits under it. It does this even with
 *   reduced motion, since it is a colour change and not movement.
 *
 * With reduced motion asked for, none of it runs.
 */
const STEP_MS = [900, 1200, 1300, 2200, 1800, 1700, 1200, 4800] as const;
const LAST_STEP = STEP_MS.length - 1;

function playScene(stage: HTMLElement): void {
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = false;
  const show = (n: number): void => {
    for (let index = 1; index <= LAST_STEP; index += 1) stage.classList.toggle(`is-${index}`, index <= n);
  };
  const advance = (): void => {
    step = step >= LAST_STEP ? 0 : step + 1;
    show(step);
    if (visible) timer = setTimeout(advance, STEP_MS[step]);
  };
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    clearTimeout(timer);
    if (visible) timer = setTimeout(advance, STEP_MS[step]);
  }, { threshold: 0.25 }).observe(stage);
  show(step);
}

function revealOnScroll(): void {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));
}

function ruleHeader(): void {
  const header = document.querySelector('.site-header');
  if (!header) return;
  const nights = Array.from(document.querySelectorAll('.night, .rally-footer'));
  const update = (): void => {
    header.classList.toggle('scrolled', scrollY > 8);
    const line = header.getBoundingClientRect().bottom;
    header.classList.toggle('on-night', nights.some((night) => {
      const box = night.getBoundingClientRect();
      return box.top <= line && box.bottom > line;
    }));
  };
  update();
  addEventListener('scroll', update, { passive: true });
}

ruleHeader();
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('motion');
  revealOnScroll();
  document.querySelectorAll<HTMLElement>('[data-live-canvas]').forEach(playScene);
}

export {};
