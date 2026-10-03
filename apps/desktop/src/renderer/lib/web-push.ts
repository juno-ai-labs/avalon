import type { RallyApi } from './api';

/**
 * Browser notifications for a member tab: one service worker at the root, one
 * Web Push subscription per browser, registered as a `webpush` device bound to
 * the cookie session. The Mac app uses APNs through its main process instead.
 */

const INSTALLATION_KEY = 'rally-web-push-installation';

export type WebPushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

type WebPushApi = Pick<RallyApi, 'getWebPushConfiguration' | 'registerPushDevice' | 'deletePushDevice'>;

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** One id per browser profile, so re-subscribing replaces this browser's row. */
function installationId(): string {
  try {
    const existing = localStorage.getItem(INSTALLATION_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(INSTALLATION_KEY, created);
    return created;
  } catch {
    // Without storage the id lives for this page; the next visit registers again.
    return crypto.randomUUID();
  }
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey.replace(/-/gu, '+').replace(/_/gu, '/') + '==='.slice((publicKey.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function webPushState(api: WebPushApi): Promise<WebPushState> {
  if (!supported()) return 'unsupported';
  try { await api.getWebPushConfiguration(); } catch { return 'unavailable'; }
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Asks for permission, subscribes this browser, and registers it. Call from a click. */
export async function enableWebPush(api: WebPushApi): Promise<WebPushState> {
  if (!supported()) return 'unsupported';
  const { publicKey } = await api.getWebPushConfiguration();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
  const json = subscription.toJSON();
  await api.registerPushDevice(installationId(), {
    platform: 'web', transport: 'webpush', endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, appVersion: 'web',
  });
  return 'on';
}

export async function disableWebPush(api: WebPushApi): Promise<WebPushState> {
  if (!supported()) return 'unsupported';
  const registration = await navigator.serviceWorker.getRegistration('/');
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
  await api.deletePushDevice(installationId());
  return 'off';
}
