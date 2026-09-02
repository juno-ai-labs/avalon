import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import { useDebugEnabled } from './use-debug-enabled';

const getApplicationSettings = vi.hoisted(() => vi.fn());
const settingsListeners = vi.hoisted(() => new Set<(settings: unknown) => void>());

vi.mock('./platform', () => ({
  desktopBridge: () => ({
    getApplicationSettings,
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
  }),
}));

function announce(settings: DesktopApplicationSettings): void {
  act(() => {
    for (const listener of settingsListeners) listener(settings);
  });
}

function applicationSettings(debugEnabled: boolean): DesktopApplicationSettings {
  return {
    lockdownMode: false,
    lockdownAvailable: true,
    debugEnabled,
    developerSettingsAvailable: true,
    menuBarEnabled: true,
    menuBarAvailable: true,
    menuBarPresent: true,
    launchAtLogin: true,
    launchAtLoginAvailable: true,
    productAnalyticsEnabled: true,
    productAnalyticsEffective: true,
    productAnalyticsPreferencePending: false,
    nativeCrashRestartRequired: false,
  };
}

describe('useDebugEnabled', () => {
  beforeEach(() => {
    settingsListeners.clear();
    getApplicationSettings.mockReset();
    getApplicationSettings.mockResolvedValue(applicationSettings(false));
  });

  it('starts off and adopts the stored preference', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: true,
      developerSettingsAvailable: true,
    });
    const { result } = renderHook(() => useDebugEnabled());

    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('follows a change announced by another window', async () => {
    const { result } = renderHook(() => useDebugEnabled());
    await waitFor(() => expect(getApplicationSettings).toHaveBeenCalled());

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });
    expect(result.current).toBe(true);

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });
    expect(result.current).toBe(false);
  });

  it.each([
    { liveEnabled: true, staleEnabled: false },
    { liveEnabled: false, staleEnabled: true },
  ])(
    'keeps the live debug value $liveEnabled when an older $staleEnabled snapshot settles',
    async ({ liveEnabled, staleEnabled }) => {
      let resolveInitial!: (settings: DesktopApplicationSettings) => void;
      getApplicationSettings.mockReturnValue(new Promise((resolve) => {
        resolveInitial = resolve;
      }));
      const { result } = renderHook(() => useDebugEnabled());
      await waitFor(() => expect(settingsListeners.size).toBe(1));

      announce(applicationSettings(liveEnabled));
      expect(result.current).toBe(liveEnabled);

      await act(async () => {
        resolveInitial(applicationSettings(staleEnabled));
        await Promise.resolve();
      });
      expect(result.current).toBe(liveEnabled);
    },
  );

  it('stays off when the preference cannot be read', async () => {
    getApplicationSettings.mockRejectedValue(new Error('Application settings could not be read.'));
    const { result } = renderHook(() => useDebugEnabled());

    await waitFor(() => expect(getApplicationSettings).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('unsubscribes on unmount so a later broadcast cannot update it', async () => {
    const { result, unmount } = renderHook(() => useDebugEnabled());
    await waitFor(() => expect(getApplicationSettings).toHaveBeenCalled());

    unmount();
    expect(settingsListeners.size).toBe(0);

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });
    expect(result.current).toBe(false);
  });
});
