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

describe('useDebugEnabled', () => {
  beforeEach(() => {
    settingsListeners.clear();
    getApplicationSettings.mockReset();
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: false,
    });
  });

  it('starts off and adopts the stored preference', async () => {
    getApplicationSettings.mockResolvedValue({
      lockdownMode: false,
      lockdownAvailable: false,
      debugEnabled: true,
    });
    const { result } = renderHook(() => useDebugEnabled());

    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('follows a change announced by another window', async () => {
    const { result } = renderHook(() => useDebugEnabled());
    await waitFor(() => expect(getApplicationSettings).toHaveBeenCalled());

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true });
    expect(result.current).toBe(true);

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false });
    expect(result.current).toBe(false);
  });

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

    announce({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true });
    expect(result.current).toBe(false);
  });
});
