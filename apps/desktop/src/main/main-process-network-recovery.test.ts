import { describe, expect, it, vi } from 'vitest';
import {
  type ElectronNetworkErrorCode,
  installMainProcessNetworkRecovery,
  electronNetworkErrorCode,
  MainProcessNetworkRecovery,
} from './main-process-network-recovery';

const networkCodes = [
  'ERR_CONNECTION_RESET', 'ERR_NETWORK_CHANGED', 'ERR_NETWORK_IO_SUSPENDED',
  'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_CLOSED', 'ERR_NAME_NOT_RESOLVED',
  'ERR_PROXY_CONNECTION_FAILED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_TIMED_OUT',
  'ERR_ABORTED', 'ERR_FUTURE_TRANSPORT_FAILURE',
] as const;

function electronNetworkError(code: ElectronNetworkErrorCode = 'ERR_CONNECTION_RESET'): Error {
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
  it.each(networkCodes)('recognizes Electron URL-loader %s', (code) => {
    expect(electronNetworkErrorCode(electronNetworkError(code))).toBe(code);
  });

  it.each(networkCodes)('accepts Electron errors that expose %s as a code', (code) => {
    const error = electronNetworkError(code) as Error & { code: string };
    error.message = 'request failed';
    error.code = code;

    expect(electronNetworkErrorCode(error)).toBe(code);
  });

  it('does not hide application errors with a Chromium network message', () => {
    expect(electronNetworkErrorCode(new Error('net::ERR_NETWORK_CHANGED'))).toBe(null);
  });

  it('does not let message text override a contradictory code', () => {
    const error = electronNetworkError('ERR_NETWORK_CHANGED') as Error & { code: string };
    error.code = 'APPLICATION_FAILURE';

    expect(electronNetworkErrorCode(error)).toBe(null);
  });

  it('rejects disagreement between two Chromium network codes', () => {
    const error = electronNetworkError('ERR_NETWORK_CHANGED') as Error & { code: string };
    error.code = 'ERR_TIMED_OUT';
    expect(electronNetworkErrorCode(error)).toBe(null);
  });

  it('requires both Electron markers on the same real frame', () => {
    const code = 'ERR_NETWORK_CHANGED';
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

    expect(electronNetworkErrorCode(messageOnly)).toBe(null);
    expect(electronNetworkErrorCode(separateFrames)).toBe(null);
  });

  it('does not let multiline error text impersonate a stack frame', () => {
    const error = electronNetworkError('ERR_NETWORK_CHANGED') as Error & { code: string };
    error.code = 'ERR_NETWORK_CHANGED';
    error.message = [
      'request failed',
      '    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:138087)',
    ].join('\n');
    error.stack = `Error: ${error.message}\n    at application.js:1:1`;

    expect(electronNetworkErrorCode(error)).toBe(null);
  });

  it.each(['request failed', 'ERR_TIMED_OUT', 'net::OTHER_ERROR', 'net::ERR_'])('rejects an unrecognized loader message: %s', (message) => {
    const error = electronNetworkError();
    error.message = message;
    expect(electronNetworkErrorCode(error)).toBe(null);
  });

  it.each(networkCodes)('keeps the process alive for %s and announces recovery', (code) => {
    const { dependencies, recovery } = setup();
    const error = electronNetworkError(code);

    recovery.handleUnhandledRejection(error, dependencies);

    expect(dependencies.recovered).toHaveBeenCalledWith(error, code);
    expect(dependencies.reportFatal).not.toHaveBeenCalled();
    expect(dependencies.deferFatal).not.toHaveBeenCalled();
  });

  it('keeps non-network loader failures fatal', () => {
    const { dependencies, recovery } = setup();
    const error = electronNetworkError();
    error.message = 'Unexpected loader state';

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

  it('registers process boundaries that recover network errors and deduplicate deferred fatals', () => {
    const code = 'ERR_NETWORK_CHANGED';
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
