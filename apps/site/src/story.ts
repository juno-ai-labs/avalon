/**
 * Plays every story on a page: an example page that changes as emails arrive.
 * The markup is hand-written per page and drawn at its last step, so it reads
 * with no script. This module rewinds it and plays it forward. The contract a
 * page's markup follows is in docs/site-audience-pages.md.
 *
 * A story is one or more slides. A slide has a `.story-mail`, where the ask
 * and then each email show one at a time, and one or more `.story-page`, the
 * page those emails change. Each step shows its email first and changes the
 * page a moment later, so the eye reads cause, then effect. This module only
 * keeps time: it sets each step's classes, and how a change looks is each
 * page's own stylesheet (and, for more, a `story:step` listener). It only runs on
 * screen, a chosen tab plays its slide from the start, and the pause button
 * stops it. With reduced motion nothing moves and every slide shows its end.
 */
import { applyStep, reducedMotion as reduced, whenVisible } from './steps';

/** Seconds the opening holds (the ask), each email holds, and the last one holds on top. */
const OPENING_HOLD = 2.8;
const STEP_HOLD = 3.4;
const CLOSING_HOLD = 2.2;
/** Milliseconds between an email showing and the page changing. */
const PAGE_DELAY = 700;

const lastStep = (slide: HTMLElement): number => Number(slide.dataset.steps ?? 3);

const parts = (slide: HTMLElement, selector: string): HTMLElement[] => Array.from(slide.querySelectorAll<HTMLElement>(selector));

/** Where each keyed element that leaves at `step` sits now, so its replacement can start from there. */
function leaving(slide: HTMLElement, step: number): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const part of parts(slide, `.story-page [data-key][data-until="${step}"]`)) {
    if (part.dataset.key) rects.set(part.dataset.key, part.getBoundingClientRect());
  }
  return rects;
}

/** Slides each keyed element that arrived at `step` in from where the one it replaces sat. */
function move(slide: HTMLElement, step: number, from: Map<string, DOMRect>): void {
  for (const part of parts(slide, `.story-page [data-key][data-at="${step}"]`)) {
    const start = part.dataset.key ? from.get(part.dataset.key) : undefined;
    if (!start) continue;
    const end = part.getBoundingClientRect();
    part.classList.add('is-moved');
    part.animate([
      { transform: `translate(${start.left - end.left}px, ${start.top - end.top}px)` },
      { transform: 'none' },
    ], { duration: 620, easing: 'cubic-bezier(.3,.7,.2,1)' });
  }
}

/** A dot leaves the email and lands on the first thing it changed. */
function fly(slide: HTMLElement, step: number): void {
  const source = slide.querySelector<HTMLElement>(`.story-mail [data-at="${step}"]`);
  const target = parts(slide, `.story-page [data-touch~="${step}"]`).find((part) => part.offsetParent !== null);
  if (!source || !target) return;
  const box = slide.getBoundingClientRect();
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const x0 = from.left + 22 - box.left;
  const y0 = from.bottom - 14 - box.top;
  const x1 = to.left + Math.min(to.width / 2, 28) - box.left;
  const y1 = to.top + to.height / 2 - box.top;
  const dot = document.createElement('span');
  dot.className = 'story-dot';
  slide.append(dot);
  dot.animate([
    { transform: `translate(${x0}px, ${y0}px) scale(.5)`, opacity: 0 },
    { transform: `translate(${x0}px, ${y0}px) scale(1)`, opacity: 1, offset: 0.15 },
    { transform: `translate(${x1}px, ${y1}px) scale(1)`, opacity: 1, offset: 0.85 },
    { transform: `translate(${x1}px, ${y1}px) scale(2.6)`, opacity: 0 },
  ], { duration: 640, easing: 'cubic-bezier(.5,0,.2,1)' }).finished.then(() => dot.remove(), () => dot.remove());
}

