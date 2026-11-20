// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;
/** Each observer the player made, with the margin it asked for: the plain one is "on screen", the other "scrolled to". */
let observers: Array<{ callback: Callback; margin: string }> = [];
const onScreen = (visible: boolean): void => observers.filter(({ margin }) => margin === '0px').forEach(({ callback }) => callback([{ isIntersecting: visible }]));
const scrolledTo = (): void => observers.filter(({ margin }) => margin !== '0px').forEach(({ callback }) => callback([{ isIntersecting: true }]));

/** A story of two slides, two emails each, drawn at its last step as a page writes it. */
const story = (attributes = ''): string => `
<div class="story" data-story ${attributes}>
  <div class="story-bar">
    <div class="story-tabs" role="tablist">
      <button type="button" role="tab" id="tab-a" aria-selected="true">A<i class="story-progress"></i></button>
      <button type="button" role="tab" id="tab-b" aria-selected="false" tabindex="-1">B<i class="story-progress"></i></button>
    </div>
    <button type="button" data-story-pause hidden aria-label="Pause the example" aria-pressed="false"></button>
  </div>
  <div class="story-stage">
    <article data-slide data-steps="2" data-word="leads" id="a">
      <div class="story-mail">
        <div id="a-ask" data-until="1">Ask</div>
        <div id="a-mail-1" data-at="1" data-until="2">First</div>
        <div id="a-mail-2" data-at="2">Second</div>
      </div>
      <div class="story-page">
        <span class="kit-live" id="a-live">Updates itself</span>
        <div id="a-new" data-at="1" data-touch="1">New row</div>
        <div id="a-old" data-key="card" data-until="2">Quoted</div>
        <div id="a-moved" data-key="card" data-at="2" data-touch="2">Confirmed</div>
        <i id="a-tick" data-done="2"></i>
      </div>
    </article>
    <article data-slide data-steps="2" data-word="orders" id="b">
      <div class="story-mail"><div id="b-ask" data-until="1">Ask</div><div id="b-mail-1" data-at="1">First</div></div>
      <div class="story-page"><div id="b-new" data-at="1">New row</div></div>
    </article>
  </div>
</div>`;

const has = (id: string, name: string): boolean => document.getElementById(id)!.classList.contains(name);
const selected = (id: string): string | null => document.getElementById(id)!.getAttribute('aria-selected');

