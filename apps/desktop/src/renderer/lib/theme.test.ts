import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PREFERENCES_STORAGE_KEY, readDevicePreferences } from './device-preferences';
import {
  applyTheme,
  installTheme,
  persistThemeChoice,
  readThemeChoice,
  resolvedThemeFor,
  watchSystemAppearance,
  withFamily,
  withMode,
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
    delete document.documentElement.dataset['themeFamily'];
    delete document.documentElement.dataset['themeMode'];
    removeMatchMedia();
  });

  it('starts on the original design following the Mac when nothing has been chosen', () => {
    expect(readThemeChoice()).toEqual({ family: 'terra', mode: 'system' });
  });

  it('records the resolved appearance and the choice that produced it', () => {
    installMatchMedia(true);
    const choice = { family: 'terra', mode: 'system' } as const;

    expect(applyTheme(choice)).toEqual({ choice, resolved: 'terra' });
    expect(document.documentElement.dataset['theme']).toBe('terra');
    // Both axes, because "Terra, dark" and "Terra, system, currently dark" look
    // identical on the document and the Settings picker has to tell them apart.
    expect(document.documentElement.dataset['themeFamily']).toBe('terra');
    expect(document.documentElement.dataset['themeMode']).toBe('system');
  });

  it.each([
    ['terra', 'light', 'terra-light'], ['terra', 'dark', 'terra'],
    ['air', 'light', 'air'], ['air', 'dark', 'air-dark'],
  ] as const)('stamps %s in %s mode whatever the Mac prefers', (family, mode, expected) => {
    installMatchMedia(true);

    expect(applyTheme({ family, mode }).resolved).toBe(expected);
    expect(document.documentElement.dataset['theme']).toBe(expected);
  });

  it('keeps the choice on the device, beside the other device preferences', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, selectedRegion: 'eu' }),
    );
    const choice = { family: 'air', mode: 'dark' } as const;

    persistThemeChoice(choice);

    expect(readDevicePreferences()).toEqual({ version: 1, selectedRegion: 'eu', theme: choice });
    expect(readThemeChoice()).toEqual(choice);
  });

  /** One axis at a time is what the picker does: two rows, each a radiogroup. */
  it('changes one axis and leaves the other alone', () => {
    installMatchMedia(false);
    persistThemeChoice({ family: 'air', mode: 'dark' });

    expect(persistThemeChoice(withMode(readThemeChoice(), 'light')))
      .toEqual({ choice: { family: 'air', mode: 'light' }, resolved: 'air' });
    expect(persistThemeChoice(withFamily(readThemeChoice(), 'terra')))
      .toEqual({ choice: { family: 'terra', mode: 'light' }, resolved: 'terra-light' });
  });

  it('applies the stored choice at install rather than the default', () => {
    const choice = { family: 'air', mode: 'light' } as const;
    persistThemeChoice(choice);
    delete document.documentElement.dataset['theme'];

    expect(installTheme()).toEqual({ choice, resolved: 'air' });
    expect(document.documentElement.dataset['theme']).toBe('air');
  });

  /**
   * A stored choice this build cannot read is dropped by the preference parser,
   * which leaves it at the default rather than stamping an attribute that
   * selects no block at all — every colour would fall back to the default
   * theme's `:root` while the picker showed something else.
   */
  it('falls back to the default when the stored choice is not one this build has', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, theme: { family: 'sepia', mode: 'dark' } }),
    );

    expect(readThemeChoice()).toEqual({ family: 'terra', mode: 'system' });
    expect(installTheme().resolved).toBe('terra-light');
  });

  /**
   * A preference written before the axes were separated. Someone who had chosen
   * the design when it was one flat name should still be on it.
   */
  it('reads a flat choice stored by an earlier build', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, theme: 'airy' }),
    );

    expect(readThemeChoice()).toEqual({ family: 'air', mode: 'light' });
    expect(installTheme().resolved).toBe('air');
  });

  describe('without matchMedia', () => {
    // jsdom has none, and neither does an Electron window early enough to be
    // certain of. Resolving `system` to light matches what Chromium answers
    // when the platform expresses no preference.
    it('resolves the system mode to light and subscribes to nothing', () => {
      expect(resolvedThemeFor({ family: 'terra', mode: 'system' })).toBe('terra-light');
      expect(() => watchSystemAppearance()()).not.toThrow();
    });
  });

  describe('watching the system appearance', () => {
    it('re-resolves when the Mac changes and the mode is system', () => {
      const media = installMatchMedia(false);
      persistThemeChoice({ family: 'terra', mode: 'system' });
      const stop = watchSystemAppearance();

      media.change(true);
      expect(document.documentElement.dataset['theme']).toBe('terra');

      media.change(false);
      expect(document.documentElement.dataset['theme']).toBe('terra-light');
      stop();
    });

    /**
     * The family never follows the Mac — it is a taste, not a lighting
     * condition — so someone on Air who is following the room stays on Air and
     * only crosses between its two appearances.
     */
    it('switches within the chosen family rather than out of it', () => {
      const media = installMatchMedia(false);
      persistThemeChoice({ family: 'air', mode: 'system' });
      const stop = watchSystemAppearance();

      expect(document.documentElement.dataset['theme']).toBe('air');
      media.change(true);
      expect(document.documentElement.dataset['theme']).toBe('air-dark');
      expect(document.documentElement.dataset['themeFamily']).toBe('air');
      stop();
    });

    // The subscription exists for the `system` mode alone. Following the Mac
    // after someone has pinned Dark is the bug it would look like a fix for.
    it('leaves a pinned mode alone', () => {
      const media = installMatchMedia(false);
      persistThemeChoice({ family: 'air', mode: 'light' });
      const stop = watchSystemAppearance();

      media.change(true);

      expect(document.documentElement.dataset['theme']).toBe('air');
      stop();
    });

    it('stops re-resolving once detached', () => {
      const media = installMatchMedia(false);
      persistThemeChoice({ family: 'terra', mode: 'system' });
      watchSystemAppearance()();

      media.change(true);

      expect(document.documentElement.dataset['theme']).toBe('terra-light');
    });
  });

  it('tells the main process which appearance to construct the next window with', async () => {
    installMatchMedia(false);
    const setWindowTheme = vi.fn(() => Promise.resolve());
    vi.stubGlobal('avalon', { setWindowTheme });

    persistThemeChoice({ family: 'air', mode: 'dark' });
    await Promise.resolve();

    expect(setWindowTheme).toHaveBeenCalledWith('air-dark');
  });
});
