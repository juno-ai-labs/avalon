import "../../../../../tests/isolated-region";
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PREFERENCES_STORAGE_KEY, readDevicePreferences } from './device-preferences';
import {
  applyTheme,
  installTheme,
  persistThemeChoice,
  readThemeChoice,
  resolvedThemeFor,
  useAppearance,
  useTheme,
  watchSystemAppearance,
  watchThemeBroadcast,
} from './theme';

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

describe('theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['themeMode'];
    removeMatchMedia();
  });

  it('starts with the one Rally design following the Mac', () => {
    expect(readThemeChoice()).toBe('system');
  });

  it('records the resolved appearance and the preference that produced it', () => {
    installMatchMedia(true);

    expect(applyTheme('system')).toEqual({ choice: 'system', resolved: 'dark' });
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.dataset['themeMode']).toBe('system');
  });

  it.each([
    ['light', true],
    ['dark', false],
  ] as const)('pins %s whatever the Mac prefers', (choice, prefersDark) => {
    installMatchMedia(prefersDark);
    expect(applyTheme(choice).resolved).toBe(choice);
    expect(document.documentElement.dataset['theme']).toBe(choice);
  });

  it('keeps the preference beside the other device preferences', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, selectedRegion: 'enterprise' }),
    );

    persistThemeChoice('dark');

    expect(readDevicePreferences()).toEqual({ version: 1, selectedRegion: 'enterprise', theme: 'dark' });
    expect(readThemeChoice()).toBe('dark');
  });

  it('applies the stored preference at install', () => {
    persistThemeChoice('light');
    delete document.documentElement.dataset['theme'];

    expect(installTheme()).toEqual({ choice: 'light', resolved: 'light' });
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('falls back when the stored preference is unreadable', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, theme: 'sepia' }),
    );

    expect(readThemeChoice()).toBe('system');
    expect(installTheme().resolved).toBe('light');
  });

  it('migrates the previous family-shaped preference by keeping its mode', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, theme: { family: 'retired', mode: 'dark' } }),
    );

    expect(readThemeChoice()).toBe('dark');
    expect(installTheme().resolved).toBe('dark');
  });

  it('resolves system to light without matchMedia and subscribes to nothing', () => {
    expect(resolvedThemeFor('system')).toBe('light');
    expect(() => watchSystemAppearance()()).not.toThrow();
  });

  it('re-resolves system when the Mac changes', () => {
    const media = installMatchMedia(false);
    persistThemeChoice('system');
    const stop = watchSystemAppearance();

    media.change(true);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    media.change(false);
    expect(document.documentElement.dataset['theme']).toBe('light');
    stop();
  });

  it('leaves a pinned preference alone when the Mac changes', () => {
    const media = installMatchMedia(false);
    persistThemeChoice('light');
    const stop = watchSystemAppearance();

    media.change(true);
    expect(document.documentElement.dataset['theme']).toBe('light');
    stop();
  });

  it('stops following the Mac once detached', () => {
    const media = installMatchMedia(false);
    persistThemeChoice('system');
    watchSystemAppearance()();

    media.change(true);
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  describe('following another window', () => {
    it('applies and reports the preference carried by the broadcast', () => {
      installMatchMedia(false);
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire('dark');

      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(document.documentElement.dataset['themeMode']).toBe('dark');
      expect(bridge.reported).toEqual(['dark']);
      stop();
    });

    it('resolves a broadcast system preference against this window', () => {
      installMatchMedia(true);
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire('system');

      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(document.documentElement.dataset['themeMode']).toBe('system');
      stop();
    });

    it('uses the payload instead of a stale local store', () => {
      installMatchMedia(false);
      window.localStorage.setItem(
        DEVICE_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ version: 1, theme: 'light' }),
      );
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire('dark');

      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(bridge.reported).toEqual(['dark']);
      stop();
    });

    it('falls back to the store for an unreadable payload', () => {
      installMatchMedia(false);
      window.localStorage.setItem(
        DEVICE_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ version: 1, theme: 'dark' }),
      );
      const bridge = installBridge();
      const stop = watchThemeBroadcast();

      bridge.fire('sepia');

      expect(document.documentElement.dataset['theme']).toBe('dark');
      stop();
    });

    it('detaches and is inert without the desktop bridge', () => {
      installMatchMedia(false);
      const bridge = installBridge();
      watchThemeBroadcast()();
      expect(bridge.listeners).toBe(0);

      vi.stubGlobal('rally', undefined);
      expect(() => watchThemeBroadcast()()).not.toThrow();
    });
  });

  it('reports a preference change even when the resolved appearance is unchanged', async () => {
    installMatchMedia(true);
    const setWindowTheme = vi.fn(() => Promise.resolve());
    vi.stubGlobal('rally', { setWindowTheme });

    expect(persistThemeChoice('system').resolved).toBe('dark');
    expect(persistThemeChoice('dark').resolved).toBe('dark');
    await Promise.resolve();

    expect(setWindowTheme).toHaveBeenNthCalledWith(1, 'system');
    expect(setWindowTheme).toHaveBeenNthCalledWith(2, 'dark');
  });
});

describe('what a surface reads', () => {
  beforeEach(() => {
    window.localStorage.clear();
    removeMatchMedia();
  });

  it('reads the applied appearance instead of a stale store', () => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, theme: 'light' }),
    );
    applyTheme('dark');

    expect(renderHook(() => useTheme()).result.current.resolved).toBe('dark');
    expect(renderHook(() => useAppearance()).result.current).toBe('dark');
  });

  it('follows an appearance applied while mounted', () => {
    applyTheme('light');
    const { result, rerender } = renderHook(() => useAppearance());

    expect(result.current).toBe('light');
    applyTheme('dark');
    rerender();
    expect(result.current).toBe('dark');
  });
});
