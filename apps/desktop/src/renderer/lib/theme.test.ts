import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PREFERENCES_STORAGE_KEY, readDevicePreferences } from './device-preferences';
import {
  applyTheme,
  installTheme,
  persistThemeChoice,
  readThemeChoice,
  resolvedThemeFor,
  watchSystemAppearance,
  watchThemeBroadcast,
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

  it('starts on the shipped design following the Mac when nothing has been chosen', () => {
    expect(readThemeChoice()).toEqual({ family: 'grok', mode: 'system' });
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

    expect(readThemeChoice()).toEqual({ family: 'grok', mode: 'system' });
    expect(installTheme().resolved).toBe('grok');
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

  /**
   * A theme is a preference of the device, not of the window it was chosen in.
   * Choosing it in the Settings window and having the work stream behind it stay
   * as it was is the behaviour this removes.
   */
  describe('following a choice made in another window', () => {
    function installBridge(): { fire: (choice?: unknown) => void; listeners: number; reported: unknown[] } {
      const state = {
        fire: (() => undefined) as (choice?: unknown) => void,
        listeners: 0,
        reported: [] as unknown[],
      };
      vi.stubGlobal('rally', {
        setWindowTheme: (choice: unknown) => {
          state.reported.push(choice);
          return Promise.resolve();
        },
        onThemeChanged: (listener: (choice: unknown) => void) => {
          state.listeners += 1;
          state.fire = listener;
          return () => { state.listeners -= 1; };
        },
      });
      return state;
    }

    it('applies the choice the message carries', () => {
      installMatchMedia(false);
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire({ family: 'air', mode: 'dark' });

      expect(document.documentElement.dataset['theme']).toBe('air-dark');
      expect(document.documentElement.dataset['themeFamily']).toBe('air');
      expect(document.documentElement.dataset['themeMode']).toBe('dark');
      stop();
    });

    // The payload carries the choice, not the appearance, which is what keeps a
    // window that is following the Mac still following it — against *its* Mac.
    it('re-resolves the system mode against this window’s own Mac', () => {
      installMatchMedia(true);
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire({ family: 'air', mode: 'system' });

      expect(document.documentElement.dataset['theme']).toBe('air-dark');
      expect(document.documentElement.dataset['themeMode']).toBe('system');
      stop();
    });

    /**
     * Each window is its own renderer process, and a `localStorage` write in the
     * window that made the choice is not ordered against an IPC round trip
     * through main. A window that re-read the store instead of applying the
     * payload could read a value the write had not reached yet, re-apply the
     * *old* choice, and report it back — main would see a difference and
     * broadcast again, turning the echo guard into an oscillator. Here the store
     * is deliberately left stale.
     */
    it('does not follow a store the other window’s write has not reached yet', () => {
      installMatchMedia(false);
      window.localStorage.setItem(
        DEVICE_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ version: 1, theme: { family: 'terra', mode: 'light' } }),
      );
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire({ family: 'air', mode: 'dark' });

      expect(document.documentElement.dataset['theme']).toBe('air-dark');
      // And it reports what it drew, so main's comparison matches and stops.
      expect(bridge.reported).toEqual([{ family: 'air', mode: 'dark' }]);
      stop();
    });

    /** A payload this build cannot read leaves the store as the only meaning. */
    it('falls back to the stored choice when the message makes no sense', () => {
      installMatchMedia(false);
      window.localStorage.setItem(
        DEVICE_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ version: 1, theme: { family: 'air', mode: 'dark' } }),
      );
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire({ family: 'sepia', mode: 'dark' });

      expect(document.documentElement.dataset['theme']).toBe('air-dark');
      stop();
    });

    it('detaches, and does nothing at all without the desktop bridge', () => {
      installMatchMedia(false);
      const bridge = installBridge();
      watchThemeBroadcast()();
      expect(bridge.listeners).toBe(0);

      vi.stubGlobal('rally', undefined);
      expect(() => watchThemeBroadcast()()).not.toThrow();
    });
  });

  /**
   * The *choice* travels to main, not the appearance it resolves to. Main
   * re-resolves it when it builds a window, which is the only way `system`
   * survives Rally being closed while the Mac changes appearance — and the
   * only way main can tell that a preference changed at all, since two choices
   * can resolve to the same appearance.
   */
  it('tells the main process which choice to construct the next window from', async () => {
    installMatchMedia(false);
    const setWindowTheme = vi.fn(() => Promise.resolve());
    vi.stubGlobal('rally', { setWindowTheme });

    persistThemeChoice({ family: 'air', mode: 'dark' });
    await Promise.resolve();

    expect(setWindowTheme).toHaveBeenCalledWith({ family: 'air', mode: 'dark' });
  });

  /**
   * The case the appearance could not express: under a dark Mac, `system` and a
   * pinned Dark both draw `terra`. Main has to hear about the second one, or
   * every other window goes on believing it is following the room.
   */
  it('reports a mode change that does not change the appearance', async () => {
    installMatchMedia(true);
    const setWindowTheme = vi.fn(() => Promise.resolve());
    vi.stubGlobal('rally', { setWindowTheme });

    expect(persistThemeChoice({ family: 'terra', mode: 'system' }).resolved).toBe('terra');
    expect(persistThemeChoice({ family: 'terra', mode: 'dark' }).resolved).toBe('terra');
    await Promise.resolve();

    expect(setWindowTheme).toHaveBeenNthCalledWith(1, { family: 'terra', mode: 'system' });
    expect(setWindowTheme).toHaveBeenNthCalledWith(2, { family: 'terra', mode: 'dark' });
  });
});