function run(story: HTMLElement): void {
  const tabs = Array.from(story.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const slides = Array.from(story.querySelectorAll<HTMLElement>('[data-slide]'));
  const stage = story.querySelector<HTMLElement>('.story-stage');
  const pause = story.querySelector<HTMLButtonElement>('[data-story-pause]');
  // A manual story stays on the slide a person chose and replays it.
  const manual = story.hasAttribute('data-story-manual');
  // The dot that flies from an email to what it changed is one page's motion, not every page's.
  const dot = story.hasAttribute('data-story-dot');
  const word = story.dataset.storyWord ? document.getElementById(story.dataset.storyWord) : null;
  if (!slides.length || !stage) return;
  let current = 0;
  let step = 0;
  let timer = 0;
  let pageTimer = 0;
  let visible = false;
  let held = false;

  /** Puts a slide at a step with nothing animated. */
  const set = (slide: HTMLElement, at: number): void => {
    slide.dataset.step = String(at);
    for (const root of parts(slide, '.story-mail, .story-page')) applyStep(root, at, lastStep(slide), false);
    for (const part of parts(slide, '.is-touched, .is-moved, .is-updated')) part.classList.remove('is-touched', 'is-moved', 'is-updated');
  };

  /** Plays a slide forward to a step: the email now, the page a moment later. */
  const play = (slide: HTMLElement, at: number): void => {
    slide.dataset.step = String(at);
    for (const root of parts(slide, '.story-mail')) applyStep(root, at, lastStep(slide));
    pageTimer = window.setTimeout(() => {
      const from = leaving(slide, at);
      for (const part of parts(slide, '.is-touched, .is-moved')) part.classList.remove('is-touched', 'is-moved');
      for (const root of parts(slide, '.story-page')) applyStep(root, at, lastStep(slide));
      move(slide, at, from);
      for (const part of parts(slide, `.story-page [data-touch~="${at}"]`)) part.classList.add('is-touched');
      // The page's "Updates itself" marker pulses each time an email changes it.
      for (const live of parts(slide, '.story-page .kit-live')) {
        live.classList.remove('is-updated');
        void live.offsetWidth;
        live.classList.add('is-updated');
      }
      if (dot) fly(slide, at);
      // A page's own script can add its own motion to the step.
      slide.dispatchEvent(new CustomEvent('story:step', { bubbles: true, detail: { step: at } }));
    }, PAGE_DELAY);
  };

  /** The active tab's bar fills one step at a time, over that step's hold. */
  const setBar = (index: number, fraction: number, seconds: number): void => {
    const bar = tabs[index]?.querySelector<HTMLElement>('.story-progress');
    if (!bar) return;
    bar.style.transitionDuration = `${seconds}s`;
    bar.style.transform = `scaleX(${fraction})`;
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    const running = !reduced && visible && !held;
    story.classList.toggle('is-paused', !running);
    const last = lastStep(slides[current]!);
    const hold = step === 0 ? OPENING_HOLD : step === last ? STEP_HOLD + CLOSING_HOLD : STEP_HOLD;
    setBar(current, running ? (step + 1) / (last + 1) : step / (last + 1), running ? hold : 0.2);
    if (running) timer = window.setTimeout(tick, hold * 1000);
  };

  const select = (index: number, chosen = false): void => {
    window.clearTimeout(pageTimer);
    current = (index + slides.length) % slides.length;
    tabs.forEach((tab, i) => {
      const on = i === current;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      setBar(i, 0, 0);
    });
    slides.forEach((slide, i) => {
      const on = i === current;
      slide.classList.toggle('is-active', on);
      slide.inert = !on;
      // Slides off stage rest at their end, so the stage keeps the tallest one's height.
      if (!on) set(slide, lastStep(slide));
    });
    const slide = slides[current]!;
    if (word && slide.dataset.word && word.textContent !== slide.dataset.word) {
      word.textContent = slide.dataset.word;
      if (!reduced) word.animate([{ opacity: 0, transform: 'translateY(.18em)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'ease-out' });
    }
    if (chosen) {
      tabs[current]?.focus({ preventScroll: true });
      // Only a person's choice scrolls the tab row: autoplay scrolling it would read as page input to traffic-signals.ts.
      const tab = tabs[current];
      const strip = tab?.parentElement;
      if (tab && strip) strip.scrollTo({ left: tab.offsetLeft - strip.offsetWidth / 2 + tab.offsetWidth / 2, behavior: reduced ? 'auto' : 'smooth' });
    }
    step = reduced ? lastStep(slide) : 0;
    set(slide, step);
    schedule();
  };

  function tick(): void {
    const slide = slides[current]!;
    if (step < lastStep(slide)) {
      step += 1;
      play(slide, step);
      schedule();
    } else {
      select(manual ? current : current + 1);
    }
  }

  /** Holds the stage at the height of its tallest slide's last step, so playing never moves the page. */
  const lock = (): void => {
    stage.style.minHeight = '';
    slides.forEach((slide) => set(slide, lastStep(slide)));
    stage.style.minHeight = `${stage.offsetHeight}px`;
    set(slides[current]!, step);
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      // Choosing an example is a request to see it, so it plays even if paused.
      if (held && pause) pause.click();
      select(index, true);
    });
    tab.addEventListener('keydown', (event) => {
      const by = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (by) { event.preventDefault(); select(index + by, true); }
      if (event.key === 'Home') { event.preventDefault(); select(0, true); }
      if (event.key === 'End') { event.preventDefault(); select(slides.length - 1, true); }
    });
  });
  if (pause && !reduced) {
    pause.hidden = false;
    pause.addEventListener('click', () => {
      held = !held;
      pause.setAttribute('aria-label', held ? 'Play the example' : 'Pause the example');
      pause.setAttribute('aria-pressed', String(held));
      schedule();
    });
  }
  // A sideways swipe on the stage picks the next or previous slide.
  if (slides.length > 1) {
    let startX = 0;
    let startY = 0;
    stage.addEventListener('touchstart', (event) => {
      startX = event.changedTouches[0]?.clientX ?? 0;
      startY = event.changedTouches[0]?.clientY ?? 0;
    }, { passive: true });
    stage.addEventListener('touchend', (event) => {
      const dx = (event.changedTouches[0]?.clientX ?? 0) - startX;
      const dy = (event.changedTouches[0]?.clientY ?? 0) - startY;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) select(current + (dx < 0 ? 1 : -1), true);
    }, { passive: true });
  }

  story.classList.add('is-live');
  lock();
  let width = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    lock();
  });
  // Web fonts swap in after the first measure and change every height.
  void document.fonts?.ready.then(lock);
  whenVisible(story, (next) => { visible = next; schedule(); });
  select(0);
}

document.querySelectorAll<HTMLElement>('[data-story]').forEach(run);
