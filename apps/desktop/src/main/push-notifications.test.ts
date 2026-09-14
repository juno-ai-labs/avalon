import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopPushNotifications } from './push-notifications';
import { ClientFeatureFlagsSchema } from '@rally/contracts';
import type { StoredAuth } from './stored-auth';
const native = vi.hoisted(() => ({ start: vi.fn(), permission: vi.fn() }));
const electron = vi.hoisted(() => ({ app: { getPath: vi.fn(), isPackaged: true, getVersion: () => '1' }, pushNotifications: { registerForAPNSNotifications: vi.fn(async () => 'ab'.repeat(32)), unregisterForAPNSNotifications: vi.fn() } }));
vi.mock('electron', () => electron);
vi.mock('node:module', () => ({ createRequire: () => () => native }));
let directory: string;
let permission: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rally-push-test-'));
  electron.app.getPath.mockReturnValue(directory);
  vi.clearAllMocks();
  permission = 'enabled';
  let notify: (encoded: string) => void;
  native.start.mockImplementation((callback: (encoded: string) => void) => { notify = callback; });
  native.permission.mockImplementation(() => queueMicrotask(() => notify(JSON.stringify({ permission }))));
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'darwin' : key === 'resourcesPath' ? '/test' : Reflect.get(target, key) }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
const credential = (workspaceId: string): StoredAuth => ({ version: 1, accessToken: 'access', refreshToken: 'refresh', expiresAt: '2099-01-01', binding: { userId: 'user', workspaceId, region: 'global' } });
function fixture() {
  const credentials = [credential('one')];
  const request = vi.fn<(credential: StoredAuth, path: string, init?: RequestInit) => Promise<Response>>(async (_credential, path) => path === '/feature-flags'
    ? Response.json(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true })) : Response.json({ status: 'registered' }));
  const dependencies = { credentials: async () => [...credentials], request, clicked: vi.fn(), changed: vi.fn(), warn: vi.fn() };
  return { controller: new DesktopPushNotifications(dependencies), credentials, request, dependencies };
}
function gate() { let resolve: () => void = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('registers workspace credentials and persists the device off preference', async () => {
  const { controller, credentials, request, dependencies } = fixture();
  credentials.push(credential('two'));
  await controller.initialize();
  await vi.waitFor(() => expect(request.mock.calls.filter(([, , init]) => init?.method === 'PUT')).toHaveLength(2));
  await controller.set(false);
  request.mockClear(); electron.pushNotifications.registerForAPNSNotifications.mockClear();
  const restarted = new DesktopPushNotifications(dependencies);
  await restarted.initialize(); await restarted.reconcile();
  expect(request.mock.calls.every(([, , init]) => init?.method === 'DELETE')).toBe(true);
  expect(electron.pushNotifications.registerForAPNSNotifications).not.toHaveBeenCalled();
  expect(restarted.state().pushNotificationsEnabled).toBe(false);
});
it('does not register when the product flag is off', async () => {
  const { controller, request } = fixture();
  request.mockResolvedValue(Response.json(ClientFeatureFlagsSchema.parse({})));
  await controller.initialize(); await controller.reconcile();
  expect(electron.pushNotifications.registerForAPNSNotifications).not.toHaveBeenCalled();
});
it('waits for permission and removes registration when macOS permission is denied', async () => {
  const { controller, request } = fixture();
  const authorization = gate();
  const original = native.permission.getMockImplementation()!;
  native.permission.mockImplementation(() => { void authorization.promise.then(() => original()); });
  await controller.initialize();
  await vi.waitFor(() => expect(native.permission).toHaveBeenCalled());
  expect(electron.pushNotifications.registerForAPNSNotifications).not.toHaveBeenCalled();
  authorization.resolve();
  await vi.waitFor(() => expect(request.mock.calls.some(([, , init]) => init?.method === 'PUT')).toBe(true));
  permission = 'denied';
  controller.refreshPermission();
  await vi.waitFor(() => expect(request.mock.calls.some(([, , init]) => init?.method === 'DELETE')).toBe(true));
  expect(controller.state().pushNotificationStatus).toBe('denied');
});
it('queues a fresh credential pass when the session changes during registration', async () => {
  const { controller, request, credentials } = fixture();
  const first = gate();
  request.mockImplementationOnce(async () => { await first.promise; return Response.json(ClientFeatureFlagsSchema.parse({ pushNotificationsEnabled: true })); });
  await controller.initialize();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  credentials.push(credential('two'));
  controller.sessionChanged(); first.resolve();
  await vi.waitFor(() => expect(request.mock.calls.some(([auth, , init]) => auth.binding.workspaceId === 'two' && init?.method === 'PUT')).toBe(true));
});
it('serializes an off/on toggle behind pending deletion', async () => {
  const { controller, request } = fixture();
  await controller.initialize(); await controller.reconcile();
  request.mockClear();
  const deletion = gate();
  request.mockImplementationOnce(async () => { await deletion.promise; return new Response(null, { status: 204 }); });
  const off = controller.set(false);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const on = controller.set(true);
  await Promise.resolve();
  expect(request.mock.calls.some(([, , init]) => init?.method === 'PUT')).toBe(false);
  deletion.resolve(); await Promise.all([off, on]);
  expect(request.mock.calls.at(-1)?.[2]?.method).toBe('PUT');
});
it('cancels a stalled registration without making sign-out await networking', async () => {
  const { controller, request, credentials } = fixture();
  request.mockImplementationOnce(() => new Promise<Response>(() => {}));
  await controller.initialize();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const signal = request.mock.calls[0]![2]!.signal!;
  expect(controller.signOut(credentials)).toBeUndefined();
  expect(signal.aborted).toBe(true);
  await controller.reconcile();
  expect(request.mock.calls.some(([, , init]) => init?.method === 'DELETE')).toBe(true);
  expect(request.mock.calls.some(([, , init]) => init?.method === 'PUT')).toBe(false);
});
it('reconciles only feature-flag changes, not every repeat poll', async () => {
  const { controller } = fixture();
  const reconcile = vi.spyOn(controller, 'reconcile').mockResolvedValue();
  controller.featureFlagChanged(true); controller.featureFlagChanged(true); controller.featureFlagChanged(false);
  expect(reconcile).toHaveBeenCalledTimes(2);
});
it('keeps initialization optional when application settings are inaccessible', async () => {
  const { controller, dependencies } = fixture();
  const file = join(directory, 'not-a-directory'); await writeFile(file, 'fixture');
  electron.app.getPath.mockReturnValue(file);
  await expect(controller.initialize()).resolves.toBeUndefined();
  expect(controller.state().pushNotificationStatus).toBe('unavailable');
  expect(dependencies.warn).toHaveBeenCalledOnce();
});
