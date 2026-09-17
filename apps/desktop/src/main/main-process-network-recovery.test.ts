import { describe, expect, it, vi } from 'vitest';
import {
  ELECTRON_CONNECTION_RESET,
  isElectronConnectionReset,
  MainProcessNetworkRecovery,
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

function setup() {
  const recovery = new MainProcessNetworkRecovery();
  const dependencies = {
    recovered: vi.fn(),
    reportFatal: vi.fn(),
    deferFatal: vi.fn(),
  };
  return { dependencies, recovery };
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

  it('does not let message text override a contradictory error code', () => {
    const error = electronReset() as Error & { code: string };
    error.code = 'ERR_TIMED_OUT';

    expect(isElectronConnectionReset(error)).toBe(false);
  });

  it('requires both Electron markers on the same real stack frame', () => {
    const messageOnly = electronReset();
    messageOnly.stack = [
      'Error: SimpleURLLoaderWrapper node:electron/js2c/browser_init',
      '    at application.js:1:1',
    ].join('\n');
    const separateFrames = electronReset();
    separateFrames.stack = [
      'Error: net::ERR_CONNECTION_RESET',
      '    at SimpleURLLoaderWrapper.<anonymous> (application.js:1:1)',
      '    at callback (node:electron/js2c/browser_init:2:138087)',
    ].join('\n');

    expect(isElectronConnectionReset(messageOnly)).toBe(false);
    expect(isElectronConnectionReset(separateFrames)).toBe(false);
  });

  it('does not classify a different Electron network failure as this incident', () => {
    const error = electronReset();
    error.message = 'net::ERR_TIMED_OUT';

    expect(isElectronConnectionReset(error)).toBe(false);
  });

  it('keeps the process alive for the recognized reset and announces recovery', () => {
    const { dependencies, recovery } = setup();
    const error = electronReset();

    recovery.handleUnhandledRejection(error, dependencies);

    expect(dependencies.recovered).toHaveBeenCalledWith(error, ELECTRON_CONNECTION_RESET);
    expect(dependencies.reportFatal).not.toHaveBeenCalled();
    expect(dependencies.deferFatal).not.toHaveBeenCalled();
  });

  it('reports unknown rejections with their original origin before deferring the exact error', () => {
    const { dependencies, recovery } = setup();
    const programmingError = new TypeError('broken invariant');

    recovery.handleUnhandledRejection(programmingError, dependencies);

    expect(dependencies.reportFatal).toHaveBeenCalledWith(programmingError, 'unhandledRejection');
    const fatal = dependencies.deferFatal.mock.calls[0]?.[0];
    expect(fatal).toBeDefined();
    try {
      fatal!();
      expect.unreachable('the deferred fatal must throw');
    } catch (error) {
      expect(error).toBe(programmingError);
    }
    expect(recovery.consumeDeferredFatal(programmingError)).toBe(true);
    expect(recovery.consumeDeferredFatal(programmingError)).toBe(false);
  });

  it('normalizes non-Error reasons without inventing an application frame', () => {
    const { dependencies, recovery } = setup();

    recovery.handleUnhandledRejection(undefined, dependencies);

    const [error, origin] = dependencies.reportFatal.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeUndefined();
    expect(origin).toBe('unhandledRejection');
  });

  it('reports every sibling rejection before either deferred fatal runs', () => {
    const { dependencies, recovery } = setup();
    const first = new Error('first');
    const second = new Error('second');

    recovery.handleUnhandledRejection(first, dependencies);
    recovery.handleUnhandledRejection(second, dependencies);

    expect(dependencies.reportFatal.mock.calls).toEqual([
      [first, 'unhandledRejection'],
      [second, 'unhandledRejection'],
    ]);
    expect(dependencies.deferFatal).toHaveBeenCalledTimes(2);
  });
});
