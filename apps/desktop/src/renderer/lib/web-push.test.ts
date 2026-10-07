import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { enableWebPush, reconcileWebPush, webPushState } from './web-push';

// A 65-byte uncompressed point, as a VAPID public key is.
const currentKey = `B${'A'.repeat(86)}`;
const currentKeyBytes = Uint8Array.from(atob(`${currentKey.replace(/-/gu, '+').replace(/_/gu, '/')}=`), (c) => c.charCodeAt(0));

function subscriptionWith(key: Uint8Array, endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  return {
    endpoint,
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function browserWith(permission: NotificationPermission, existing: ReturnType<typeof subscriptionWith> | null) {
  const fresh = subscriptionWith(currentKeyBytes, 'https://fcm.googleapis.com/fcm/send/fresh');
  const pushManager = { getSubscription: vi.fn(async () => existing), subscribe: vi.fn(async () => fresh) };
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  vi.stubGlobal('Notification', { permission, requestPermission });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager }), register: async () => ({ pushManager }), ready: Promise.resolve() },
  });
  return { pushManager, fresh, requestPermission };
}

function api() {
  return {
    getWebPushConfiguration: vi.fn(async () => ({ publicKey: currentKey })),
    registerPushDevice: vi.fn(async () => undefined),
    deletePushDevice: vi.fn(async () => undefined),
  };
}

describe('web push', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    Reflect.deleteProperty(navigator, 'standalone');
  });

  it('points an iOS Safari tab to the Home Screen, where Safari offers Web Push', async () => {
    // A Safari tab on iPhone: no PushManager, and navigator.standalone is false.
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });
    const client = api();
    expect(await webPushState(client as never)).toBe('home-screen');
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: undefined });
    expect(await webPushState(client as never)).toBe('unsupported');
    expect(client.getWebPushConfiguration).not.toHaveBeenCalled();
  });

  it('registers an existing subscription with this session before reporting it on', async () => {
    const existing = subscriptionWith(currentKeyBytes);
    browserWith('granted', existing);
    const client = api();
    expect(await webPushState(client as never)).toBe('on');
    expect(client.registerPushDevice).toHaveBeenCalledWith(expect.any(String), {
      platform: 'web', transport: 'webpush', endpoint: existing.endpoint,
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' }, appVersion: 'web',
    });
  });

  it('rebinds a subscription from an earlier sign-in when a session starts', async () => {
    browserWith('granted', subscriptionWith(currentKeyBytes));
    const client = api();
    await reconcileWebPush(client as never);
    expect(client.registerPushDevice).toHaveBeenCalledOnce();
  });

  it('replaces a subscription made with an earlier server key', async () => {
    const stale = subscriptionWith(new Uint8Array(65).fill(4));
    const browser = browserWith('granted', stale);
    const client = api();
    expect(await webPushState(client as never)).toBe('on');
    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: currentKeyBytes });
    expect(client.registerPushDevice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ endpoint: browser.fresh.endpoint }));
  });

  it('leaves a browser without permission unregistered', async () => {
    browserWith('default', subscriptionWith(currentKeyBytes));
    const client = api();
    await reconcileWebPush(client as never);
    expect(await webPushState(client as never)).toBe('off');
    expect(client.registerPushDevice).not.toHaveBeenCalled();
  });

  it('reads only the unavailable answer as unavailable and lets any other failure through', async () => {
    browserWith('granted', null);
    const client = api();
    client.getWebPushConfiguration.mockRejectedValueOnce(new ApiError('not here', 404, 'web_push_unavailable'));
    expect(await webPushState(client as never)).toBe('unavailable');
    client.getWebPushConfiguration.mockRejectedValueOnce(new ApiError('Server error', 500, 'internal_error'));
    await expect(webPushState(client as never)).rejects.toThrow('Server error');
  });

  it('asks for permission before waiting on the network', async () => {
    const browser = browserWith('default', null);
    const client = api();
    const order: string[] = [];
    browser.requestPermission.mockImplementation(async () => { order.push('permission'); return 'granted'; });
    client.getWebPushConfiguration.mockImplementation(async () => { order.push('configuration'); return { publicKey: currentKey }; });
    expect(await enableWebPush(client as never)).toBe('on');
    expect(order).toEqual(['permission', 'configuration']);
  });

  it('does not register a subscription on a push service the API would refuse', async () => {
    browserWith('granted', subscriptionWith(currentKeyBytes, 'https://push.example.test/abc'));
    const client = api();
    expect(await webPushState(client as never)).toBe('unsupported');
    expect(client.registerPushDevice).not.toHaveBeenCalled();
  });
});
