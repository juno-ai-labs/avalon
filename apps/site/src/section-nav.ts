/**
 * Marks the current section in any `nav[data-section-nav]` whose links point at
 * `#id` sections. A section becomes current once its own heading has entered the
 * viewport and the previous section's heading has scrolled under the sticky
 * header, so a long section stays current until the next one is on screen.
 */
const HEADER_HEIGHT = 72;

function track(nav: HTMLElement): void {
  const links = Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'));
  const headings = links.map((link) =>
    document.getElementById(link.hash.slice(1))?.querySelector<HTMLElement>('h2') ?? null,
  );
  let current = -1;
  let queued = false;

  const update = (): void => {
    queued = false;
    let next = 0;
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1]?.getBoundingClientRect();
      const heading = headings[index]?.getBoundingClientRect();
      if (previous && heading && previous.bottom <= HEADER_HEIGHT && heading.top < innerHeight) next = index;
    }
    if (next === current) return;
    links[current]?.removeAttribute('aria-current');
    links[next]?.setAttribute('aria-current', 'true');
    current = next;
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  update();
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
}

document.querySelectorAll<HTMLElement>('nav[data-section-nav]').forEach(track);
