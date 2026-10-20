import { describe, expect, it, vi } from 'vitest';
import {
  ELECTRON_CONNECTION_RESET,
  ELECTRON_NETWORK_CHANGED,
  type ElectronTransientNetworkErrorCode,
  installMainProcessNetworkRecovery,
  electronTransientNetworkErrorCode,
  MainProcessNetworkRecovery,
} from './main-process-network-recovery';

function electronNetworkError(code: ElectronTransientNetworkErrorCode = 'ERR_CONNECTION_RESET'): Error {
  const error = new Error(`net::${code}`);
  error.stack = [
    `Error: net::${code}`,
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
  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('recognizes Electron URL-loader %s', (code) => {
    expect(electronTransientNetworkErrorCode(electronNetworkError(code))).toBe(code);
  });

  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('accepts Electron errors that expose %s as a code', (code) => {
    const error = electronNetworkError(code) as Error & { code: string };
    error.message = 'request failed';
    error.code = code;

    expect(electronTransientNetworkErrorCode(error)).toBe(code);
  });

  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('does not hide application errors with the %s message', (code) => {
    expect(electronTransientNetworkErrorCode(new Error(`net::${code}`))).toBe(null);
  });

  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('does not let %s message text override a contradictory code', (code) => {
    const error = electronNetworkError(code) as Error & { code: string };
    error.code = 'ERR_TIMED_OUT';

    expect(electronTransientNetworkErrorCode(error)).toBe(null);
  });

  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('requires both Electron markers on the same real frame for %s', (code) => {
    const messageOnly = electronNetworkError(code);
    messageOnly.stack = [
      'Error: SimpleURLLoaderWrapper node:electron/js2c/browser_init',
      '    at application.js:1:1',
    ].join('\n');
    const separateFrames = electronNetworkError(code);
    separateFrames.stack = [
      `Error: net::${code}`,
      '    at SimpleURLLoaderWrapper.<anonymous> (application.js:1:1)',
      '    at callback (node:electron/js2c/browser_init:2:138087)',
    ].join('\n');

    expect(electronTransientNetworkErrorCode(messageOnly)).toBe(null);
    expect(electronTransientNetworkErrorCode(separateFrames)).toBe(null);
  });

  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('does not let multiline %s text impersonate a stack frame', (code) => {
    const error = electronNetworkError(code) as Error & { code: string };
    error.code = code;
    error.message = [
      'request failed',
      '    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:138087)',
    ].join('\n');
    error.stack = `Error: ${error.message}\n    at application.js:1:1`;

    expect(electronTransientNetworkErrorCode(error)).toBe(null);
  });

  it('does not classify a different Electron network failure as this incident', () => {
    const error = electronNetworkError();
    error.message = 'net::ERR_TIMED_OUT';

    expect(electronTransientNetworkErrorCode(error)).toBe(null);
  });

  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('keeps the process alive for %s and announces recovery', (code) => {
    const { dependencies, recovery } = setup();
    const error = electronNetworkError(code);

    recovery.handleUnhandledRejection(error, dependencies);

    expect(dependencies.recovered).toHaveBeenCalledWith(error, code);
    expect(dependencies.reportFatal).not.toHaveBeenCalled();
    expect(dependencies.deferFatal).not.toHaveBeenCalled();
  });

  it('keeps unrecognized Electron network failures fatal', () => {
    const { dependencies, recovery } = setup();
    const error = electronNetworkError();
    error.message = 'net::ERR_TIMED_OUT';

    recovery.handleUnhandledRejection(error, dependencies);

    expect(dependencies.recovered).not.toHaveBeenCalled();
    expect(dependencies.reportFatal).toHaveBeenCalledWith(error, 'unhandledRejection');
    expect(dependencies.deferFatal).toHaveBeenCalledTimes(1);
    expect(() => dependencies.deferFatal.mock.calls[0]![0]()).toThrow(error);
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

  it.each([ELECTRON_CONNECTION_RESET, ELECTRON_NETWORK_CHANGED])('registers process boundaries that recover %s and deduplicate deferred fatals', (code) => {
    const dependencies = {
      recovered: vi.fn(),
      reportFatal: vi.fn(),
      deferFatal: vi.fn(),
    };
    const on = vi.fn();
    installMainProcessNetworkRecovery({ on }, dependencies);
    const monitor = on.mock.calls.find(([event]) => event === 'uncaughtExceptionMonitor')?.[1];
    const reject = on.mock.calls.find(([event]) => event === 'unhandledRejection')?.[1];
    expect(monitor).toBeTypeOf('function');
    expect(reject).toBeTypeOf('function');

    const networkError = electronNetworkError(code);
    reject!(networkError);
    expect(dependencies.recovered).toHaveBeenCalledWith(networkError, code);
    expect(dependencies.reportFatal).not.toHaveBeenCalled();
    expect(dependencies.deferFatal).not.toHaveBeenCalled();

    const programmingError = new Error('programming error');
    reject!(programmingError);
    expect(dependencies.reportFatal).toHaveBeenCalledWith(programmingError, 'unhandledRejection');
    expect(dependencies.deferFatal).toHaveBeenCalledTimes(1);
    monitor!(programmingError, 'uncaughtException');
    expect(dependencies.reportFatal).toHaveBeenCalledTimes(1);

    const directException = new Error('direct exception');
    monitor!(directException, 'uncaughtException');
    expect(dependencies.reportFatal).toHaveBeenLastCalledWith(directException, 'uncaughtException');
  });
});
