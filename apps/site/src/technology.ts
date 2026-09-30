import { createSchematic, MOMENTS } from './technology-scene';

/**
 * Starts the technology schematic once its figure nears the screen, so the GPU
 * does no work for a reader who never scrolls that far. The clock runs only
 * while the figure is visible: a reader always arrives at the starfield, and an
 * off-screen figure costs nothing.
 */
const figure = document.querySelector<HTMLElement>('[data-tech-schematic]');
const canvas = figure?.querySelector('canvas');
const overlay = figure?.querySelector('svg');

if (figure && canvas && overlay) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let started = false;

  const start = (): void => {
    started = true;
    const schematic = createSchematic(canvas, overlay);
    figure.dataset.ready = 'true';
    let visible = true;
    let clock = 0;
    let last = -1;
    let frame = 0;

    const tick = (now: number): void => {
      if (last >= 0) clock += Math.min(0.1, Math.max(0, now - last) / 1000);
      last = now;
      schematic.render(clock);
      frame = requestAnimationFrame(tick);
    };
    const play = (): void => {
      cancelAnimationFrame(frame);
      if (reduced.matches) {
        schematic.render(MOMENTS.final);
        return;
      }
      if (!visible) return;
      last = -1;
      frame = requestAnimationFrame(tick);
    };

    new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      play();
    }).observe(figure);
    new ResizeObserver(() => {
      schematic.resize();
      if (reduced.matches || !visible) schematic.render(reduced.matches ? MOMENTS.final : clock);
    }).observe(canvas);
    reduced.addEventListener('change', play);
    play();
  };

  new IntersectionObserver((entries, observer) => {
    if (started || !entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    start();
  }, { rootMargin: '400px 0px' }).observe(figure);
}
