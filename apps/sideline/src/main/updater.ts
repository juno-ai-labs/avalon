import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { AppUpdater, UpdateDownloadedEvent } from "electron-updater";
import electronUpdater from "electron-updater";

const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** A downloaded update waits quietly behind the header button until the
 * running build is this old; past it, Sideline asks once per downloaded version. */
export const STALE_BUILD_PROMPT_AGE_MS = 48 * 60 * 60 * 1000;

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
  isReleaseBuild: boolean;
  platform: NodeJS.Platform;
  arch: string;
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  /** When the running build was made, in epoch milliseconds; unknown builds are never stale. */
  currentBuildTime?: number | undefined;
  /** The version now waiting to install on restart. */
  onDownloaded?(version: string): void;
  now?(): number;
  updater?: SidelineUpdater;
  scheduleInterval?(callback: () => void, delayMs: number): { unref(): unknown };
  log?: UpdateLogger;
}

export interface SidelineUpdateHandle {
  enabled: boolean;
  /** The version waiting to install on restart, or null. */
  downloadedVersion(): string | null;
  checkForUpdates(): void;
  installDownloadedUpdate(): void;
}

export interface SidelineUpdateMenuItem {
  id: "sideline-check-for-updates";
  label: "Check for Updates…";
  enabled: boolean;
  click(): void;
}

export function sidelineUpdateMenuItem(handle: SidelineUpdateHandle): SidelineUpdateMenuItem {
  return {
    id: "sideline-check-for-updates",
    label: "Check for Updates…",
    enabled: handle.enabled,
    click: handle.checkForUpdates,
  };
}

export function initializeSidelineUpdater(deps: SidelineUpdateDependencies): SidelineUpdateHandle {
  const log = deps.log ?? console;
  if (!deps.isPackaged || !deps.isReleaseBuild || deps.platform !== "darwin" || deps.arch !== "arm64") {
    log.info("[sideline] auto-update disabled for this build");
    return {
      enabled: false,
      downloadedVersion: () => null,
      checkForUpdates: () => undefined,
      installDownloadedUpdate: () => undefined,
    };
  }

  const updater = deps.updater ?? electronUpdater.autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;

  updater.on("error", (error) => {
    log.error("[sideline] automatic update failed", error);
  });
  const now = deps.now ?? Date.now;
  let downloaded: string | null = null;
  let staleBuildPromptedVersion: string | null = null;
  const install = (): void => {
    if (downloaded !== null) updater.quitAndInstall(false, true);
  };
  const promptIfStaleBuild = (): void => {
    // An unstamped or unparsable build time is unknown, and never stale.
    if (downloaded === null || deps.currentBuildTime === undefined || !Number.isFinite(deps.currentBuildTime)) return;
    if (now() - deps.currentBuildTime < STALE_BUILD_PROMPT_AGE_MS) return;
    if (staleBuildPromptedVersion === downloaded) return;
    const version = downloaded;
    staleBuildPromptedVersion = version;
    void deps.showMessageBox({
      type: "info",
      message: "Sideline is ready to update",
      detail: `Version ${version} has been downloaded. Restart Sideline to install it.`,
      buttons: ["Restart Sideline", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) install();
    }).catch((error: unknown) => {
      log.error("[sideline] could not show the update prompt", error);
    });
  };
  updater.on("update-downloaded", (event) => {
    downloaded = event.version;
    deps.onDownloaded?.(event.version);
    // The window offers the restart; a dialog interrupts only a stale build.
    promptIfStaleBuild();
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
  schedule(() => {
    promptIfStaleBuild();
    check();
  }, UPDATE_INTERVAL_MS).unref();
  return {
    enabled: true,
    downloadedVersion: () => downloaded,
    checkForUpdates: check,
    installDownloadedUpdate: install,
  };
}
