/**
 * Loads the technology schematic only when its figure nears the screen.
 *
 * The schematic and three.js are a separate build entry, so the landing page
 * itself carries none of it: a reader who never scrolls to the section never
 * downloads it. The figure names the entry in `data-tech-src`; in development
 * that is the source file, and the build rewrites it to the hashed bundle (see
 * `rally-technology-entry` in vite.config.ts).
 */
const figure = document.querySelector<HTMLElement>('[data-tech-schematic]');
const source = figure?.dataset.techSrc;

if (figure && source) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    const script = document.createElement('script');
    script.type = 'module';
    script.src = source;
    document.head.append(script);
  }, { rootMargin: '400px 0px' });
  observer.observe(figure);
}

export {};
