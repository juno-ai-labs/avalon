import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState } from 'react';

import type { RallyApi } from './api';
import { useShellCapabilities } from './collaboration-session';
import { desktopBridge } from './platform';
import { enableWebPush, webPushState, type WebPushState } from './web-push';

/**
 * Whether this device can show Rally's push notifications, and the one thing
 * to offer when it cannot. Settings → Notifications and a Canvas's notices
 * record read the same answer, so they cannot disagree about a device.
 * `docs/push-notifications.md` owns the device states themselves.
 *
 * - `ready`: notifications reach this device.
 * - `off`: Rally can turn them on here, from a click.
 * - `denied`: the operating system refused them; its settings can allow them.
 * - `blocked`: the browser refused them for this site.
 * - `home-screen`: iPhone and iPad Safari offer them only to a Home Screen app.
 * - `unavailable`: this build or browser cannot show them at all.
 * - `unconfigured`: this deployment has no Web Push key, so no browser can.
 * - `unknown`: not known yet, or not knowable from this host.
 */
export type DevicePushState = 'ready' | 'off' | 'denied' | 'blocked' | 'home-screen' | 'unavailable' | 'unconfigured' | 'unknown';

/** What a surface says about a device that is not ready, and the action it offers. */
export interface DevicePushNotice {
  title: string;
  detail?: string;
  action?: { label: string; kind: 'turn-on' | 'open-settings' };
}

export interface DevicePushReadiness {
  state: DevicePushState;
  /** Runs the notice's action: turns notifications on, or opens the system's settings. */
  act: () => Promise<void>;
  pending: boolean;
}

/** The words for a device that is not ready; `null` when there is nothing to say. */
export function devicePushNotice(device: 'mac' | 'browser', state: DevicePushState): DevicePushNotice | null {
  switch (state) {
    case 'ready':
    case 'unknown':
      return null;
    case 'off':
      return device === 'mac'
        ? { title: 'Notifications are off on this Mac', action: { label: 'Turn on', kind: 'turn-on' } }
        : { title: 'Notifications are off in this browser', action: { label: 'Allow', kind: 'turn-on' } };
    case 'denied':
      return { title: 'Turned off in macOS', detail: "Rally can't show alerts or a Dock badge until you allow notifications.",
        action: { label: 'Open System Settings', kind: 'open-settings' } };
    case 'blocked':
      return { title: 'Blocked for this site', detail: "Allow notifications in your browser's site settings, then turn this on." };
    case 'home-screen':
      return { title: 'Add Rally to your Home Screen',
        detail: 'To get notifications on this device, tap Share, then Add to Home Screen. Open Rally from your Home Screen and turn this on there.' };
    case 'unconfigured':
      return { title: 'Browser notifications are not available yet' };
    case 'unavailable':
      return device === 'mac'
        ? { title: 'Not available in this build', detail: 'Notifications need an installed release build of Rally.' }
        : { title: 'Not available in this browser', detail: 'This browser cannot show Rally notifications.' };
  }
}

/** The Mac's state, from the main process's push permission and this device's switch. */
export function macPushState(settings: { pushNotificationStatus: string; pushNotificationsEnabled: boolean } | null): DevicePushState {
  if (!settings) return 'unknown';
  if (settings.pushNotificationStatus === 'unavailable') return 'unavailable';
  if (settings.pushNotificationStatus === 'denied') return 'denied';
  return settings.pushNotificationStatus === 'enabled' && settings.pushNotificationsEnabled ? 'ready' : 'off';
}

/** A browser's state, from its Web Push subscription. */
export function browserPushState(state: WebPushState | undefined): DevicePushState {
  switch (state) {
    case undefined: return 'unknown';
    case 'on': return 'ready';
    case 'off': return 'off';
    case 'denied': return 'blocked';
    case 'home-screen': return 'home-screen';
    case 'unsupported': return 'unavailable';
    case 'unavailable': return 'unconfigured';
  }
}

/**
 * A host that knows its device better than this renderer, the iPhone app's
 * shell, provides its own readiness here. Without one, the renderer reads the
 * Mac's or the browser's.
 */
export const DevicePushReadinessContext = createContext<DevicePushReadiness | null>(null);

const UNKNOWN: DevicePushReadiness = { state: 'unknown', act: async () => undefined, pending: false };

/** This device's push readiness; see `DevicePushState`. */
export function useDevicePushReadiness(api: Pick<RallyApi, 'getWebPushConfiguration' | 'registerPushDevice' | 'deletePushDevice'> | null): DevicePushReadiness {
  const provided = useContext(DevicePushReadinessContext);
  const { host } = useShellCapabilities();
  const mac = useMacPushReadiness(provided === null && host === 'desktop');
  const browser = useBrowserPushReadiness(provided === null && host === 'browser' ? api : null);
  if (provided) return provided;
  return host === 'desktop' ? mac : browser ?? UNKNOWN;
}

function useMacPushReadiness(active: boolean): DevicePushReadiness {
  const [settings, setSettings] = useState<{ pushNotificationStatus: string; pushNotificationsEnabled: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    const bridge = desktopBridge();
    let cancelled = false;
    const unsubscribe = bridge.onApplicationSettingsChanged((next) => { if (!cancelled) setSettings(next); });
    void bridge.getApplicationSettings().then((next) => { if (!cancelled) setSettings(next); }).catch(() => undefined);
    return () => { cancelled = true; unsubscribe(); };
  }, [active]);
  const state = active ? macPushState(settings) : 'unknown';
  return {
    state,
    pending,
    act: async () => {
      const bridge = desktopBridge();
      if (state === 'denied') { await bridge.openNotificationSettings(); return; }
      if (state !== 'off') return;
      setPending(true);
      try { setSettings(await bridge.setPushNotificationsEnabled(true)); } finally { setPending(false); }
    },
  };
}

function useBrowserPushReadiness(api: Parameters<typeof useDevicePushReadiness>[0]): DevicePushReadiness | null {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  // The key Settings → Notifications reads, so a change in either shows in both.
  // Read once per session here: a fresh read re-registers the subscription, and
  // a Chat remounts its rows as it scrolls. Settings reads its own fresh copy.
  const query = useQuery({ queryKey: ['web-push-state'], queryFn: () => webPushState(api!), enabled: api !== null,
    staleTime: Number.POSITIVE_INFINITY });
  if (api === null) return null;
  const state = browserPushState(query.data);
  return {
    state,
    pending,
    act: async () => {
      if (state !== 'off') return;
      setPending(true);
      try { queryClient.setQueryData(['web-push-state'], await enableWebPush(api)); } finally { setPending(false); }
    },
  };
}
