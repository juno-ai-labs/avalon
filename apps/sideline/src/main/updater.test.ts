import { describe, expect, it, vi } from "vitest";

import { initializeSidelineUpdater, sidelineUpdateMenuItem } from "./updater";

const HOUR = 60 * 60 * 1000;

function updaterDouble() {
  const listeners = new Map<string, (...args: never[]) => void>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
      return updater;
    }),
    listeners,
  };
  return updater;
}

describe("initializeSidelineUpdater", () => {
  it("does not contact the release feed outside a packaged arm64 macOS build", () => {
    const updater = updaterDouble();
    const result = initializeSidelineUpdater({
      isPackaged: false,
      isReleaseBuild: false,
      platform: "darwin",
      arch: "arm64",
      showMessageBox: vi.fn(),
      updater: updater as never,
      log: { info: vi.fn(), error: vi.fn() },
    });
    expect(result.enabled).toBe(false);
    expect(sidelineUpdateMenuItem(result)).toMatchObject({
      id: "sideline-check-for-updates",
      label: "Check for Updates…",
      enabled: false,
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("does not contact the release feed from an unsigned local package", () => {
    const updater = updaterDouble();
    const result = initializeSidelineUpdater({
      isPackaged: true,
      isReleaseBuild: false,
      platform: "darwin",
      arch: "arm64",
      showMessageBox: vi.fn(),
      updater: updater as never,
      log: { info: vi.fn(), error: vi.fn() },
    });
    expect(result.enabled).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("checks immediately, schedules checks, and installs a downloaded update on request without a dialog", () => {
    const updater = updaterDouble();
    const showMessageBox = vi.fn();
    const onDownloaded = vi.fn();
    const result = initializeSidelineUpdater({
      isPackaged: true,
      isReleaseBuild: true,
      platform: "darwin",
      arch: "arm64",
      showMessageBox,
      onDownloaded,
      currentBuildTime: 0,
      now: () => HOUR,
      updater: updater as never,
      scheduleInterval: () => ({ unref: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(result.enabled).toBe(true);
    expect(updater.autoDownload).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    const menuItem = sidelineUpdateMenuItem(result);
    expect(menuItem).toMatchObject({
      id: "sideline-check-for-updates",
      label: "Check for Updates…",
      enabled: true,
    });
    menuItem.click();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    result.installDownloadedUpdate();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    updater.listeners.get("update-downloaded")?.({ version: "0.2.0" } as never);
    expect(onDownloaded).toHaveBeenCalledWith("0.2.0");
    expect(result.downloadedVersion()).toBe("0.2.0");
    expect(showMessageBox).not.toHaveBeenCalled();

    result.installDownloadedUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("asks to restart once the running build is over 48 hours old, once per version", async () => {
    const updater = updaterDouble();
    let clock = 10 * HOUR;
    let tick!: () => void;
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    initializeSidelineUpdater({
      isPackaged: true,
      isReleaseBuild: true,
      platform: "darwin",
      arch: "arm64",
      showMessageBox,
      currentBuildTime: 0,
      now: () => clock,
      updater: updater as never,
      scheduleInterval: (callback) => { tick = callback; return { unref: vi.fn() }; },
      log: { info: vi.fn(), error: vi.fn() },
    });

    updater.listeners.get("update-downloaded")?.({ version: "0.2.0" } as never);
    expect(showMessageBox).not.toHaveBeenCalled();

    clock = 48 * HOUR + 1;
    tick();
    tick();
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: "Sideline is ready to update",
      detail: "Version 0.2.0 has been downloaded. Restart Sideline to install it.",
      buttons: ["Restart Sideline", "Later"],
    }));
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true));
  });

  it("never prompts when the build time could not be read", () => {
    const updater = updaterDouble();
    let tick!: () => void;
    const showMessageBox = vi.fn();
    initializeSidelineUpdater({
      isPackaged: true,
      isReleaseBuild: true,
      platform: "darwin",
      arch: "arm64",
      showMessageBox,
      currentBuildTime: Number.NaN,
      now: () => 100 * HOUR,
      updater: updater as never,
      scheduleInterval: (callback) => { tick = callback; return { unref: vi.fn() }; },
      log: { info: vi.fn(), error: vi.fn() },
    });

    updater.listeners.get("update-downloaded")?.({ version: "0.2.0" } as never);
    tick();
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});
