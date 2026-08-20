import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ThemePicker } from './theme-picker';
import { readThemeChoice } from '../lib/theme';

function installMatchMedia(prefersDark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('dark') ? prefersDark : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
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
      .toEqual(['Neu', 'Air']);
  });

  it('starts on the original design following the Mac, and says what that resolves to', () => {
    render(<ThemePicker />);

    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Neu' })).toBeChecked();
    expect(screen.getByText('Neu, following this Mac, which is light right now.')).toBeInTheDocument();
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

    expect(shown()).toEqual(['neu-light', 'air']);

    // Both swatches redraw, not only the selected one — which is what makes the
    // mode row legible: it shows what each design looks like under it.
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(shown()).toEqual(['neu', 'air-dark']);
  });

  it('previews the system mode as the appearance the Mac is currently set to', () => {
    installMatchMedia(true);
    const { container } = render(<ThemePicker />);

    expect(container.querySelector('.settings-theme-swatch')?.getAttribute('data-theme')).toBe('neu');
    expect(screen.getByText('Neu, following this Mac, which is dark right now.')).toBeInTheDocument();
  });

  it('goes back to following the Mac when System is chosen again', () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));

    expect(readThemeChoice()).toEqual({ family: 'neu', mode: 'system' });
    expect(document.documentElement.dataset['theme']).toBe('neu-light');
    expect(document.documentElement.dataset['themeMode']).toBe('system');
  });
});
