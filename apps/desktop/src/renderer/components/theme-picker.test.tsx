import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ThemePicker } from './theme-picker';
import { readThemeChoice, watchSystemAppearance } from '../lib/theme';

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
    delete document.documentElement.dataset['themeMode'];
    installMatchMedia(false);
  });

  it('offers only System, Light, and Dark', () => {
    render(<ThemePicker />);

    const modes = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect([...modes.querySelectorAll('[role=radio]')].map((option) => option.textContent))
      .toEqual(['System', 'Light', 'Dark']);
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).not.toBeInTheDocument();
  });

  it('starts on the one Rally design following the Mac', () => {
    render(<ThemePicker />);

    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByText('Following this Mac, which is light right now.')).toBeInTheDocument();
    expect(readThemeChoice()).toBe('system');
  });

  it('pins dark without exposing a design choice', () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(readThemeChoice()).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(screen.getByText('Always dark.')).toBeInTheDocument();
  });

  it('re-announces a system appearance change', () => {
    const setDark = installMatchMedia(false);
    render(<ThemePicker />);
    const stop = watchSystemAppearance();

    act(() => setDark(true));

    expect(screen.getByText('Following this Mac, which is dark right now.')).toBeInTheDocument();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    stop();
  });

  it('leaves a pinned appearance alone when the Mac changes', () => {
    const setDark = installMatchMedia(false);
    render(<ThemePicker />);
    const stop = watchSystemAppearance();
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));

    act(() => setDark(true));

    expect(screen.getByText('Always light.')).toBeInTheDocument();
    expect(document.documentElement.dataset['theme']).toBe('light');
    stop();
  });
});
