import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializeAutoUpdate,
  MANUAL_UPDATE_URL,
  type AutoUpdateDependencies,
  type AutoUpdaterPort,
  type UpdateOutcome,
  type UpdateStatus,
} from './updater';

class FakeUpdater extends EventEmitter implements AutoUpdaterPort {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  channel: string | null = null;
  disableDifferentialDownload = false;
  logger: AutoUpdaterPort['logger'] = null;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

function setup(overrides: Partial<AutoUpdateDependencies> = {}) {
  const updater = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  const showMessageBox = vi.fn(async () => ({ response: 1, checkboxChecked: false }));
  const openExternal = vi.fn(async () => undefined);
  const unref = vi.fn();
  const scheduleInterval = vi.fn(() => ({ unref }));
  const timeouts: Array<{ callback: () => void; delayMs: number }> = [];
  const scheduleTimeout = vi.fn((callback: () => void, delayMs: number) => {
    timeouts.push({ callback, delayMs });
    return { unref };
  });
  const controller = initializeAutoUpdate({
    isPackaged: true,
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    currentVersion: '1.0.0',
    releaseChannel: 'stable',
    showMessageBox,
    openExternal,
    onStatusChange: (status) => statuses.push(status),
    updater,
    scheduleInterval,
    scheduleTimeout,
    ...overrides,
  });
  return {
    controller,
    updater,
    statuses,
    showMessageBox,
    openExternal,
    scheduleInterval,
    scheduleTimeout,
    timeouts,
    unref,
  };
}

describe('desktop auto-update runtime', () => {
  // Unconditional: restoreMocks, unstubGlobals and unstubEnvs leave fake timers
  // installed, and Vitest fakes setImmediate by default — so a failed assertion
  // under fake timers would otherwise hang every later test in this file.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits bounded check and download outcomes without provider error text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00Z'));
    const outcomes: UpdateOutcome[] = [];
    const { updater } = setup({ onOutcome: (outcome) => outcomes.push(outcome), now: () => Date.now() });
    vi.advanceTimersByTime(1_500);
    updater.emit('update-available', { version: 'private-version-is-not-telemetry' });
    vi.advanceTimersByTime(6_000);
    updater.emit('update-downloaded', { version: 'private-version-is-not-telemetry' });
    expect(outcomes).toEqual([
      { phase: 'check', result: 'available', durationMs: 1_500 },
      { phase: 'download', result: 'success', durationMs: 6_000 },
    ]);
  });

  it('checks the stable channel immediately and every three hours without allowing downgrades', () => {
    const { controller, updater, statuses, scheduleInterval, unref } = setup();

    expect(controller.enabled).toBe(true);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.channel).toBe('stable');
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.disableDifferentialDownload).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(statuses).toEqual([{ kind: 'checking' }]);
    expect(scheduleInterval).toHaveBeenCalledWith(expect.any(Function), 10_800_000);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('moves to Faster immediately without allowing an older build to install', () => {
    const { controller, updater } = setup();
    updater.emit('update-not-available', { version: '1.0.0' });

    controller.setReleaseChannel('faster');

    expect(updater.channel).toBe('faster');
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('surfaces progress and installs a downloaded update after confirmation', async () => {
    let finishPreparing!: () => void;
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => {
      finishPreparing = resolve;
    }));
    const { updater, statuses, showMessageBox } = setup({ beforeInstall });
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });

    updater.emit('update-available', { version: '1.1.0' });
    updater.emit('download-progress', { percent: 52.4 });
    updater.emit('update-downloaded', { version: '1.1.0' });

