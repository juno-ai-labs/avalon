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
    delete document.documentElement.dataset['themeChoice'];
    installMatchMedia(false);
  });

  it('offers every theme as one radio group', () => {
    render(<ThemePicker />);

    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((option) => option.textContent))
      .toEqual(['System', 'Light', 'Dark', 'Airy']);
  });

  it('starts on System, and says which appearance that is resolving to', () => {
    render(<ThemePicker />);

    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByText('Following this Mac, which is light right now.')).toBeInTheDocument();
  });

  it('applies and stores a chosen theme', () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole('radio', { name: 'Airy' }));

    expect(document.documentElement.dataset['theme']).toBe('airy');
    expect(readThemeChoice()).toBe('airy');
    expect(screen.getByRole('radio', { name: 'Airy' })).toBeChecked();
    expect(screen.getByText('Airy is selected.')).toBeInTheDocument();
  });

  /**
   * The swatch is drawn from the theme it offers, under its own `data-theme`,
   * so the preview cannot be a second copy of the palette that goes stale the
   * first time a theme is retuned. Nothing else asserts that, because both
   * shapes render the same DOM aside from this attribute.
   */
  it('previews each theme with that theme’s own tokens', () => {
    const { container } = render(<ThemePicker />);
    const swatches = [...container.querySelectorAll('.settings-theme-swatch')];

    expect(swatches.map((swatch) => swatch.getAttribute('data-theme')))
      .toEqual(['light', 'light', 'dark', 'airy']);
  });

  // The System swatch has no palette of its own, so it previews what choosing
  // it would actually produce — which changes with the Mac.
  it('previews System as the appearance the Mac is currently set to', () => {
    installMatchMedia(true);
    const { container } = render(<ThemePicker />);

    expect(container.querySelector('.settings-theme-swatch')?.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByText('Following this Mac, which is dark right now.')).toBeInTheDocument();
  });

  it('goes back to following the Mac when System is chosen again', () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));

    expect(readThemeChoice()).toBe('system');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.dataset['themeChoice']).toBe('system');
  });
});
