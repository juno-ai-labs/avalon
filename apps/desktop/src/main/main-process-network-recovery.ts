export const ELECTRON_CONNECTION_RESET = 'ERR_CONNECTION_RESET' as const;

function errorCode(error: Error): string | null {
  if ('code' in error && error.code === ELECTRON_CONNECTION_RESET) return ELECTRON_CONNECTION_RESET;
  return error.message === `net::${ELECTRON_CONNECTION_RESET}` ? ELECTRON_CONNECTION_RESET : null;
}

/**
 * Whether Chromium's URL loader lost an established connection and allowed its
 * rejected promise to reach the main-process boundary.
 *
 * The loader frame matters as much as the code. Application code can throw an
 * error with the same text, and swallowing that would turn a programming error
 * into a silent partial operation. This recognizes the exact failure Electron
 * emits when a Mac changes network state during sleep or wake.
 */
export function isElectronConnectionReset(error: unknown): error is Error {
  if (!(error instanceof Error) || errorCode(error) === null) return false;
  const stack = error.stack ?? '';
  return stack.includes('SimpleURLLoaderWrapper')
    && stack.includes('node:electron/js2c/browser_init');
}

/**
 * Owns the only recoverable unhandled rejection in Rally's main process.
 *
 * Returning from Node's `unhandledRejection` callback keeps Electron alive,
 * which lets the network owners that issued background work use their normal
 * reconnect or retry paths. Everything else is rethrown: this is not a blanket
 * exception shield, and real main-process defects must remain fatal and visible.
 */
export function recoverMainProcessNetworkRejection(
  reason: unknown,
  recovered: (error: Error, code: typeof ELECTRON_CONNECTION_RESET) => void,
): void {
  if (!isElectronConnectionReset(reason)) throw reason;
  recovered(reason, ELECTRON_CONNECTION_RESET);
}
