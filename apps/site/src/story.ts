/**
 * Plays every story on a page: an example page that changes as emails arrive.
 * The markup is hand-written per page and drawn at its last step, so it reads
 * with no script. This module rewinds it and plays it forward. The contract a
 * page's markup follows is in docs/site-audience-pages.md.
 *
 * A story is one or more slides. A slide has a `.story-mail`, where the ask
 * and then each email show, and one or more `.story-page`, the page those
 * emails change. Every step tells the same small story, in this order: an
 * email arrives as a little Gmail card, it travels on and fades away, and as
 * it goes the page changes. The eye reads cause, then effect.
 *
 * This module only keeps time: it sets each step's classes and announces
 * `story:slide` and `story:step`; how an email arrives and leaves, and how a
 * change looks, is each page's own stylesheet. A story plays only once a
 * person has scrolled to it, a chosen tab plays its slide from the start, and
 * the pause button stops it. With reduced motion nothing moves and every
 * slide shows its end.
 */
import { applyStep, reducedMotion as reduced, whenVisible } from './steps';

/** Seconds the opening holds (the ask), each email's step lasts, and the last one holds on top. */
const OPENING_HOLD = 2.6;
const STEP_HOLD = 4.2;
const CLOSING_HOLD = 1.6;
/** Milliseconds into a step at which its email starts to leave, and at which the page changes as it goes. */
const MAIL_LEAVES = 1900;
const PAGE_DELAY = 2400;
/**
 * A story starts once a person has scrolled to it: its top has to come this
 * far up the screen, not merely show its first pixel. Once started it plays
 * while any of it is on screen.
 */
const SCROLLED_TO = '0px 0px -30% 0px';

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

function run(story: HTMLElement): void {
  const tabs = Array.from(story.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const slides = Array.from(story.querySelectorAll<HTMLElement>('[data-slide]'));
  const stage = story.querySelector<HTMLElement>('.story-stage');
  const pause = story.querySelector<HTMLButtonElement>('[data-story-pause]');
  // A manual story stays on the slide a person chose and replays it.
  const manual = story.hasAttribute('data-story-manual');
  if (!slides.length || !stage) return;
  let current = 0;
  let step = 0;
  let timer = 0;
  let visible = false;
  let started = false;
  let held = false;
  // The step's clock. A pause stops all of a step, not only the move to the
  // next one: what is still to happen in it (the email leaving, the page
  // changing) waits too, and carries on from where it was.
  let running = false;
  let ranFrom = 0;
  let spent = 0;
  let pending: Array<{ at: number; run: () => void; timer: number; done: boolean }> = [];

  /** Puts a slide at a step with nothing animated. */
  const set = (slide: HTMLElement, at: number): void => {
    slide.dataset.step = String(at);
    for (const root of parts(slide, '.story-mail, .story-page')) applyStep(root, at, lastStep(slide), false);
    for (const part of parts(slide, '.is-touched, .is-moved, .is-updated, .is-leaving')) part.classList.remove('is-touched', 'is-moved', 'is-updated', 'is-leaving');
  };

  /** Plays a slide forward to a step: the email arrives, then leaves, and the page changes as it goes. */
  const play = (slide: HTMLElement, at: number): void => {
    slide.dataset.step = String(at);
    for (const part of parts(slide, '.story-mail .is-leaving')) part.classList.remove('is-leaving');
    for (const root of parts(slide, '.story-mail')) applyStep(root, at, lastStep(slide));
    const mailLeaves = (): void => {
      // Whatever arrived this step, one card or a burst of them, moves on. `is-new` goes so a page's arrival rule cannot outrank its leaving one.
      for (const mail of parts(slide, `.story-mail [data-at="${at}"]`)) {
        mail.classList.remove('is-new');
        mail.classList.add('is-leaving');
      }
    };
    const pageChanges = (): void => {
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
      // A page's own script can add its own motion to the step.
      slide.dispatchEvent(new CustomEvent('story:step', { bubbles: true, detail: { step: at } }));
    };
    pending = [{ at: MAIL_LEAVES, run: mailLeaves, timer: 0, done: false }, { at: PAGE_DELAY, run: pageChanges, timer: 0, done: false }];
  };

  /** Drops what was still to happen in the step, for a slide that is being reset or left. */
  const clearStep = (): void => {
    for (const event of pending) window.clearTimeout(event.timer);
    pending = [];
    spent = 0;
    ranFrom = Date.now();
  };

  /** The active tab's bar fills one step at a time, over that step's hold. */
  const setBar = (index: number, fraction: number, seconds: number): void => {
    const bar = tabs[index]?.querySelector<HTMLElement>('.story-progress');
    if (!bar) return;
    bar.style.transitionDuration = `${seconds}s`;
    bar.style.transform = `scaleX(${fraction})`;
  };

  /** Starts, stops or carries on the step's clock, to match whether the story should be playing now. */
  const schedule = (): void => {
    window.clearTimeout(timer);
    for (const event of pending) window.clearTimeout(event.timer);
    // Time the step has already had, so a resume carries on and does not start the step over.
    if (running) spent += Date.now() - ranFrom;
    running = !reduced && started && visible && !held;
    ranFrom = Date.now();
    story.classList.toggle('is-paused', !running);
    const last = lastStep(slides[current]!);
    const hold = (step === 0 ? OPENING_HOLD : step === last ? STEP_HOLD + CLOSING_HOLD : STEP_HOLD) * 1000;
    const left = Math.max(0, hold - spent);
    setBar(current, running ? (step + 1) / (last + 1) : (step + Math.min(1, spent / hold)) / (last + 1), running ? left / 1000 : 0.2);
    if (!running) return;
    timer = window.setTimeout(tick, left);
    for (const event of pending) {
      if (event.done) continue;
      event.timer = window.setTimeout(() => { event.done = true; event.run(); }, Math.max(0, event.at - spent));
    }
  };

  const select = (index: number, chosen = false): void => {
    clearStep();
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
    // Anything on the page that follows the story, such as a headline's word (word-swap.ts), hears which slide is up.
    story.dispatchEvent(new CustomEvent('story:slide', { bubbles: true, detail: { slide, index: current } }));
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
      clearStep();
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
      // Choosing an example is a request to see it, so it plays even if paused or not yet scrolled to.
      started = true;
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
  whenVisible(story, (next) => { if (next && !started) { started = true; schedule(); } }, 0, SCROLLED_TO);
  select(0);
}

document.querySelectorAll<HTMLElement>('[data-story]').forEach(run);
