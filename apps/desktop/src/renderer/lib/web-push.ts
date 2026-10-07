import { isWebPushServiceUrl } from '@rally/contracts/push-notifications';
import { ApiError, type RallyApi } from './api';
import { iosSafariTab } from './home-screen';

/**
 * Browser notifications for a member tab: one service worker at the root, one
 * Web Push subscription per browser, registered as a `webpush` device bound to
 * the cookie session. The Mac app uses APNs through its main process instead.
 */

const INSTALLATION_KEY = 'rally-web-push-installation';

/** `home-screen`: an iOS Safari tab, which gets Web Push once added to the Home Screen. */
export type WebPushState = 'unsupported' | 'home-screen' | 'unavailable' | 'denied' | 'off' | 'on';

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

function sameKey(subscription: PushSubscription, key: Uint8Array<ArrayBuffer>): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

/** The Web Push key, or null where this API deployment cannot send Web Push. */
async function configuredKey(api: WebPushApi): Promise<string | null> {
  try {
    return (await api.getWebPushConfiguration()).publicKey;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'web_push_unavailable') return null;
    throw error;
  }
}

/**
 * This browser's subscription for the current key. A subscription made with an
 * earlier key would be refused by the push service, so it is replaced.
 */
async function subscriptionFor(registration: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  const key = applicationServerKey(publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing && sameKey(existing, key)) return existing;
  await existing?.unsubscribe();
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/**
 * Registers this browser's subscription as a device bound to the current
 * session. A push service the API does not accept is reported as unsupported.
 */
async function registerSubscription(api: WebPushApi, subscription: PushSubscription): Promise<boolean> {
  if (!isWebPushServiceUrl(subscription.endpoint)) return false;
  const json = subscription.toJSON();
  await api.registerPushDevice(installationId(), {
    platform: 'web', transport: 'webpush', endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, appVersion: 'web',
  });
  return true;
}

/** The current subscription where permission is granted and one exists, on the current key. */
async function grantedSubscription(publicKey: string): Promise<PushSubscription | null> {
  if (Notification.permission !== 'granted') return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration || !await registration.pushManager.getSubscription()) return null;
  return subscriptionFor(registration, publicKey);
}

/**
 * Binds an existing subscription to the session signed in now. A subscription
 * outlives sign-out, but the device it registered was bound to the session that
 * ended, so a new session must register it again or nothing is delivered. The
 * Mac app does the same from its main process on every session change.
 */
export async function reconcileWebPush(api: WebPushApi): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  const publicKey = await configuredKey(api);
  if (!publicKey) return;
  const subscription = await grantedSubscription(publicKey);
  if (subscription) await registerSubscription(api, subscription);
}

/** Reports "on" only once the subscription is registered for this session. */
export async function webPushState(api: WebPushApi): Promise<WebPushState> {
  if (!supported()) return iosSafariTab() ? 'home-screen' : 'unsupported';
  const publicKey = await configuredKey(api);
  if (!publicKey) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const subscription = await grantedSubscription(publicKey);
  if (!subscription) return 'off';
  return await registerSubscription(api, subscription) ? 'on' : 'unsupported';
}

/**
 * Asks for permission, subscribes this browser, and registers it. Call from a
 * click: the permission prompt comes first, before any network wait, so Safari
 * and Firefox still count it as the member's own action.
 */
export async function enableWebPush(api: WebPushApi): Promise<WebPushState> {
  if (!supported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const publicKey = await configuredKey(api);
  if (!publicKey) return 'unavailable';
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const subscription = await subscriptionFor(registration, publicKey);
  return await registerSubscription(api, subscription) ? 'on' : 'unsupported';
}

export async function disableWebPush(api: WebPushApi): Promise<WebPushState> {
  if (!supported()) return 'unsupported';
  const registration = await navigator.serviceWorker.getRegistration('/');
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
  await api.deletePushDevice(installationId());
  return 'off';
}
