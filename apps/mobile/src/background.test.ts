import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  updates: { isEnabled: true, checkForUpdateAsync: vi.fn(), fetchUpdateAsync: vi.fn(), reloadAsync: vi.fn() },
  background: { getStatusAsync: vi.fn(), registerTaskAsync: vi.fn(), BackgroundTaskStatus: { Available: 2, Restricted: 1 }, BackgroundTaskResult: { Success: 1, Failed: 2 } },
  tasks: { defineTask: vi.fn(), isTaskRegisteredAsync: vi.fn() },
  device: { isDevice: true }, platform: { OS: 'ios' }, status: vi.fn(), failure: vi.fn(),
}));
vi.mock('expo-updates', () => native.updates);
vi.mock('expo-background-task', () => native.background);
vi.mock('expo-task-manager', () => native.tasks);
vi.mock('expo-device', () => native.device);
vi.mock('react-native', () => ({ Platform: native.platform }));
vi.mock('./diagnostics', () => ({ setRuntimeStatus: native.status, recordFailure: native.failure }));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.stubGlobal('__DEV__', false);
  native.updates.isEnabled = true; native.device.isDevice = true; native.platform.OS = 'ios';
  native.background.getStatusAsync.mockResolvedValue(2);
  native.tasks.isTaskRegisteredAsync.mockResolvedValue(false);
});

afterEach(() => vi.unstubAllGlobals());

it('shares an in-flight download without restarting a user’s open canvas', async () => {
  let finish!: (value: { isAvailable: boolean }) => void;
  native.updates.checkForUpdateAsync.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { downloadUpdate } = await import('./background');
  const first = downloadUpdate();
  expect(downloadUpdate()).toBe(first);
  finish({ isAvailable: true }); await first;
  expect(native.updates.checkForUpdateAsync).toHaveBeenCalledOnce();
  expect(native.updates.fetchUpdateAsync).toHaveBeenCalledOnce();
  expect(native.status).toHaveBeenLastCalledWith({ update: 'ready' });
  expect(native.updates.reloadAsync).not.toHaveBeenCalled();
});

it('downloads rollback directives and reports failure so the OS can retry', async () => {
  native.updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: true });
  native.updates.fetchUpdateAsync.mockRejectedValue(new Error('offline'));
  await import('./background');
  const task = native.tasks.defineTask.mock.calls[0]![1] as () => Promise<number>;
  expect(await task()).toBe(2);
  expect(native.failure).toHaveBeenCalledWith('update_check_failed');
  native.updates.fetchUpdateAsync.mockResolvedValue(undefined);
  expect(await task()).toBe(1);
  expect(native.status).toHaveBeenCalledWith({ update: 'ready' });
});

it('registers only where the system permits background work, using its default cadence', async () => {
  const { registerBackgroundSync } = await import('./background');
  native.device.isDevice = false;
  await registerBackgroundSync();
  expect(native.background.registerTaskAsync).not.toHaveBeenCalled();
  native.platform.OS = 'android';
  native.background.getStatusAsync.mockResolvedValue(1);
  await registerBackgroundSync();
  expect(native.background.registerTaskAsync).not.toHaveBeenCalled();
  native.background.getStatusAsync.mockResolvedValue(2);
  await registerBackgroundSync();
  expect(native.background.registerTaskAsync).toHaveBeenCalledExactlyOnceWith('rally-background-update');
  native.tasks.isTaskRegisteredAsync.mockResolvedValue(true);
  await registerBackgroundSync();
  expect(native.background.registerTaskAsync).toHaveBeenCalledOnce();
});

it('keeps development clients out of the release update lifecycle', async () => {
  vi.stubGlobal('__DEV__', true);
  const { downloadUpdate, registerBackgroundSync } = await import('./background');
  await downloadUpdate(); await registerBackgroundSync();
  expect(native.updates.checkForUpdateAsync).not.toHaveBeenCalled();
  expect(native.background.registerTaskAsync).not.toHaveBeenCalled();
});
