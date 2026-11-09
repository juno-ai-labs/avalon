/**
 * Plays the hero's live Canvas carousel (`[data-live-carousel]`, rendered by
 * `live-examples.ts`). Each slide is a Canvas a Sidekick keeps current: its
 * elements carry the step they appear on (`data-at`), leave on
 * (`data-until`) or light up on (`data-mark`), and this steps through them,
 * holding longest on the last step, the payoff, before the next slide.
 *
 * The markup is the finished state of every slide, so without script, and with
 * reduced motion, each slide shows its last version. The tabs always work; only
 * the stepping and the rotation need motion. Rotation pauses while the pointer
 * or focus is inside, while the carousel is off screen, and when the visitor
 * presses Pause.
 */
const SIGNAL_MS = 1000;
const VERSION_MS = 1600;
const HOLD_MS = 4600;
const FRESH_MS = 1600;

function play(root: HTMLElement): void {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('.lc-tab'));
  const slides = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls') ?? ''));
  const summaries = Array.from(root.querySelectorAll<HTMLElement>('.lc-summary'));
  const pause = root.querySelector<HTMLButtonElement>('.lc-pause');
  const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let current = 0;
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovered = false;
  let visible = false;
  let stopped = false;

  const steps = (): number => Number(slides[current]?.dataset['steps'] ?? 0);
  const running = (): boolean => moving && visible && !hovered && !stopped;

  const apply = (slide: HTMLElement | null, at: number): void => {
    slide?.querySelectorAll<HTMLElement>('[data-mark]').forEach((element) => {
      element.classList.toggle('marked', at >= Number(element.dataset['mark']));
    });
    slide?.querySelectorAll<HTMLElement>('[data-at], [data-until]').forEach((element) => {
      const shown = at >= Number(element.dataset['at'] ?? 0) && at < Number(element.dataset['until'] ?? Infinity);
      if (shown && !element.classList.contains('on')) {
        element.classList.add('on', 'fresh');
        setTimeout(() => element.classList.remove('fresh'), FRESH_MS);
      } else if (!shown) element.classList.remove('on', 'fresh');
    });
    tabs[current]?.style.setProperty('--p', String(steps() ? at / steps() : 1));
  };

  const schedule = (): void => {
    clearTimeout(timer);
    if (!running()) return;
    const last = steps();
    const wait = step >= last ? HOLD_MS : step % 2 === 0 ? SIGNAL_MS : VERSION_MS;
    timer = setTimeout(() => {
      if (step >= last) select((current + 1) % tabs.length, false);
      else { step += 1; apply(slides[current] ?? null, step); }
      schedule();
    }, wait);
  };

  function select(index: number, focus: boolean): void {
    tabs.forEach((tab, n) => {
      const on = n === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      tab.style.setProperty('--p', '0');
      if (slides[n]) slides[n].hidden = !on;
      if (summaries[n]) summaries[n].hidden = !on;
    });
    current = index;
    if (focus) tabs[index]?.focus();
    // Without motion the slide stays finished; with it, the slide starts empty.
    step = moving ? 0 : steps();
    if (moving) apply(slides[current] ?? null, step);
    else tabs[current]?.style.setProperty('--p', '1');
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { select(index, false); schedule(); });
    tab.addEventListener('keydown', (event) => {
      const move = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: tabs.length - 1 - index }[event.key];
      if (move === undefined) return;
      event.preventDefault();
      select((index + move + tabs.length) % tabs.length, true);
      schedule();
    });
  });

  if (!moving) { select(0, false); return; }
  root.classList.add('animating');
  if (pause) {
    pause.hidden = false;
    pause.addEventListener('click', () => {
      stopped = !stopped;
      pause.textContent = stopped ? 'Play' : 'Pause';
      schedule();
    });
  }
  root.addEventListener('pointerenter', () => { hovered = true; schedule(); });
  root.addEventListener('pointerleave', () => { hovered = false; schedule(); });
  root.addEventListener('focusin', () => { hovered = true; schedule(); });
  root.addEventListener('focusout', (event) => {
    if (root.contains(event.relatedTarget as Node | null)) return;
    hovered = false;
    schedule();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    schedule();
  }, { threshold: 0.3 }).observe(root);
  select(0, false);
}

document.querySelectorAll<HTMLElement>('[data-live-carousel]').forEach(play);

export {};
