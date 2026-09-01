import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ThemePicker } from './theme-picker';
import { readThemeChoice, watchSystemAppearance } from '../lib/theme';

/**
 * A `matchMedia` whose `change` listeners can actually be fired, so a test can
 * put the Mac into dark and see what the picker does about it. Returns the
 * switch; calling it flips `matches` and notifies, the way the platform does.
 */
function installMatchMedia(prefersDark: boolean): (dark: boolean) => void {
  let dark = prefersDark;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() { return query.includes('dark') ? dark : false; },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }),
  });
  return (next: boolean) => {
    dark = next;
    for (const listener of [...listeners]) listener();
  };
}

describe('ThemePicker', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['themeFamily'];
    delete document.documentElement.dataset['themeMode'];
    installMatchMedia(false);
  });

  /**
   * Two groups, not one. The mode is not a peer of the designs — it says which
   * way round to run whichever design is chosen — and as one flat list there was
   * no way to ask for Air *and* to follow the room.
   */
  it('offers the lighting and the designs as separate radio groups', () => {
    render(<ThemePicker />);

    const modes = screen.getByRole('radiogroup', { name: 'Appearance' });
    const families = screen.getByRole('radiogroup', { name: 'Theme' });

    expect([...modes.querySelectorAll('[role=radio]')].map((option) => option.textContent))
      .toEqual(['System', 'Light', 'Dark']);
    expect([...families.querySelectorAll('[role=radio]')].map((option) => option.textContent))
      .toEqual(['Grok', 'Terra', 'Air']);
  });

  it('starts on the shipped design following the Mac, and says what that resolves to', () => {
    render(<ThemePicker />);

    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Grok' })).toBeChecked();
    expect(screen.getByText('Grok, following this Mac, which is light right now.')).toBeInTheDocument();
  });

  it('applies and stores a chosen design, keeping the mode', () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole('radio', { name: 'Air' }));

    expect(document.documentElement.dataset['theme']).toBe('air');
    expect(readThemeChoice()).toEqual({ family: 'air', mode: 'system' });
    expect(screen.getByRole('radio', { name: 'Air' })).toBeChecked();
    expect(screen.getByText('Air, following this Mac, which is light right now.')).toBeInTheDocument();
  });

  /** The whole point of the split: pin the lighting without leaving the design. */
  it('changes the lighting without changing the design', () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole('radio', { name: 'Air' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(readThemeChoice()).toEqual({ family: 'air', mode: 'dark' });
    expect(document.documentElement.dataset['theme']).toBe('air-dark');
    expect(screen.getByRole('radio', { name: 'Air' })).toBeChecked();
    expect(screen.getByText('Air, always dark.')).toBeInTheDocument();
  });

  it('changes the design without changing the lighting', () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Air' }));

    expect(readThemeChoice()).toEqual({ family: 'air', mode: 'dark' });
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  });

  /**
   * Each swatch is drawn from the appearance it offers, under its own
   * `data-theme`, so the preview cannot be a second copy of the palette that
   * goes stale the first time a theme is retuned. Nothing else asserts that,
   * because both swatches render the same DOM aside from this attribute.
   */
  it('previews each design with that design’s own tokens, under the mode in force', () => {
    const { container } = render(<ThemePicker />);
    const shown = (): (string | null)[] => [...container.querySelectorAll('.settings-theme-swatch')]
      .map((swatch) => swatch.getAttribute('data-theme'));

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(shown()).toEqual(['grok', 'terra-light', 'air']);

    // Both swatches redraw, not only the selected one — which is what makes the
    // mode row legible: it shows what each design looks like under it.
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(shown()).toEqual(['grok-dark', 'terra', 'air-dark']);
  });

  /**
   * Under `system` a family has two appearances and which one you get depends
   * on the Mac. Showing one of them would be quietly wrong for half the day, so
   * the swatch is split and shows both.
   */
  it('splits every swatch into both appearances under the system mode', () => {
    const { container } = render(<ThemePicker />);
    const halves = (): (string | null)[] => [
      ...container.querySelectorAll('.settings-theme-swatch, .settings-theme-swatch-alternate'),
    ].map((half) => half.getAttribute('data-theme'));

    expect(halves()).toEqual(['grok', 'grok-dark', 'terra-light', 'terra', 'air', 'air-dark']);

    // Pinning the lighting removes the ambiguity, and with it the split.
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(container.querySelectorAll('.settings-theme-swatch-alternate')).toHaveLength(0);
    expect(halves()).toEqual(['grok-dark', 'terra', 'air-dark']);
  });

  /**
   * The preview reads `--av-cmp-turn-align` rather than hardcoding a side, so it
   * cannot say left while the feed says right. Terra puts a person's own turn on
   * the right; Air runs it left with everything else.
   */
  it('draws a person’s turn on the side the design puts it', () => {
    const { container } = render(<ThemePicker />);
    const turns = [...container.querySelectorAll('.settings-theme-swatch-turn')];

    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) expect(turn.className).toContain('settings-theme-swatch-turn');
    // The side itself is a token, so what is asserted here is that the element
    // exists inside every miniature and takes its alignment from one; jsdom
    // computes no custom properties, and the rendered result is checked in a
    // real window per `docs/dev-environment.md`.
    expect(container.querySelectorAll('.settings-theme-swatch-marker').length).toBe(turns.length);
  });

  it('previews the system mode as the appearance the Mac is currently set to', () => {
    installMatchMedia(true);
    const { container } = render(<ThemePicker />);

    // The lighter half is always drawn first, so the pair reads the same way
    // round whichever way the Mac is set; the status line is what says which of
    // the two is in force.
    expect(container.querySelector('.settings-theme-swatch')?.getAttribute('data-theme')).toBe('grok');
    expect(container.querySelector('.settings-theme-swatch-alternate')?.getAttribute('data-theme')).toBe('grok-dark');
    expect(screen.getByText('Grok, following this Mac, which is dark right now.')).toBeInTheDocument();
  });

  /**
   * Under `system` the status line is the only thing that says which appearance
   * is actually in force, so it has to survive the Mac changing underneath it —
   * the sunset case, where nobody touches the picker at all. `applyTheme`
   * notifies every `useTheme` subscriber, which is what re-renders the live
   * region; a review read this as not wired up, so it is now pinned.
   */
  it('re-announces the appearance when the Mac changes underneath System mode', () => {
    const setDark = installMatchMedia(false);
    render(<ThemePicker />);
    const stop = watchSystemAppearance();

    expect(screen.getByText('Grok, following this Mac, which is light right now.')).toBeInTheDocument();

    act(() => setDark(true));

    expect(screen.getByText('Grok, following this Mac, which is dark right now.')).toBeInTheDocument();
    expect(document.documentElement.dataset['theme']).toBe('grok-dark');
    stop();
  });

  /** The counterpart: a pinned mode ignores the Mac, so nothing re-announces. */
  it('leaves a pinned mode alone when the Mac changes', () => {
    const setDark = installMatchMedia(false);
    render(<ThemePicker />);
    const stop = watchSystemAppearance();

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    act(() => setDark(true));

    expect(screen.getByText('Grok, always light.')).toBeInTheDocument();
    expect(document.documentElement.dataset['theme']).toBe('grok');
    stop();
  });

  it('goes back to following the Mac when System is chosen again', () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));

    expect(readThemeChoice()).toEqual({ family: 'grok', mode: 'system' });
    expect(document.documentElement.dataset['theme']).toBe('grok');
    expect(document.documentElement.dataset['themeMode']).toBe('system');
  });
});
