import { createSchematic, MOMENTS } from './technology-scene';

/**
 * Runs the technology schematic. `technology-loader.ts` loads this entry only
 * once the figure nears the screen. The clock runs only while the figure is
 * visible: a first-time reader arrives at the starfield, a returning one picks
 * up where they left, and an off-screen figure costs nothing.
 */
const figure = document.querySelector<HTMLElement>('[data-tech-schematic]');
const canvas = figure?.querySelector('canvas');
const overlay = figure?.querySelector('svg');

if (figure && canvas && overlay) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // The descriptions come from the layer list under the figure, in the same
  // order as LAYERS, so the copy is written once.
  const details = Array.from(document.querySelectorAll('.tech-layers p'), (item) => item.textContent ?? '');
  const schematic = createSchematic(canvas, overlay, details);
  // Hidden until the viewport observer says otherwise: the loader's margin
  // starts the scene early, but only an on-screen figure advances the clock.
  let visible = false;
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
}
