import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
// electron-updater is published as CommonJS. Electron's native ESM loader does
// not reliably synthesize named exports for it in a packaged app, so import the
// CommonJS namespace through the default export. Keep the lazy singleton read
// inside initialization so unit tests can inject an updater without requiring
// a real Electron `app` instance.
import electronUpdater from 'electron-updater';
import { updatePolicy } from './update-policy';
import type { DesktopUpdateStatus } from '../common/desktop';
import type { DesktopReleaseChannel } from '../common/release-channels';

const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** The first automatic check waits this long after launch, keeping the feed
 * request and any download out of the app's startup. */
export const STARTUP_CHECK_DELAY_MS = 10 * 60 * 1000;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 3_000;
const MAX_DOWNLOAD_RETRIES = 5;
/** A downloaded update waits quietly behind the sidebar button until the
 * running build is this old; past it, Rally asks once per downloaded version. */
export const STALE_BUILD_PROMPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const MANUAL_UPDATE_URL =
  'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg';


export interface UpdateOutcome {
  phase: 'check' | 'download' | 'apply' | 'rollback';
  result: 'available' | 'current' | 'success' | 'failed' | 'cancelled';
  durationMs: number;
}

interface UpdateLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface IntervalHandle {
  unref(): unknown;
}

interface ConsumedUpdaterEvents {
  readonly 'checking-for-update': () => void;
  readonly 'update-available': (info: UpdateInfo) => void;
  readonly 'update-not-available': (info: UpdateInfo) => void;
  readonly 'download-progress': (progress: ProgressInfo) => void;
  readonly 'update-downloaded': (info: UpdateDownloadedEvent) => void;
  readonly error: (error: Error, message?: string) => void;
}

/** The updater surface this module consumes; tests must implement this port. */
export type AutoUpdaterPort = Omit<Pick<
  AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowDowngrade'
  | 'channel'
  | 'disableDifferentialDownload'
  | 'logger'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'quitAndInstall'
  | 'on'
>, 'on'> & {
  on<Event extends keyof ConsumedUpdaterEvents>(
    event: Event,
    listener: ConsumedUpdaterEvents[Event],
  ): AutoUpdaterPort;
};