/** Loads the player onto `markup`, on screen, with motion allowed unless `reduced`. */
async function start(markup: string, reduced = false): Promise<void> {
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  document.body.innerHTML = markup;
  await import('../src/story');
  onScreen(true);
  scrolledTo();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  observers = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: Callback, options?: { rootMargin?: string }) { observers.push({ callback, margin: options?.rootMargin ?? '0px' }); }
    observe(): void {}
  });
  // jsdom has no Web Animations and cannot scroll an element.
  Element.prototype.animate = (() => ({ finished: Promise.resolve() })) as unknown as Element['animate'];
  Element.prototype.scrollTo = (() => {}) as Element['scrollTo'];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('story player', () => {
  it('opens on the ask with the page as first built', async () => {
    await start(story());
    expect(document.querySelector('.story')!.classList.contains('is-live')).toBe(true);
    expect(has('a', 'is-active')).toBe(true);
    expect(has('a-ask', 'is-gone')).toBe(false);
    expect(has('a-mail-1', 'is-on')).toBe(false);
    expect(has('a-new', 'is-on')).toBe(false);
    expect(has('a-old', 'is-gone')).toBe(false);
    expect(has('a-tick', 'is-done')).toBe(false);
  });

  it('brings each email in, sends it on its way, and changes the page as it goes', async () => {
    await start(story());
    vi.advanceTimersByTime(2600);
    expect(has('a-ask', 'is-gone')).toBe(true);
    expect(has('a-mail-1', 'is-on')).toBe(true);
    expect(has('a-mail-1', 'is-new')).toBe(true);
    // The email is up to be read; nothing else has happened yet.
    expect(has('a-mail-1', 'is-leaving')).toBe(false);
    expect(has('a-new', 'is-on')).toBe(false);
    vi.advanceTimersByTime(1900);
    // It moves on, and the page still has not changed: cause comes before effect.
    expect(has('a-mail-1', 'is-leaving')).toBe(true);
    expect(has('a-mail-1', 'is-new')).toBe(false);
    expect(has('a-new', 'is-on')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(has('a-new', 'is-on')).toBe(true);
    expect(has('a-new', 'is-touched')).toBe(true);
    expect(has('a-live', 'is-updated')).toBe(true);
    expect(has('a-moved', 'is-on')).toBe(false);
  });

  it('swaps what a step replaces, marks the moved one and ticks what is done', async () => {
    await start(story());
    vi.advanceTimersByTime(2600 + 4200 + 2400);
    expect(has('a-mail-1', 'is-gone')).toBe(true);
    expect(has('a-mail-2', 'is-on')).toBe(true);
    expect(has('a-old', 'is-gone')).toBe(true);
    expect(has('a-moved', 'is-on')).toBe(true);
    expect(has('a-moved', 'is-moved')).toBe(true);
    expect(has('a-tick', 'is-done')).toBe(true);
    // The highlight belongs to the step that just played.
    expect(has('a-new', 'is-touched')).toBe(false);
    expect(has('a-moved', 'is-touched')).toBe(true);
  });

  it('goes on to the next slide after the last step and says which slide is up', async () => {
    const up: string[] = [];
    document.addEventListener('story:slide', (event) => up.push((event as CustomEvent<{ slide: HTMLElement }>).detail.slide.id));
    await start(story());
    expect(up).toEqual(['a']);
    vi.advanceTimersByTime(2600 + 4200 + 4200 + 1600);
    expect(up).toEqual(['a', 'b']);
    expect(has('b', 'is-active')).toBe(true);
    expect(has('a', 'is-active')).toBe(false);
    expect(selected('tab-b')).toBe('true');
    expect(selected('tab-a')).toBe('false');
    // The slide that left rests at its end; the one that arrived starts at its ask.
    expect(has('a-moved', 'is-on')).toBe(true);
    expect(has('b-mail-1', 'is-on')).toBe(false);
  });

  it('starts only once a person has scrolled to it, then plays while any of it is on screen', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    document.body.innerHTML = story();
    await import('../src/story');
    // Its first pixels are on screen, but nobody has scrolled to it: it waits at its opening.
    onScreen(true);
    vi.advanceTimersByTime(30_000);
    expect(has('a-ask', 'is-gone')).toBe(false);
    expect(has('a-mail-1', 'is-on')).toBe(false);
    scrolledTo();
    vi.advanceTimersByTime(2600);
    expect(has('a-mail-1', 'is-on')).toBe(true);
    // Scrolled right off the screen mid-story, it waits where it was, and carries on when it is back.
    onScreen(false);
    vi.advanceTimersByTime(30_000);
    expect(has('a-mail-2', 'is-on')).toBe(false);
    onScreen(true);
    vi.advanceTimersByTime(4200);
    expect(has('a-mail-2', 'is-on')).toBe(true);
  });

  it('plays a tab a person picks even before the story has been scrolled to', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    document.body.innerHTML = story();
    await import('../src/story');
    onScreen(true);
    document.getElementById('tab-b')!.click();
    vi.advanceTimersByTime(2600);
    expect(has('b-mail-1', 'is-on')).toBe(true);
  });

  it('replays the chosen slide when the story is manual', async () => {
    await start(story('data-story-manual'));
    vi.advanceTimersByTime(2600 + 4200 + 4200 + 1600);
    expect(has('a', 'is-active')).toBe(true);
    expect(has('a-mail-1', 'is-on')).toBe(false);
    expect(has('a-ask', 'is-gone')).toBe(false);
  });

  it('stops for the pause button, and plays the tab a person picks from its start', async () => {
    await start(story());
    const pause = document.querySelector<HTMLButtonElement>('[data-story-pause]')!;
    expect(pause.hidden).toBe(false);
    pause.click();
    expect(pause.getAttribute('aria-pressed')).toBe('true');
    vi.advanceTimersByTime(20_000);
    expect(has('a-mail-1', 'is-on')).toBe(false);
    document.getElementById('tab-b')!.click();
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    expect(has('b', 'is-active')).toBe(true);
    vi.advanceTimersByTime(2600);
    expect(has('b-mail-1', 'is-on')).toBe(true);
  });

  it('holds the whole step while paused, the email leaving and the page changing included, then carries on from where it was', async () => {
    await start(story());
    const pause = document.querySelector<HTMLButtonElement>('[data-story-pause]')!;
    // One second after the first email arrived: it has not left, and the page has not changed.
    vi.advanceTimersByTime(2600 + 1000);
    pause.click();
    vi.advanceTimersByTime(20_000);
    expect(has('a-mail-1', 'is-leaving')).toBe(false);
    expect(has('a-new', 'is-on')).toBe(false);
    expect(has('a-mail-2', 'is-on')).toBe(false);
    // Resumed, the email leaves 900ms on (1.9s into its step), not at once and not after a full step.
    pause.click();
    vi.advanceTimersByTime(899);
    expect(has('a-mail-1', 'is-leaving')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(has('a-mail-1', 'is-leaving')).toBe(true);
    expect(has('a-new', 'is-on')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(has('a-new', 'is-on')).toBe(true);
    // The next email comes when the rest of the 4.2s step has run.
    vi.advanceTimersByTime(1799);
    expect(has('a-mail-2', 'is-on')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(has('a-mail-2', 'is-on')).toBe(true);
  });

  it('holds the whole step while scrolled off the screen', async () => {
    await start(story());
    vi.advanceTimersByTime(2600 + 2000);
    // The email has started to leave; the page is due to change in 400ms.
    expect(has('a-mail-1', 'is-leaving')).toBe(true);
    onScreen(false);
    vi.advanceTimersByTime(20_000);
    expect(has('a-new', 'is-on')).toBe(false);
    onScreen(true);
    vi.advanceTimersByTime(400);
    expect(has('a-new', 'is-on')).toBe(true);
  });

  it('shows every slide at its last step and plays nothing with reduced motion', async () => {
    await start(story(), true);
    expect(has('a-mail-2', 'is-on')).toBe(true);
    expect(has('a-moved', 'is-on')).toBe(true);
    expect(has('a-old', 'is-gone')).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-story-pause]')!.hidden).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(has('a', 'is-active')).toBe(true);
    document.getElementById('tab-b')!.click();
    expect(has('b', 'is-active')).toBe(true);
    expect(has('b-mail-1', 'is-on')).toBe(true);
  });
});
