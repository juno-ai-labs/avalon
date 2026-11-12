// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CARD = '<aside id="pilot-offer" hidden><button class="pilot-offer-close"></button><p>First two months on us.</p><a class="pilot-offer-cta" href="https://app.rallywith.ai/">Sign up</a></aside>';

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
  it('shows the offer without a visitor-specific deadline or signup eligibility parameter', async () => {
    const first = await visit(new Date(2026, 9, 11, 9, 30));
    expect(first.hidden).toBe(false);
    const later = await visit(new Date(2026, 10, 20, 18, 0));
    expect(later.hidden).toBe(false);
    expect(later.querySelector('a')?.href).toBe('https://app.rallywith.ai/');
  });

  it('stays away after the visitor middle-clicks Sign up', async () => {
    const card = await visit(new Date(2026, 9, 11, 9, 30));
    card.querySelector('a')!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    const again = await visit(new Date(2026, 9, 12, 9, 30));
    expect(again.hidden).toBe(true);
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
