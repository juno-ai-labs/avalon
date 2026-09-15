import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
// electron-updater is published as CommonJS. Electron's native ESM loader does
// not reliably synthesize named exports for it in a packaged app, so import the
// CommonJS namespace through the default export. Keep the lazy singleton read
// inside initialization so unit tests can inject an updater without requiring
// a real Electron `app` instance.
import electronUpdater from 'electron-updater';
import { updatePolicy } from './update-policy';
import type { DesktopReleaseChannel } from '../common/release-channels';

const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 3_000;
const MAX_DOWNLOAD_RETRIES = 5;

export const MANUAL_UPDATE_URL =
  'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg';

export type UpdateStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'downloading'; readonly percent?: number }
  | { readonly kind: 'downloaded'; readonly version: string };

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
  readonly currentVersion: string;
  readonly releaseChannel: DesktopReleaseChannel;
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  readonly openExternal: (url: string) => Promise<unknown>;
  /** Flush protected local state before Squirrel terminates the process. */
  readonly beforeInstall?: () => Promise<void>;
  /** Roll back preparation side effects when installation does not start. */
  readonly onInstallFailed?: () => Promise<void> | void;
  readonly onStatusChange?: (status: UpdateStatus) => void;
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

function sameStatus(left: UpdateStatus, right: UpdateStatus): boolean {
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
 * Wire the signed macOS update lifecycle. The feed is embedded by
 * electron-builder in app-update.yml; setting a feed URL at runtime would make
 * packaged builds dependent on mutable local configuration.
 */
export function initializeAutoUpdate(deps: AutoUpdateDependencies): AutoUpdateController {
  const log = deps.log ?? console;
  const updater = deps.updater ?? electronUpdater.autoUpdater;
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
          detail: 'Automatic updates work in the installed Apple-silicon Rally app.',
          buttons: ['OK'],
        });
      },
      installDownloadedUpdate: () => undefined,
      setReleaseChannel: () => undefined,
    };
  }

  let status: UpdateStatus = { kind: 'idle' };
  let manualCheck = false;
  let checkInFlight = false;
  let downloadInFlight = false;
  let downloadRetryCount = 0;
  let downloadRetryScheduled = false;
  let manualRecoveryPrompted = false;
  let installInFlight = false;
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
  const setStatus = (next: UpdateStatus): void => {
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
        'Rally could not finish the update after several attempts. Download the latest signed Rally installer and replace the current copy in Applications.',
      buttons: ['Download Latest', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result?.response !== 0) return;
      void deps.openExternal(MANUAL_UPDATE_URL).catch((error: unknown) => {
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
      .catch(async (error: unknown) => {
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
      setStatus({ kind: 'idle' });
      promptManualRecovery();
      return;
    }

    downloadRetryCount += 1;
    downloadRetryScheduled = true;
    setStatus({ kind: 'downloading' });
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
  updater.autoInstallOnAppQuit = true;
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
    setStatus({ kind: 'checking' });
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
    downloadInFlight = true;
    downloadRetryCount = 0;
    downloadRetryScheduled = false;
    manualRecoveryPrompted = false;
    downloadStartedAt = now();
    setStatus({ kind: 'downloading' });
    log.info(`[rally] update ${info.version} is available`);
  });
  updater.on('update-not-available', () => {
    outcome('check', 'current', checkStartedAt);
    checkStartedAt = null;
    checkInFlight = false;
    if (channelRecheckPending) {
      finishSupersededChannelWork();
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
    if (channelRecheckPending) return;
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
    updater.autoInstallOnAppQuit = true;
    setStatus({ kind: 'downloaded', version: info.version });
    log.info(`[rally] update ${info.version} downloaded`);
    void showDialog({
      type: 'info',
      message: 'Update ready',
      detail: `Rally ${info.version} has been downloaded. Restart now to finish updating?`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result?.response === 0) installUpdate();
    });
  });
  updater.on('error', (error) => {
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
    log.error('[rally] auto-update error', error);
    outcome('check', 'failed', checkStartedAt);
    checkStartedAt = null;
    setStatus({ kind: 'idle' });
    showCheckFailure();
  });

  function runCheck(manual: boolean): void {
    if (checkInFlight || status.kind === 'downloading' || status.kind === 'downloaded') return;
    manualCheck = manual;
    checkInFlight = true;
    checkStartedAt = now();
    setStatus({ kind: 'checking' });
    void updater.checkForUpdates().catch((error: unknown) => {
      checkInFlight = false;
      outcome('check', 'failed', checkStartedAt);
      checkStartedAt = null;
      if (channelRecheckPending) {
        finishSupersededChannelWork();
        return;
      }
      setStatus({ kind: 'idle' });
      log.error('[rally] update check failed', error);
      showCheckFailure();
    });
  }

  log.info(
    `[rally] auto-update initialized (current=${deps.currentVersion}, platform=${deps.platform}, `
      + `arch=${deps.arch}, channel=${deps.releaseChannel}, differentialDownload=enabled)`,
  );
  runCheck(false);
  const scheduleInterval = deps.scheduleInterval
    ?? ((callback: () => void, delayMs: number) => {
      const handle = setInterval(callback, delayMs);
      return { unref: () => handle.unref() };
    });
  const interval = scheduleInterval(() => runCheck(false), UPDATE_INTERVAL_MS);
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
      if (checkInFlight || downloadInFlight || status.kind === 'downloaded') {
        channelRecheckPending = true;
        // Prevent a previous-feed update from beginning a download after its
        // check returns, or installing on quit if it is already staged.
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        if (status.kind === 'downloaded' || downloadRetryScheduled) {
          finishSupersededChannelWork();
        }
        return;
      }
      runCheck(false);
    },
  };
}
