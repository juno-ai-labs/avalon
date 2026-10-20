export const ELECTRON_CONNECTION_RESET = 'ERR_CONNECTION_RESET' as const;
export const ELECTRON_NETWORK_CHANGED = 'ERR_NETWORK_CHANGED' as const;

export type ElectronTransientNetworkErrorCode =
  | typeof ELECTRON_CONNECTION_RESET
  | typeof ELECTRON_NETWORK_CHANGED;

export type MainProcessFatalOrigin = 'uncaughtException' | 'unhandledRejection';

export interface MainProcessNetworkRecoveryDependencies {
  readonly recovered: (error: Error, code: ElectronTransientNetworkErrorCode) => void;
  readonly reportFatal: (error: Error, origin: MainProcessFatalOrigin) => void;
  readonly deferFatal: (fatal: () => never) => void;
}

interface MainProcessExceptionEvents {
  on(
    event: 'uncaughtExceptionMonitor',
    listener: (error: Error, origin: MainProcessFatalOrigin) => void,
  ): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

function errorCode(error: Error): ElectronTransientNetworkErrorCode | null {
  const code = 'code' in error
    ? error.code
    : error.message.startsWith('net::') ? error.message.slice('net::'.length) : null;
  return code === ELECTRON_CONNECTION_RESET || code === ELECTRON_NETWORK_CHANGED ? code : null;
}

/**
 * Identify a connection reset or network change from Chromium's URL loader
 * whose rejected promise reached the main-process boundary.
 *
 * The loader frame matters as much as the code. Application code can throw an
 * error with the same text, and swallowing that would turn a programming error
 * into a silent partial operation. Both markers must occur on an actual stack
 * frame rather than in the error message. This signature was observed with
 * Electron 43.2.0 and must be re-verified when Electron's js2c layout changes.
 */
export function electronTransientNetworkErrorCode(error: unknown): ElectronTransientNetworkErrorCode | null {
  if (!(error instanceof Error)) return null;
  const code = errorCode(error);
  if (code === null) return null;
  // V8 copies newlines from the rendered name and message into `stack` before
  // its real frames. Refuse those shapes so text cannot inject an `at ...`
  // line that impersonates Electron's loader frame.
  if (/[\r\n\u2028\u2029]/u.test(error.name) || /[\r\n\u2028\u2029]/u.test(error.message)) return null;
  const hasLoaderFrame = (error.stack ?? '').split('\n').slice(1).some((line) => (
    /^\s*at\s/u.test(line)
      && line.includes('SimpleURLLoaderWrapper')
      && line.includes('node:electron/js2c/browser_init')
  ));
  return hasLoaderFrame ? code : null;
}

function normalizedRejection(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Unhandled promise rejection');
  // Node's own wrapper for a non-Error rejection contributes no application
  // frame. Keep the same telemetry shape rather than attributing the failure to
  // this normalization boundary.
  error.stack = undefined;
  return error;
}

/**
 * Owns the recoverable Electron network rejections in Rally's main process.
 *
 * Unknown rejections are reported with their original origin before a fatal
 * throw is deferred to the next event-loop turn. Deferral lets Node finish
 * delivering sibling rejections from the same microtask batch; the marker lets
 * the ordinary fatal monitor avoid reporting that scheduled throw a second
 * time as an exception.
 */
export class MainProcessNetworkRecovery {
  private readonly deferredFatals = new WeakSet<Error>();

  handleUnhandledRejection(
    reason: unknown,
    dependencies: MainProcessNetworkRecoveryDependencies,
  ): void {
    const error = normalizedRejection(reason);
    const code = electronTransientNetworkErrorCode(error);
    if (code !== null) {
      dependencies.recovered(error, code);
      return;
    }

    dependencies.reportFatal(error, 'unhandledRejection');
    this.deferredFatals.add(error);
    dependencies.deferFatal(() => { throw error; });
  }

  /** Consume the fatal throw that was already reported as a rejection. */
  consumeDeferredFatal(error: Error): boolean {
    if (!this.deferredFatals.has(error)) return false;
    this.deferredFatals.delete(error);
    return true;
  }
}

/** Register the paired rejection and fatal-monitor boundaries exactly once. */
export function installMainProcessNetworkRecovery(
  events: MainProcessExceptionEvents,
  dependencies: MainProcessNetworkRecoveryDependencies,
): void {
  const recovery = new MainProcessNetworkRecovery();
  events.on('uncaughtExceptionMonitor', (error, origin) => {
    if (recovery.consumeDeferredFatal(error)) return;
    dependencies.reportFatal(error, origin);
  });
  events.on('unhandledRejection', (reason) => {
    recovery.handleUnhandledRejection(reason, dependencies);
  });
}
