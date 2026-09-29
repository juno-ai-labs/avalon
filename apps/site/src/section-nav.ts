/**
 * Marks the current section in any `nav[data-section-nav]` whose links point at
 * `#id` sections. Nothing is current until the first section's heading is on
 * screen. After that, a section becomes current once its own heading is on
 * screen and the previous section's heading has scrolled under the sticky
 * header, so a long section stays current until the next one appears. At the
 * bottom of the page a short final section can never push the one before it
 * under the header, so there the linked section wins if its heading is on
 * screen (the reader just clicked it), and otherwise the last heading on screen.
 */
function track(nav: HTMLElement): void {
  const links = Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'));
  const headings = links.map((link) =>
    document.getElementById(link.hash.slice(1))?.querySelector<HTMLElement>('h2') ?? null,
  );
  const header = document.querySelector<HTMLElement>('body > header');
  let current = -1;
  let queued = false;

  const update = (): void => {
    queued = false;
    const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 1;
    const boxes = headings.map((heading) => heading?.getBoundingClientRect());
    let next = -1;
    boxes.forEach((box, index) => {
      if (!box || box.top >= innerHeight) return;
      const previous = boxes[index - 1];
      if (index === 0 || atBottom || (previous && previous.bottom <= headerBottom)) next = index;
    });
    const linked = links.findIndex((link) => link.hash === location.hash);
    const linkedBox = boxes[linked];
    if (atBottom && linkedBox && linkedBox.bottom > 0 && linkedBox.top < innerHeight) next = linked;
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
  addEventListener('hashchange', schedule);
}

document.querySelectorAll<HTMLElement>('nav[data-section-nav]').forEach(track);
