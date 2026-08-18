import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PREFERENCES_STORAGE_KEY, readDevicePreferences } from './device-preferences';
import {
  applyTheme,
  installTheme,
  persistThemeChoice,
  readThemeChoice,
  resolvedThemeFor,
  watchSystemAppearance,
} from './theme';

/**
 * A `matchMedia` that jsdom does not provide, with a handle on the listeners so
 * a test can make the Mac change appearance. Assigned rather than stubbed
 * through `vi.stubGlobal`, because `unstubGlobals` reverts before each test and
 * would take the installation with it.
 */
function installMatchMedia(prefersDark: boolean): { change: (dark: boolean) => void } {
  let matches = prefersDark;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes('dark') ? matches : false;
      },
      media: query,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }),
  });
  return {
    change: (dark: boolean) => {
      matches = dark;
      for (const listener of [...listeners]) listener();
    },
  };
}

function removeMatchMedia(): void {
  Reflect.deleteProperty(window, 'matchMedia');
}

describe('theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['themeChoice'];
    removeMatchMedia();
  });

  it('starts on the system appearance when nothing has been chosen', () => {
    expect(readThemeChoice()).toBe('system');
  });

  it('records the resolved theme and the choice that produced it', () => {
    installMatchMedia(true);

    expect(applyTheme('system')).toEqual({ choice: 'system', resolved: 'dark' });
    expect(document.documentElement.dataset['theme']).toBe('dark');
    // Both, because "dark" and "system, currently dark" look identical on the
    // document and the Settings picker has to tell them apart.
    expect(document.documentElement.dataset['themeChoice']).toBe('system');
  });

  it.each([['light'], ['dark'], ['airy']] as const)('stamps %s whatever the Mac prefers', (choice) => {
    installMatchMedia(true);

    expect(applyTheme(choice).resolved).toBe(choice);
    expect(document.documentElement.dataset['theme']).toBe(choice);
  });

  it('keeps the choice on the device, beside the other device preferences', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, selectedRegion: 'eu' }),
    );

    persistThemeChoice('airy');

    expect(readDevicePreferences()).toEqual({ version: 1, selectedRegion: 'eu', theme: 'airy' });
    expect(readThemeChoice()).toBe('airy');
  });

  it('applies the stored choice at install rather than the default', () => {
    persistThemeChoice('light');
    delete document.documentElement.dataset['theme'];

    expect(installTheme()).toEqual({ choice: 'light', resolved: 'light' });
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  /**
   * A stored theme this build no longer has is dropped by the preference
   * parser, which leaves the choice at the default rather than stamping an
   * attribute that selects no block at all — every colour would fall back to
   * the dark theme's `:root` while the picker showed something else.
   */
  it('falls back to the default when the stored theme is not one this build has', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, theme: 'sepia' }),
    );

    expect(readThemeChoice()).toBe('system');
    expect(installTheme().resolved).toBe('light');
  });

  describe('without matchMedia', () => {
    // jsdom has none, and neither does an Electron window early enough to be
    // certain of. Resolving `system` to light matches what Chromium answers
    // when the platform expresses no preference.
    it('resolves system to light and subscribes to nothing', () => {
      expect(resolvedThemeFor('system')).toBe('light');
      expect(() => watchSystemAppearance()()).not.toThrow();
    });
  });

  describe('watching the system appearance', () => {
    it('re-resolves when the Mac changes and the choice is system', () => {
      const media = installMatchMedia(false);
      persistThemeChoice('system');
      const stop = watchSystemAppearance();

      media.change(true);
      expect(document.documentElement.dataset['theme']).toBe('dark');

      media.change(false);
      expect(document.documentElement.dataset['theme']).toBe('light');
      stop();
    });

    // The subscription exists for `system` alone. Following the Mac after
    // someone has asked for Airy is the bug it would look like a fix for.
    it('leaves a deliberate choice alone', () => {
      const media = installMatchMedia(false);
      persistThemeChoice('airy');
      const stop = watchSystemAppearance();

      media.change(true);

      expect(document.documentElement.dataset['theme']).toBe('airy');
      stop();
    });

    it('stops re-resolving once detached', () => {
      const media = installMatchMedia(false);
      persistThemeChoice('system');
      watchSystemAppearance()();

      media.change(true);

      expect(document.documentElement.dataset['theme']).toBe('light');
    });
  });

  it('tells the main process which appearance to construct the next window with', async () => {
    installMatchMedia(false);
    const setWindowTheme = vi.fn(() => Promise.resolve());
    vi.stubGlobal('avalon', { setWindowTheme });

    persistThemeChoice('airy');
    await Promise.resolve();

    expect(setWindowTheme).toHaveBeenCalledWith('airy');
  });
});
