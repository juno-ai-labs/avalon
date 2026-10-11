// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CARD = '<aside id="pilot-offer" hidden><button class="pilot-offer-close"></button><p>till <time class="pilot-offer-deadline"></time></p><a class="pilot-offer-cta" href="https://app.rallywith.ai/">Sign up</a></aside>';

/** Loads the landing page at `now` and returns the card once its delay has passed. */
async function visit(now: Date): Promise<HTMLElement> {
  vi.setSystemTime(now);
  document.body.innerHTML = CARD;
  vi.resetModules();
  await import('../src/pilot-offer');
  vi.advanceTimersByTime(2_000);
  return document.getElementById('pilot-offer')!;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pilot offer', () => {
  it('gives a visitor a deadline six days after their first visit and keeps it on later visits', async () => {
    const first = await visit(new Date(2026, 9, 11, 9, 30));
    expect(first.hidden).toBe(false);
    expect(first.querySelector('time')?.textContent).toBe('October 17');
    expect(first.querySelector('time')?.dateTime).toBe('2026-10-17');

    const later = await visit(new Date(2026, 9, 14, 18, 0));
    expect(later.querySelector('time')?.textContent).toBe('October 17');
    // The sign-up link names the first visit, not this one.
    expect(later.querySelector('a')?.href).toBe('https://app.rallywith.ai/?pilotOfferFirstSeen=2026-10-11');

    const lastDay = await visit(new Date(2026, 9, 17, 23, 59));
    expect(lastDay.hidden).toBe(false);
  });

  it('stops showing once the visitor\'s deadline has passed', async () => {
    await visit(new Date(2026, 9, 11, 9, 30));
    const after = await visit(new Date(2026, 9, 18, 0, 1));
    expect(after.hidden).toBe(true);
  });

  it('starts the deadline when the card appears, not when the page loads', async () => {
    vi.setSystemTime(new Date(2026, 9, 11, 9, 30));
    document.body.innerHTML = CARD;
    vi.resetModules();
    await import('../src/pilot-offer');
    // The visitor leaves before the card appears.
    vi.advanceTimersByTime(1_000);
    const later = await visit(new Date(2026, 9, 20, 9, 30));
    expect(later.hidden).toBe(false);
    expect(later.querySelector('time')?.textContent).toBe('October 26');
  });

  it('stays away after the visitor middle-clicks Sign up', async () => {
    const card = await visit(new Date(2026, 9, 11, 9, 30));
    card.querySelector('a')!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    const again = await visit(new Date(2026, 9, 12, 9, 30));
    expect(again.hidden).toBe(true);
  });

  it('drops the card when the visitor returns to a tab left open past the deadline', async () => {
    const card = await visit(new Date(2026, 9, 11, 9, 30));
    vi.setSystemTime(new Date(2026, 9, 18, 8, 0));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(card.hidden).toBe(true);
  });

  it('stays away after the visitor closes it', async () => {
    const card = await visit(new Date(2026, 9, 11, 9, 30));
    card.querySelector<HTMLButtonElement>('.pilot-offer-close')!.click();
    const again = await visit(new Date(2026, 9, 12, 9, 30));
    expect(again.hidden).toBe(true);
  });
});

describe('pilot offer close animation', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });

  it('stays on screen until its own exit animation ends, not an entry animation inside it', async () => {
    const card = await visit(new Date(2026, 9, 11, 9, 30));
    card.querySelector<HTMLButtonElement>('.pilot-offer-close')!.click();
    const ended = (name: string): Event => Object.assign(new Event('animationend', { bubbles: true }), { animationName: name });
    // A line of text finishing its entry, then the card's top rule (a pseudo-element, so the card is its target).
    card.querySelector('p')!.dispatchEvent(ended('pilot-offer-rise'));
    card.dispatchEvent(ended('pilot-offer-rule'));
    expect(card.hidden).toBe(false);
    card.dispatchEvent(ended('pilot-offer-out'));
    expect(card.hidden).toBe(true);
  });
});
