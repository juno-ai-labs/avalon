// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const headline = '<h1>Get a <span class="swap" data-swap="hero:kind"><span class="swap-now">dashboard</span></span> of your '
  + '<span class="swap" data-swap="hero:word"><span class="swap-now">leads</span></span></h1><div id="hero"></div>';

const slideUp = (data: Record<string, string>): void => {
  const slide = document.createElement('article');
  Object.assign(slide.dataset, data);
  document.getElementById('hero')!.dispatchEvent(new CustomEvent('story:slide', { detail: { slide } }));
};

let finish: Array<() => void> = [];

async function start(reduced: boolean): Promise<void> {
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  document.body.innerHTML = headline;
  await import('../src/word-swap');
}

beforeEach(() => {
  vi.resetModules();
  finish = [];
  // jsdom has no Web Animations; each animation here ends when the test says so.
  Element.prototype.animate = (() => ({ finished: new Promise<void>((resolve) => { finish.push(resolve); }) })) as unknown as Element['animate'];
});

describe('headline words that follow a story', () => {
  it('shows the slide’s words, keeping the old one on screen only until it has faded', async () => {
    await start(false);
    slideUp({ kind: 'board', word: 'orders' });
    expect(document.querySelector('h1')!.querySelectorAll('.swap-now')[0]!.textContent).toBe('board');
    expect(document.querySelector('h1')!.querySelectorAll('.swap-now')[1]!.textContent).toBe('orders');
    // The words that left are still drawn, hidden from a screen reader, so the headline never reads twice.
    const leaving = Array.from(document.querySelectorAll('.swap-old'));
    expect(leaving.map((word) => `${word.textContent} ${word.getAttribute('aria-hidden')}`)).toEqual(['dashboard true', 'leads true']);
    finish.forEach((done) => done());
    await Promise.resolve();
    expect(document.querySelectorAll('.swap-old')).toHaveLength(0);
    expect(document.querySelector('h1')!.textContent).toBe('Get a board of your orders');
  });

  it('leaves a word alone when the next slide has the same one', async () => {
    await start(false);
    slideUp({ kind: 'dashboard', word: 'clients' });
    expect(Array.from(document.querySelectorAll('.swap-old'), (word) => word.textContent)).toEqual(['leads']);
  });

  it('changes the words at once with reduced motion', async () => {
    await start(true);
    slideUp({ kind: 'timeline', word: 'events' });
    expect(document.querySelectorAll('.swap-old')).toHaveLength(0);
    expect(document.querySelector('h1')!.textContent).toBe('Get a timeline of your events');
  });
});