    expect(statuses).toContainEqual({ kind: 'downloading' });
    expect(statuses).toContainEqual({ kind: 'downloading', percent: 52.4 });
    expect(statuses.at(-1)).toEqual({ kind: 'downloaded', version: '1.1.0' });
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Update ready',
      buttons: ['Restart Now', 'Later'],
    }));
    await vi.waitFor(() => expect(beforeInstall).toHaveBeenCalledOnce());
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    finishPreparing();
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true));
  });

  it('keeps the app running when protected state cannot be prepared', async () => {
    const beforeInstall = vi.fn(async () => {
      throw new Error('session flush failed');
    });
    const onInstallFailed = vi.fn();
    const { controller, updater, showMessageBox } = setup({ beforeInstall, onInstallFailed });
    updater.emit('update-available', { version: '1.1.0' });
    updater.emit('update-downloaded', { version: '1.1.0' });

    controller.installDownloadedUpdate();

    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Couldn’t restart to update',
      }));
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(onInstallFailed).toHaveBeenCalledOnce();
  });

  it('rolls back protected state and allows a retry when restart fails', async () => {
    const beforeInstall = vi.fn(async () => undefined);
    let finishRollback!: () => void;
    const onInstallFailed = vi.fn(() => new Promise<void>((resolve) => {
      finishRollback = resolve;
    }));
    const { controller, updater, showMessageBox } = setup({ beforeInstall, onInstallFailed });
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('restart failed');
    });
    updater.emit('update-available', { version: '1.1.0' });
    updater.emit('update-downloaded', { version: '1.1.0' });

    controller.installDownloadedUpdate();

    await vi.waitFor(() => expect(onInstallFailed).toHaveBeenCalledOnce());
    controller.installDownloadedUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();

    finishRollback();
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Couldn’t restart to update',
      }));
    });

    controller.installDownloadedUpdate();
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(2));
    expect(beforeInstall).toHaveBeenCalledTimes(2);
  });

  it('does not install an update downloaded before the channel changed', async () => {
    const { controller, updater, statuses, showMessageBox } = setup();
    let finishDialog!: (value: { response: number; checkboxChecked: boolean }) => void;
    showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { finishDialog = resolve; }));
    updater.emit('update-available', { version: '1.1.0' });
    updater.emit('update-downloaded', { version: '1.1.0' });

    controller.setReleaseChannel('faster');
    await Promise.resolve();

    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual({ kind: 'checking' });
    finishDialog({ response: 0, checkboxChecked: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('waits for an old-channel check to settle before checking the new feed', async () => {
    const { controller, updater, statuses } = setup();

    controller.setReleaseChannel('faster');
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    updater.emit('update-available', { version: '1.1.0' });
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    await Promise.resolve();

    expect(updater.autoDownload).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual({ kind: 'checking' });
  });

  it('discards an old-channel download and re-enables quit install only for the new channel', async () => {
    const { controller, updater, statuses, showMessageBox } = setup();
    updater.emit('update-available', { version: '1.1.0' });
    updater.emit('download-progress', { percent: 40 });

    controller.setReleaseChannel('faster');
    updater.emit('update-downloaded', { version: '1.1.0' });
    await Promise.resolve();

    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual({ kind: 'checking' });
    expect(showMessageBox).not.toHaveBeenCalled();

    updater.emit('update-available', { version: '1.2.0' });
    updater.emit('update-downloaded', { version: '1.2.0' });
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(statuses.at(-1)).toEqual({ kind: 'downloaded', version: '1.2.0' });
  });

  it('reports a manual no-update result and gates unpackaged builds', async () => {
    const { controller, updater, showMessageBox } = setup();
    updater.emit('update-not-available', { version: '1.0.0' });
    controller.checkForUpdates();
    updater.emit('update-not-available', { version: '1.0.0' });
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'You are running the latest version',
    }));

    const disabledDialog = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
    const disabled = setup({
      isPackaged: false,
      showMessageBox: disabledDialog,
    }).controller;
    disabled.checkForUpdates();
    await Promise.resolve();
    expect(disabled.enabled).toBe(false);
    expect(disabledDialog).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Updates aren’t available in this build',
    }));
  });

  it('retries only failed downloads with bounded exponential backoff', async () => {
    const { updater, timeouts, scheduleTimeout, showMessageBox, openExternal } = setup();
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    updater.emit('update-available', { version: '1.1.0' });

    const expectedDelays = [3_000, 6_000, 12_000, 24_000, 48_000];
    for (const [index, expectedDelay] of expectedDelays.entries()) {
      updater.emit('error', new Error(`download failure ${index + 1}`));
      expect(timeouts[index]?.delayMs).toBe(expectedDelay);
      timeouts[index]!.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    updater.emit('error', new Error('download failure exhausted'));

    expect(scheduleTimeout).toHaveBeenCalledTimes(5);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(5);
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Couldn’t update automatically',
        buttons: ['Download Latest', 'Later'],
      }));
      expect(openExternal).toHaveBeenCalledWith(MANUAL_UPDATE_URL);
    });

    // Later duplicate errors cannot stack recovery prompts.
    updater.emit('error', new Error('late duplicate'));
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('does not retry ordinary check failures or duplicate their dialog', async () => {
    const { controller, updater, scheduleTimeout, showMessageBox } = setup();
    updater.emit('update-not-available', { version: '1.0.0' });
    updater.checkForUpdates.mockRejectedValueOnce(new Error('feed unavailable'));

    controller.checkForUpdates();
    updater.emit('error', new Error('feed unavailable'));
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledTimes(1);
    });

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Couldn’t check for updates',
    }));
    expect(scheduleTimeout).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
});
