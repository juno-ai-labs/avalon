import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicePushReadinessContext, browserPushState, devicePushNotice, macPushState, useDevicePushReadiness, type DevicePushReadiness } from './device-push';

const bridge = vi.hoisted(() => ({
  getApplicationSettings: vi.fn(),
  setPushNotificationsEnabled: vi.fn(),
  openNotificationSettings: vi.fn(async () => undefined),
  onApplicationSettingsChanged: vi.fn(() => () => undefined),
}));
const host = vi.hoisted(() => ({ value: 'desktop' as 'desktop' | 'browser' }));

vi.mock('./platform', () => ({ desktopBridge: () => bridge }));
vi.mock('./collaboration-session', () => ({ useShellCapabilities: () => ({ host: host.value, guest: false }) }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('the device push states', () => {
  it('reads the Mac from its permission and this device switch', () => {
    expect(macPushState(null)).toBe('unknown');
    expect(macPushState({ pushNotificationStatus: 'unavailable', pushNotificationsEnabled: true })).toBe('unavailable');
    expect(macPushState({ pushNotificationStatus: 'denied', pushNotificationsEnabled: true })).toBe('denied');
    expect(macPushState({ pushNotificationStatus: 'enabled', pushNotificationsEnabled: false })).toBe('off');
    expect(macPushState({ pushNotificationStatus: 'enabled', pushNotificationsEnabled: true })).toBe('ready');
    // Not yet asked: turning it on asks macOS.
    expect(macPushState({ pushNotificationStatus: 'not-determined', pushNotificationsEnabled: true })).toBe('off');
  });

  it('reads a browser from its Web Push subscription', () => {
    expect([undefined, 'on', 'off', 'denied', 'home-screen', 'unsupported', 'unavailable'].map((state) =>
      browserPushState(state as Parameters<typeof browserPushState>[0])))
      .toEqual(['unknown', 'ready', 'off', 'blocked', 'home-screen', 'unavailable', 'unconfigured']);
  });

  it('says nothing for a ready or unknown device, and offers the fix for the rest', () => {
    expect(devicePushNotice('mac', 'ready')).toBeNull();
    expect(devicePushNotice('browser', 'unknown')).toBeNull();
    expect(devicePushNotice('mac', 'off')).toEqual({ title: 'Notifications are off on this Mac', action: { label: 'Turn on', kind: 'turn-on' } });
    expect(devicePushNotice('browser', 'off')).toEqual({ title: 'Notifications are off in this browser', action: { label: 'Allow', kind: 'turn-on' } });
    expect(devicePushNotice('mac', 'denied')?.action).toEqual({ label: 'Open System Settings', kind: 'open-settings' });
    expect(devicePushNotice('browser', 'blocked')).toMatchObject({ title: 'Blocked for this site' });
    expect(devicePushNotice('browser', 'blocked')?.action).toBeUndefined();
    // A deployment with no Web Push key is not the browser's fault.
    expect(devicePushNotice('browser', 'unconfigured')).toEqual({ title: 'Browser notifications are not available yet' });
    expect(devicePushNotice('browser', 'unavailable')?.title).toBe('Not available in this browser');
  });
});

describe('useDevicePushReadiness', () => {
  beforeEach(() => {
    host.value = 'desktop';
    vi.clearAllMocks();
  });

  it('turns the Mac on from a click when it is off', async () => {
    bridge.getApplicationSettings.mockResolvedValue({ pushNotificationStatus: 'enabled', pushNotificationsEnabled: false });
    bridge.setPushNotificationsEnabled.mockResolvedValue({ pushNotificationStatus: 'enabled', pushNotificationsEnabled: true });
    const { result } = renderHook(() => useDevicePushReadiness(null), { wrapper });
    await waitFor(() => expect(result.current.state).toBe('off'));
    await act(() => result.current.act());
    expect(bridge.setPushNotificationsEnabled).toHaveBeenCalledWith(true);
    expect(result.current.state).toBe('ready');
  });

  it('opens System Settings when macOS refused them', async () => {
    bridge.getApplicationSettings.mockResolvedValue({ pushNotificationStatus: 'denied', pushNotificationsEnabled: true });
    const { result } = renderHook(() => useDevicePushReadiness(null), { wrapper });
    await waitFor(() => expect(result.current.state).toBe('denied'));
    await act(() => result.current.act());
    expect(bridge.openNotificationSettings).toHaveBeenCalled();
    expect(bridge.setPushNotificationsEnabled).not.toHaveBeenCalled();
  });

  it('takes a host-provided answer over its own, as the iPhone app shell gives', () => {
    const provided: DevicePushReadiness = { state: 'unknown', act: async () => undefined, pending: false };
    const { result } = renderHook(() => useDevicePushReadiness(null), { wrapper: ({ children }) => wrapper({
      children: <DevicePushReadinessContext.Provider value={provided}>{children}</DevicePushReadinessContext.Provider>,
    }) });
    expect(result.current).toBe(provided);
    expect(bridge.getApplicationSettings).not.toHaveBeenCalled();
  });
});
