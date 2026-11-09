/**
 * The site's motion, all optional: the page reads the same without it.
 *
 * - `.reveal` elements rise in as they reach the screen. They are only hidden
 *   once this script has added `motion` to the root, so a page whose script
 *   fails still shows everything.
 * - The header gains its rule once the page has scrolled, and turns to ink
 *   while an ink block (`.night`, or the footer) sits under it. It does this even with
 *   reduced motion, since it is a colour change and not movement.
 *
 * The hero carousel and the explainers have their own modules
 * (`live-carousel.ts`, `explainers.ts`). With reduced motion asked for, only
 * the header runs here.
 */
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
}

export {};
