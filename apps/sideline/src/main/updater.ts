import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { AppUpdater, UpdateDownloadedEvent } from "electron-updater";
import electronUpdater from "electron-updater";

const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000;

interface UpdateLogger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

type SidelineUpdater = Omit<Pick<
  AppUpdater,
  "autoDownload" | "autoInstallOnAppQuit" | "allowDowngrade" | "checkForUpdates" | "quitAndInstall" | "on"
>, "on"> & {
  on(event: "update-downloaded", listener: (event: UpdateDownloadedEvent) => void): SidelineUpdater;
  on(event: "error", listener: (error: Error) => void): SidelineUpdater;
};

export interface SidelineUpdateDependencies {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  updater?: SidelineUpdater;
  scheduleInterval?(callback: () => void, delayMs: number): { unref(): unknown };
  log?: UpdateLogger;
}

export function initializeSidelineUpdater(deps: SidelineUpdateDependencies): { enabled: boolean } {
  const log = deps.log ?? console;
  if (!deps.isPackaged || deps.platform !== "darwin" || deps.arch !== "arm64") {
    log.info("[sideline] auto-update disabled for this build");
    return { enabled: false };
  }

  const updater = deps.updater ?? electronUpdater.autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;

  updater.on("error", (error) => {
    log.error("[sideline] automatic update failed", error);
  });
  updater.on("update-downloaded", (event) => {
    void deps.showMessageBox({
      type: "info",
      message: "Sideline is ready to update",
      detail: `Version ${event.version} has been downloaded. Restart Sideline to install it.`,
      buttons: ["Restart Sideline", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) updater.quitAndInstall(false, true);
    }).catch((error: unknown) => {
      log.error("[sideline] could not show the update prompt", error);
    });
  });

  const check = (): void => {
    void updater.checkForUpdates().catch((error: unknown) => {
      log.error("[sideline] could not check for updates", error);
    });
  };
  check();
  const schedule = deps.scheduleInterval ?? ((callback, delayMs) => {
    const handle = setInterval(callback, delayMs);
    return { unref: () => handle.unref() };
  });
  schedule(check, UPDATE_INTERVAL_MS).unref();
  return { enabled: true };
}
