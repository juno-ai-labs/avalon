import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateStoredApplicationSettings } from './application-settings';
import { DesktopPushNotifications } from './push-notifications';
import { ClientFeatureFlagsSchema } from '@rally/contracts';
import type { StoredAuth } from './stored-auth';
const native = vi.hoisted(() => ({ start: vi.fn(), permission: vi.fn() }));
const electron = vi.hoisted(() => ({ app: { getPath: vi.fn(), isPackaged: true, getVersion: () => '1' }, pushNotifications: { registerForAPNSNotifications: vi.fn(async () => 'ab'.repeat(32)), unregisterForAPNSNotifications: vi.fn(), on: vi.fn() } }));
vi.mock('electron', () => electron);
vi.mock('node:module', () => ({ createRequire: () => () => native }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rally-push-test-'));
  electron.app.getPath.mockReturnValue(directory);
  vi.clearAllMocks();
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'darwin' : key === 'resourcesPath' ? '/test' : Reflect.get(target, key) }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
it('registers each workspace credential and keeps a switched-off installation off on relaunch', async () => {
  const credential = (workspaceId: string): StoredAuth => ({ version: 1, accessToken: 'access', refreshToken: 'refresh', expiresAt: '2099-01-01', binding: { userId: 'user', workspaceId, region: 'global' } });
  const request = vi.fn<(credential: StoredAuth, path: string, init?: RequestInit) => Promise<Response>>(async (_credential, path) => path === '/feature-flags'
    ? Response.json(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true })) : Response.json({ status: 'registered' }));
  const dependencies = { credentials: async () => [credential('one'), credential('two')], request, clicked: vi.fn(), changed: vi.fn(), warn: vi.fn() };
  const controller = new DesktopPushNotifications(dependencies);
  await controller.initialize(); await controller.reconcile();
  expect(request.mock.calls.filter(([, path]) => path.startsWith('/push-devices'))).toHaveLength(2);
  await controller.set(false);
  request.mockClear(); electron.pushNotifications.registerForAPNSNotifications.mockClear();
  const restarted = new DesktopPushNotifications(dependencies);
  await restarted.initialize(); await restarted.reconcile();
  expect(request.mock.calls.every(([, , init]) => init?.method === 'DELETE')).toBe(true);
  expect(electron.pushNotifications.registerForAPNSNotifications).not.toHaveBeenCalled();
  expect(restarted.state().pushNotificationsEnabled).toBe(false);
});
it('does not register when the product flag is off', async () => {
  await updateStoredApplicationSettings(directory, { pushNotificationsEnabled: true });
  const controller = new DesktopPushNotifications({ credentials: async () => [{ version: 1, accessToken: 'access', refreshToken: 'refresh', expiresAt: '2099-01-01', binding: { userId: 'user', workspaceId: 'workspace', region: 'global' } }], request: vi.fn(async () => Response.json(ClientFeatureFlagsSchema.parse({}))), clicked: vi.fn(), changed: vi.fn(), warn: vi.fn() });
  await controller.initialize(); await controller.reconcile();
  expect(electron.pushNotifications.registerForAPNSNotifications).not.toHaveBeenCalled();
});