export interface AutoUpdateDependencies {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly linuxPackageType?: string;
  readonly currentVersion: string;
  /** When the running build was made, in epoch milliseconds; unknown builds are never stale. */
  readonly currentBuildTime?: number | undefined;
  readonly releaseChannel: DesktopReleaseChannel;
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  readonly openExternal: (url: string) => Promise<unknown>;
  /** Flush protected local state before Squirrel terminates the process. */
  readonly beforeInstall?: () => Promise<void>;
  /** Roll back preparation side effects when installation does not start. */
  readonly onInstallFailed?: () => Promise<void> | void;
  readonly onStatusChange?: (status: DesktopUpdateStatus) => void;
  /** Content-free observation seam; exceptions are isolated from update control flow. */
  readonly onOutcome?: (outcome: UpdateOutcome) => void;
  readonly now?: () => number;
  readonly log?: UpdateLogger;
  /** Test seam; production uses electron-updater's singleton. */
  readonly updater?: AutoUpdaterPort;
  /** Test seam; production uses the Node interval. */
  readonly scheduleInterval?: (callback: () => void, delayMs: number) => IntervalHandle;
  /** Test seam; production uses the Node timeout. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => IntervalHandle;
}

export interface AutoUpdateController {
  readonly enabled: boolean;
  checkForUpdates(): void;
  installDownloadedUpdate(): void;
  setReleaseChannel(channel: DesktopReleaseChannel): void;
}

function sameStatus(left: DesktopUpdateStatus, right: DesktopUpdateStatus): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'downloaded' && right.kind === 'downloaded') {
    return left.version === right.version;
  }
  if (left.kind === 'downloading' && right.kind === 'downloading') {
    return left.percent === right.percent;
  }
  return true;
}

/**
 * Wire the macOS and Linux update lifecycle. The feed is embedded by
 * electron-builder in app-update.yml; setting a feed URL at runtime would make
 * packaged builds dependent on mutable local configuration.
 */
export function initializeAutoUpdate(deps: AutoUpdateDependencies): AutoUpdateController {
  const log = deps.log ?? console;
  const policy = updatePolicy(deps);
  const showDialog = (options: MessageBoxOptions): Promise<MessageBoxReturnValue | null> => (
    deps.showMessageBox(options).catch((error: unknown) => {
      log.error('[rally] failed to show update dialog', error);
      return null;
    })
  );

  if (policy.kind === 'disabled') {
    log.info(`[rally] auto-update disabled: ${policy.reason}`);
    return {
      enabled: false,
      checkForUpdates: () => {
        void showDialog({
          type: 'info',
          message: 'Updates aren’t available in this build',
          detail: 'Automatic updates are available in the installed macOS app, Linux AppImage, and Debian package.',
          buttons: ['OK'],
        });
      },
      installDownloadedUpdate: () => undefined,
      setReleaseChannel: () => undefined,
    };
  }

  const updater = deps.updater ?? electronUpdater.autoUpdater;
  // A Debian install can require an administrator prompt: apply on explicit
  // restart, never unexpectedly during ordinary quit.
  const installOnQuit = deps.platform !== 'linux' || deps.linuxPackageType !== 'deb';
  const manualUpdateUrl = deps.platform === 'linux'
    ? `https://downloads.rallywith.ai/stable/linux/x64/Rally.${deps.linuxPackageType === 'deb' ? 'deb' : 'AppImage'}`
    : MANUAL_UPDATE_URL;
  let status: DesktopUpdateStatus = { kind: 'idle' };
  let manualCheck = false;
  let checkInFlight = false;
  let downloadInFlight = false;
  let downloadRetryCount = 0;
  let downloadRetryScheduled = false;
  let manualRecoveryPrompted = false;
  let installInFlight = false;
  /** The build staged for install. While set, checks keep running in the
   * background and the restart offer stays up until a newer build replaces it. */
  let stagedVersion: string | null = null;
  /** The build `stagedVersion` replaced, kept in case Squirrel fails to stage it. */
  let previousStagedVersion: string | null = null;
  let currentChannel = deps.releaseChannel;
  let channelRecheckPending = false;
  let channelRecheckScheduled = false;
  let checkStartedAt: number | null = null;
  let downloadStartedAt: number | null = null;
  let applyStartedAt: number | null = null;
  const now = deps.now ?? Date.now;
  const outcome = (phase: UpdateOutcome['phase'], result: UpdateOutcome['result'], startedAt: number | null): void => {
    if (startedAt === null) return;
    try {
      deps.onOutcome?.({ phase, result, durationMs: Math.max(0, Math.round(now() - startedAt)) });
    } catch {
      // Telemetry must never alter update state, retry, or user feedback.
    }
  };
  const setStatus = (next: DesktopUpdateStatus): void => {
    if (sameStatus(status, next)) return;
    status = next;
    deps.onStatusChange?.(next);
  };
  const showCheckFailure = (): void => {
    if (!manualCheck) return;
    manualCheck = false;
    void showDialog({
      type: 'warning',
      message: 'Couldn’t check for updates',
      detail: 'Rally could not reach the update service. Please try again later.',
      buttons: ['OK'],
    });
  };
  const promptManualRecovery = (): void => {
    if (manualRecoveryPrompted) return;
    manualRecoveryPrompted = true;
    log.warn('[rally] automatic update retries exhausted; offering signed installer');
    void showDialog({
      type: 'warning',
      message: 'Couldn’t update automatically',
      detail:
        deps.platform === 'linux'
          ? 'Rally could not finish the update. Download the latest Linux package and replace the current installation.'
          : 'Rally could not finish the update after several attempts. Download the latest signed Rally installer and replace the current copy in Applications.',
      buttons: ['Download Latest', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result?.response !== 0) return;
      void deps.openExternal(manualUpdateUrl).catch((error: unknown) => {
        log.error('[rally] failed to open the manual update download', error);
      });
    });
  };
  const installUpdate = (): void => {
    // A channel change invalidates any dialog or renderer command associated
    // with the previously downloaded build.
    if (installInFlight || status.kind !== 'downloaded') return;
    installInFlight = true;
    applyStartedAt = now();
    void Promise.resolve()
      .then(() => deps.beforeInstall?.())
      .then(() => updater.quitAndInstall(false, true))
      .catch((error: unknown) => { void installationFailed(error); });
  };
  const installationFailed = async (error: unknown): Promise<void> => {
    if (!installInFlight) return;
    outcome('apply', 'failed', applyStartedAt);
    applyStartedAt = null;
    log.error('[rally] could not prepare the downloaded update for installation', error);
    const rollbackStartedAt = now();
    try {
      await deps.onInstallFailed?.();
      outcome('rollback', 'success', rollbackStartedAt);
    } catch (rollbackError) {
      outcome('rollback', 'failed', rollbackStartedAt);
      log.error('[rally] could not roll back failed update preparation', rollbackError);
    } finally {
      installInFlight = false;
    }
    await showDialog({
      type: 'warning',
      message: 'Couldn’t restart to update',
      detail: 'Rally kept your current session and did not install the update. Please try again.',
      buttons: ['OK'],
    });
  };

  let staleBuildPromptedVersion: string | null = null;
  const promptIfStaleBuild = (): void => {
    if (status.kind !== 'downloaded' || installInFlight) return;
    // An unstamped or unparsable build time is unknown, and never stale.
    if (deps.currentBuildTime === undefined || !Number.isFinite(deps.currentBuildTime)) return;
    if (now() - deps.currentBuildTime < STALE_BUILD_PROMPT_AGE_MS) return;
    const { version } = status;
    if (staleBuildPromptedVersion === version) return;
    staleBuildPromptedVersion = version;
    void showDialog({
      type: 'info',
      message: 'Update ready',
      detail: `Rally ${version} has been downloaded. Restart now to finish updating?`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      // installUpdate refuses a build the channel change already superseded.
      if (result?.response === 0 && status.kind === 'downloaded' && status.version === version) installUpdate();
    });
  };

  const scheduleTimeout = deps.scheduleTimeout
    ?? ((callback: () => void, delayMs: number) => {
      const handle = setTimeout(callback, delayMs);
      return { unref: () => handle.unref() };
    });
  const handleDownloadFailure = (error: unknown): void => {
    log.error('[rally] update download failed', error);
    if (!downloadInFlight || downloadRetryScheduled) return;
    if (downloadRetryCount >= MAX_DOWNLOAD_RETRIES) {
      downloadInFlight = false;
      outcome('download', 'failed', downloadStartedAt);
      downloadStartedAt = null;
      // A staged build still installs, so the next scheduled check tries the
      // newer one again instead of sending the user to the manual installer.
      if (stagedVersion !== null) return;
      setStatus({ kind: 'idle' });
      promptManualRecovery();
      return;
    }

    downloadRetryCount += 1;
    downloadRetryScheduled = true;
    if (stagedVersion === null) setStatus({ kind: 'downloading' });
    const delayMs = DOWNLOAD_RETRY_BASE_DELAY_MS * (2 ** (downloadRetryCount - 1));
    log.info(
      `[rally] retrying update download in ${delayMs}ms `
        + `(${downloadRetryCount}/${MAX_DOWNLOAD_RETRIES})`,
    );
    const retryChannel = currentChannel;
    const retryTimer = scheduleTimeout(() => {
      // Clear before starting the next attempt: electron-updater may emit the
      // error synchronously before downloadUpdate's promise rejects.
      downloadRetryScheduled = false;
      if (retryChannel !== currentChannel) return;
      void Promise.resolve()
        .then(() => updater.downloadUpdate())
        .catch((retryError: unknown) => handleDownloadFailure(retryError));
    }, delayMs);
    retryTimer.unref();
  };

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = installOnQuit;
  updater.channel = deps.releaseChannel;
  // electron-updater enables downgrades as a side effect of setting a channel.
  // Rally's two channels differ only in when their monotonic manifest moves;
  // switching back to Stable must never install an older build.
  updater.allowDowngrade = false;
  // Keep electron-updater's differential download default enabled. The
  // Cloudflare feed supports HTTP range requests and blockmap downloads.
  updater.logger = log;

  const finishSupersededChannelWork = (): void => {
    if (!channelRecheckPending || channelRecheckScheduled) return;
    channelRecheckScheduled = true;
    checkInFlight = false;
    downloadInFlight = false;
    downloadRetryCount = 0;
    downloadRetryScheduled = false;
    manualCheck = false;
    checkStartedAt = null;
    downloadStartedAt = null;
    stagedVersion = null;
    previousStagedVersion = null;
    setStatus({ kind: 'idle' });
    // electron-updater decides whether to auto-download immediately after it
    // emits update-available. Leave autoDownload false until that synchronous
    // emission is over, then check the newly selected feed.
    void Promise.resolve().then(() => {
      channelRecheckScheduled = false;
      if (!channelRecheckPending) return;
      channelRecheckPending = false;
      updater.autoDownload = true;
      runCheck(false);
    });
  };

  updater.on('checking-for-update', () => {
    checkInFlight = true;
    checkStartedAt ??= now();
    if (stagedVersion === null) setStatus({ kind: 'checking' });
    log.info('[rally] checking for updates');
  });
  updater.on('update-available', (info) => {
    outcome('check', 'available', checkStartedAt);
    checkStartedAt = null;
    checkInFlight = false;
    manualCheck = false;
    if (channelRecheckPending) {
      log.info(`[rally] ignoring update ${info.version} from the previous channel`);
      finishSupersededChannelWork();
      return;
    }
    // With a build staged the check ran with autoDownload off, so the staged
    // version is not fetched and handed to Squirrel again every interval. The
    // feed is monotonic and downgrades are off, so any other version is newer.
    if (stagedVersion !== null && info.version === stagedVersion) return;
    downloadInFlight = true;
    downloadRetryCount = 0;
    downloadRetryScheduled = false;
    manualRecoveryPrompted = false;
    downloadStartedAt = now();
    log.info(`[rally] update ${info.version} is available`);
    if (stagedVersion === null) {
      setStatus({ kind: 'downloading' });
      return;
    }
    // Keep offering the staged build while the newer one downloads: Squirrel
    // still holds it, so a restart now installs it.
    log.info(`[rally] downloading ${info.version} to replace staged ${stagedVersion}`);
    void Promise.resolve()
      .then(() => updater.downloadUpdate())
      .catch((error: unknown) => handleDownloadFailure(error));
  });
  updater.on('update-not-available', () => {
    outcome('check', 'current', checkStartedAt);
    checkStartedAt = null;
    checkInFlight = false;
    if (channelRecheckPending) {
      finishSupersededChannelWork();
      return;
    }
    if (stagedVersion !== null) {
      log.info(`[rally] staged update ${stagedVersion} is still the latest`);
      return;
    }
    setStatus({ kind: 'idle' });
    log.info('[rally] is up to date');
    if (!manualCheck) return;
    manualCheck = false;
    void showDialog({
      type: 'info',
      message: 'You are running the latest version',
      detail: `Rally ${deps.currentVersion} is the latest version.`,
      buttons: ['OK'],
    });
  });
  updater.on('download-progress', (progress) => {
    downloadInFlight = true;
    if (channelRecheckPending || stagedVersion !== null) return;
    setStatus({ kind: 'downloading', percent: progress.percent });
  });
  updater.on('update-downloaded', (info) => {
    outcome('download', 'success', downloadStartedAt);
    downloadStartedAt = null;
    checkInFlight = false;
    downloadInFlight = false;
    downloadRetryCount = 0;
    downloadRetryScheduled = false;
    if (channelRecheckPending) {
      log.info(`[rally] discarded downloaded update ${info.version} after the channel changed`);
      finishSupersededChannelWork();
      return;
    }
    updater.autoInstallOnAppQuit = installOnQuit;
    previousStagedVersion = stagedVersion;
    stagedVersion = info.version;
    setStatus({ kind: 'downloaded', version: info.version });
    // The renderer offers the restart; a dialog interrupts only a stale build.
    log.info(`[rally] update ${info.version} downloaded`);
    promptIfStaleBuild();
  });
  updater.on('error', (error) => {
    if (installInFlight) {
      void installationFailed(error);
      return;
    }
    const checking = checkInFlight;
    checkInFlight = false;
    if (channelRecheckPending) {
      log.info('[rally] previous-channel update work settled after the channel changed');
      finishSupersededChannelWork();
      return;
    }
    if (downloadInFlight) {
      handleDownloadFailure(error);
      return;
    }
    if (stagedVersion !== null && !checking) {
      // MacUpdater emits update-downloaded before Squirrel.Mac stages the
      // archive, so an error outside a check is that staging failing. Fall
      // back to the build Squirrel already held, if any; the next check
      // downloads the failed version again.
      log.error(`[rally] could not stage update ${stagedVersion}`, error);
      stagedVersion = previousStagedVersion;
      previousStagedVersion = null;
      setStatus(stagedVersion === null ? { kind: 'idle' } : { kind: 'downloaded', version: stagedVersion });
      return;
    }
    log.error('[rally] auto-update error', error);
    outcome('check', 'failed', checkStartedAt);
    checkStartedAt = null;
    if (stagedVersion !== null) return;
    setStatus({ kind: 'idle' });
    showCheckFailure();
  });

  function runCheck(manual: boolean): void {
    if (checkInFlight || downloadInFlight || installInFlight) return;
    const background = stagedVersion !== null;
    // The menu offers only the restart while a build is staged, so a check
    // then is always the quiet background one.
    manualCheck = manual && !background;
    checkInFlight = true;
    checkStartedAt = now();
    if (background) {
      // Decide in update-available whether the result is worth downloading.
      updater.autoDownload = false;
    } else {
      setStatus({ kind: 'checking' });
    }
    void updater.checkForUpdates()
      .catch((error: unknown) => {
        checkInFlight = false;
        outcome('check', 'failed', checkStartedAt);
        checkStartedAt = null;
        if (channelRecheckPending) {
          finishSupersededChannelWork();
          return;
        }
        log.error('[rally] update check failed', error);
        if (stagedVersion !== null) return;
        setStatus({ kind: 'idle' });
        showCheckFailure();
      })
      .finally(() => {
        // electron-updater reads autoDownload synchronously after emitting
        // update-available, so restore it only once the check has settled. A
        // channel change owns the flag until its own recheck.
        if (background && !channelRecheckPending) updater.autoDownload = true;
      });
  }

  log.info(
    `[rally] auto-update initialized (current=${deps.currentVersion}, platform=${deps.platform}, `
      + `arch=${deps.arch}, channel=${deps.releaseChannel}, differentialDownload=enabled)`,
  );
  // A manual check or a channel change before this fires still checks at once.
  scheduleTimeout(() => runCheck(false), STARTUP_CHECK_DELAY_MS).unref();
  const scheduleInterval = deps.scheduleInterval
    ?? ((callback: () => void, delayMs: number) => {
      const handle = setInterval(callback, delayMs);
      return { unref: () => handle.unref() };
    });
  const interval = scheduleInterval(() => {
    // A download finished while the build was still fresh asks here once the
    // build ages past the threshold.
    promptIfStaleBuild();
    runCheck(false);
  }, UPDATE_INTERVAL_MS);
  interval.unref();

  return {
    enabled: true,
    checkForUpdates: () => runCheck(true),
    installDownloadedUpdate: installUpdate,
    setReleaseChannel: (channel) => {
      if (channel === currentChannel) return;
      currentChannel = channel;
      updater.channel = channel;
      updater.allowDowngrade = false;
      log.info(`[rally] update channel changed to ${channel}`);
      if (checkInFlight || downloadInFlight || stagedVersion !== null) {
        channelRecheckPending = true;
        // Prevent a previous-feed update from beginning a download after its
        // check returns, or installing on quit if it is already staged.
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        if (stagedVersion !== null) {
          // Withdraw the restart offer now, even while a background check or
          // download from the previous feed is still settling.
          stagedVersion = null;
          previousStagedVersion = null;
          setStatus({ kind: 'idle' });
        }
        if (downloadRetryScheduled || (!checkInFlight && !downloadInFlight)) {
          finishSupersededChannelWork();
        }
        return;
      }
      runCheck(false);
    },
  };
}
