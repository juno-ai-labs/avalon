import { describe, expect, it, vi } from 'vitest';
import {
  ELECTRON_CONNECTION_RESET,
  isElectronConnectionReset,
  recoverMainProcessNetworkRejection,
} from './main-process-network-recovery';

function electronReset(): Error {
  const error = new Error('net::ERR_CONNECTION_RESET');
  error.stack = [
    'Error: net::ERR_CONNECTION_RESET',
    '    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:138087)',
    '    at SimpleURLLoaderWrapper.emit (node:events:509:28)',
  ].join('\n');
  return error;
}

describe('main-process network recovery', () => {
  it('recognizes Electron URL-loader connection resets', () => {
    expect(isElectronConnectionReset(electronReset())).toBe(true);
  });

  it('accepts Electron errors that expose the reset as a code', () => {
    const error = electronReset() as Error & { code: string };
    error.message = 'request failed';
    error.code = ELECTRON_CONNECTION_RESET;

    expect(isElectronConnectionReset(error)).toBe(true);
  });

  it('does not hide application errors that happen to use the same message', () => {
    expect(isElectronConnectionReset(new Error('net::ERR_CONNECTION_RESET'))).toBe(false);
  });

  it('does not classify a different Electron network failure as this incident', () => {
    const error = electronReset();
    error.message = 'net::ERR_TIMED_OUT';

    expect(isElectronConnectionReset(error)).toBe(false);
  });

  it('keeps the process alive for the recognized reset and announces recovery', () => {
    const recovered = vi.fn();
    const error = electronReset();

    recoverMainProcessNetworkRejection(error, recovered);

    expect(recovered).toHaveBeenCalledWith(error, ELECTRON_CONNECTION_RESET);
  });

  it('rethrows every unrecognized rejection unchanged', () => {
    const recovered = vi.fn();
    const programmingError = new TypeError('broken invariant');

    expect(() => recoverMainProcessNetworkRejection(programmingError, recovered)).toThrow(programmingError);
    expect(recovered).not.toHaveBeenCalled();
  });
});
