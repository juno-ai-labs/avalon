/**
 * Plays the hero carousel that `renderLiveCarousel` (live-examples.ts) writes.
 *
 * Each slide steps through its events: step n turns on every `[data-at]` at or
 * below n, ticks every `[data-done]` row at or below n, marks what changed at
 * this step with `is-new`, and moves the version and byline on. When a slide
 * finishes, the next audience's slide takes over. It only runs on screen, a
 * chosen tab plays its slide from the start, and the pause button stops it.
 * With reduced motion nothing rotates and every slide shows its end.
 */
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Seconds each step holds: the opening state, three events, the person's tick. */
const STEP_HOLD = [1.4, 2.4, 2.4, 2.4, 4.6] as const;
const STEPS = STEP_HOLD.length - 1;

/**
 * The moment of change, played only when a slide steps forward: a dot leaves
 * the event that caused it and lands on the row it changed, and the version
 * number ticks over.
 */
function animateChange(slide: HTMLElement, step: number): void {
  const art = slide.querySelector<HTMLElement>('.slide-art');
  const source = slide.querySelector<HTMLElement>(`.signal[data-at="${step}"]`);
  const target = slide.querySelector<HTMLElement>(`.live-row[data-at="${step}"], .live-row[data-done="${step}"]`)
    ?? slide.querySelector<HTMLElement>('.live-status');
  const version = slide.querySelector<HTMLElement>('[data-live-version]');
  if (step <= 3) version?.animate([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 500, easing: 'cubic-bezier(.2,.8,.2,1)' });
  if (!art || !source || !target || step > 3) return;
  const box = art.getBoundingClientRect();
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const dot = document.createElement('span');
  dot.className = 'live-fly';
  art.append(dot);
  const x0 = from.left + from.width / 2 - box.left;
  const y0 = from.top + from.height / 2 - box.top;
  const x1 = to.left + 18 - box.left;
  const y1 = to.top + to.height / 2 - box.top;
  dot.animate([
    { transform: `translate(${x0}px, ${y0}px) scale(.6)`, opacity: 0 },
    { transform: `translate(${x0}px, ${y0}px) scale(1)`, opacity: 1, offset: 0.15 },
    { transform: `translate(${x1}px, ${y1}px) scale(1)`, opacity: 1, offset: 0.85 },
    { transform: `translate(${x1}px, ${y1}px) scale(2.4)`, opacity: 0 },
  ], { duration: 900, easing: 'cubic-bezier(.5,0,.2,1)' }).finished.then(() => dot.remove(), () => dot.remove());
}

function showStep(slide: HTMLElement, step: number): void {
  slide.dataset.step = String(step);
  for (const line of slide.querySelectorAll<HTMLElement>('[data-status]')) {
    line.classList.toggle('is-current', Number(line.dataset.status) === step);
  }
  const version = Number(slide.dataset.version);
  const events = Array.from(slide.querySelectorAll<HTMLElement>('.signal'));
  for (const part of slide.querySelectorAll<HTMLElement>('[data-at]')) {
    const at = Number(part.dataset.at);
    part.classList.toggle('is-on', at <= step);
    part.classList.toggle('is-new', at === step && at > 0);
  }
  for (const row of slide.querySelectorAll<HTMLElement>('[data-done]')) {
    const done = Number(row.dataset.done);
    row.classList.toggle('is-done', done <= step);
    if (done === step && step > 0) row.classList.add('is-new');
  }
  const eventsSeen = Math.min(step, events.length);
  const versionLabel = slide.querySelector('[data-live-version]');
  if (versionLabel) versionLabel.textContent = `v${version + eventsSeen}`;
  const byline = slide.querySelector<HTMLElement>('[data-live-byline]');
  const source = events[eventsSeen - 1]?.querySelector('.signal-tool')?.textContent;
  if (byline) {
    byline.dataset.baseText ??= byline.textContent?.replace(/ · after .*$/u, '') ?? '';
    byline.textContent = source ? `${byline.dataset.baseText} · after ${source}` : `${byline.dataset.baseText} · yesterday`;
    byline.classList.toggle('is-fresh', eventsSeen > 0 && step <= events.length);
  }
}

function run(carousel: HTMLElement): void {
  const tabs = Array.from(carousel.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const slides = Array.from(carousel.querySelectorAll<HTMLElement>('[data-slide]'));
  let current = 0;
  let step = 0;
  let timer = 0;
  let visible = false;
  let held = false;

  const select = (index: number, focus = false): void => {
    current = (index + slides.length) % slides.length;
    tabs.forEach((tab, i) => {
      const on = i === current;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      setBar(i, 0, 0);
    });
    slides.forEach((slide, i) => {
      slide.hidden = i !== current;
      slide.classList.toggle('is-active', i === current);
    });
    if (focus) tabs[current]?.focus();
    // Keep the chosen tab in view in the scrolling tab row, without moving the page.
    const strip = tabs[current]?.parentElement;
    const tab = tabs[current];
    if (visible && strip && tab) strip.scrollTo({ left: tab.offsetLeft - strip.offsetWidth / 2 + tab.offsetWidth / 2, behavior: reduced ? 'auto' : 'smooth' });
    step = reduced ? STEPS : 0;
    showStep(slides[current]!, step);
    schedule();
  };

  const tick = (): void => {
    if (step < STEPS) {
      step += 1;
      // The row lands first, then the dot flies to where it now sits.
      showStep(slides[current]!, step);
      const slide = slides[current]!;
      const at = step;
      window.setTimeout(() => animateChange(slide, at), 380);
      schedule();
    } else {
      select(current + 1);
    }
  };

  /** The active tab's bar fills one step at a time, over that step's hold. */
  function setBar(index: number, fraction: number, seconds: number): void {
    const bar = tabs[index]?.querySelector<HTMLElement>('.carousel-progress');
    if (!bar) return;
    bar.style.transitionDuration = `${seconds}s`;
    bar.style.transform = `scaleX(${fraction})`;
  }

  function schedule(): void {
    window.clearTimeout(timer);
    const running = !reduced && visible && !held;
    carousel.classList.toggle('is-paused', !running);
    const hold = STEP_HOLD[step] ?? 2;
    setBar(current, running ? (step + 1) / (STEPS + 1) : step / (STEPS + 1), running ? hold : 0.2);
    if (running) timer = window.setTimeout(tick, hold * 1000);
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      // Choosing an example is a request to see it, so it plays even if paused.
      if (held && pause) pause.click();
      select(index);
    });
    tab.addEventListener('keydown', (event) => {
      const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (move) { event.preventDefault(); select(current + move, true); }
      if (event.key === 'Home') { event.preventDefault(); select(0, true); }
      if (event.key === 'End') { event.preventDefault(); select(slides.length - 1, true); }
    });
  });
  const pause = carousel.querySelector<HTMLButtonElement>('[data-carousel-pause]');
  if (pause && !reduced) {
    pause.hidden = false;
    pause.addEventListener('click', () => {
      held = !held;
      pause.setAttribute('aria-label', held ? 'Play the examples' : 'Pause the examples');
      pause.setAttribute('aria-pressed', String(held));
      schedule();
    });
  }
  new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; schedule(); }).observe(carousel);

  // Every slide but the shown one starts at its end, so a reader who picks a
  // tab without motion, or before it plays, still sees the whole artifact.
  slides.forEach((slide) => showStep(slide, STEPS));
  select(0);
}

document.querySelectorAll<HTMLElement>('[data-carousel]').forEach(run);

export {};
