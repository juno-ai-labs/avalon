import { describe, expect, it, vi } from "vitest";

import { initializeSidelineUpdater, sidelineUpdateMenuItem } from "./updater";

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

  it("checks immediately, schedules checks, and applies a downloaded update after consent", async () => {
    const updater = updaterDouble();
    const scheduled = vi.fn();
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    const result = initializeSidelineUpdater({
      isPackaged: true,
      isReleaseBuild: true,
      platform: "darwin",
      arch: "arm64",
      showMessageBox,
      updater: updater as never,
      scheduleInterval: (callback) => { scheduled.mockImplementation(callback); return { unref: vi.fn() }; },
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
    updater.listeners.get("update-downloaded")?.({ version: "0.2.0" } as never);
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: "Sideline is ready to update",
      detail: "Version 0.2.0 has been downloaded. Restart Sideline to install it.",
      buttons: ["Restart Sideline", "Later"],
    })), { timeout: 2_000 });
    await vi.waitFor(
      () => expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true),
      { timeout: 2_000 },
    );
  });
});
