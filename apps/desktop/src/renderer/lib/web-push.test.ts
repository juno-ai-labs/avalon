import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileWebPush, webPushState } from './web-push';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  toJSON: () => ({ keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
};

function browserWithSubscription(permission: NotificationPermission) {
  vi.stubGlobal('Notification', { permission });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) },
  });
}

function api() {
  return {
    getWebPushConfiguration: vi.fn(async () => ({ publicKey: 'key' })),
    registerPushDevice: vi.fn(async () => undefined),
    deletePushDevice: vi.fn(async () => undefined),
  };
}

describe('web push', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('registers an existing subscription with this session before reporting it on', async () => {
    browserWithSubscription('granted');
    const client = api();
    expect(await webPushState(client as never)).toBe('on');
    expect(client.registerPushDevice).toHaveBeenCalledWith(expect.any(String), {
      platform: 'web', transport: 'webpush', endpoint: subscription.endpoint,
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' }, appVersion: 'web',
    });
  });

  it('rebinds a subscription from an earlier sign-in when a session starts', async () => {
    browserWithSubscription('granted');
    const client = api();
    await reconcileWebPush(client as never);
    expect(client.registerPushDevice).toHaveBeenCalledOnce();
  });

  it('leaves a browser without permission unregistered', async () => {
    browserWithSubscription('default');
    const client = api();
    await reconcileWebPush(client as never);
    expect(await webPushState(client as never)).toBe('off');
    expect(client.registerPushDevice).not.toHaveBeenCalled();
  });
});
