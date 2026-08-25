import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  javascriptErrorCandidate,
  markWorkstreamNavigation,
  noteNavigation,
  reportJavascriptError,
  reportTelemetryProductIntent,
  reportTelemetryScreen,
  telemetryScreenForPath,
  telemetrySurfaceForPath,
  telemetryVisibility,
  uuidV7,
  workstreamNavigation,
} from './telemetry';

const desktopBridge = vi.hoisted(() => vi.fn());
vi.mock('./platform', () => ({ desktopBridge }));

afterEach(() => vi.useRealTimers());

describe('renderer semantic telemetry helpers', () => {
  it('maps only planned router destinations to stable screen enums', () => {
    expect(telemetryScreenForPath('/')).toBeNull();
    expect(telemetryScreenForPath('/workstreams/new')).toBe('workspace_home');
    expect(telemetryScreenForPath('/workstreams/opaque-id')).toBe('workstream');
    expect(telemetryScreenForPath('/settings')).toBe('application_settings');
    expect(telemetryScreenForPath('/notes/private-id')).toBeNull();
    expect(telemetryScreenForPath('/unknown')).toBeNull();
    expect(telemetrySurfaceForPath('/')).toBeNull();
    expect(telemetrySurfaceForPath('/workstreams/new')).toEqual({ surface: 'workspace_home' });
  });

  it('creates time-ordered UUIDv7 operation identifiers', () => {
    const earlier = uuidV7(1_700_000_000_000);
    const later = uuidV7(1_700_000_000_001);
    expect(earlier[14]).toBe('7');
    expect(earlier < later).toBe(true);
  });

  it('classifies first opens, switches, and later resource reopens without titles or routes', () => {
    const firstWorkstream = '00000000-0000-4000-8000-000000000201';
    const switchedWorkstream = '00000000-0000-4000-8000-000000000202';
    const noteId = '00000000-0000-4000-8000-000000000203';
    markWorkstreamNavigation(firstWorkstream, false);
    expect(workstreamNavigation(firstWorkstream)).toBe('opened');
    expect(workstreamNavigation(firstWorkstream)).toBe('reopened');
    markWorkstreamNavigation(switchedWorkstream, true);
    expect(workstreamNavigation(switchedWorkstream)).toBe('switched');
    expect(noteNavigation(noteId)).toBe('opened');
    expect(noteNavigation(noteId)).toBe('reopened');
    expect(telemetryVisibility('personal')).toBe('private');
    expect(telemetryVisibility('workspace')).toBe('public');
  });

  it('reduces renderer stacks to bounded bundle-relative frame coordinates', () => {
    const error = new TypeError('private customer value');
    error.stack = `TypeError: private customer value
      at render (file:///Users/person/customer/.vite/renderer/index.js?token=secret:123:45)
      at run (app://rallywithai/assets/vendor.js:8:9)`;

    expect(javascriptErrorCandidate(error, 'react_boundary')).toEqual({
      process: 'renderer',
      errorCode: 'react_boundary',
      frames: ['index.js:123:45', 'vendor.js:8:9'],
    });
  });

  it('does not report a detailed candidate without a packaged JavaScript frame', () => {
    const error = new Error('private customer value');
    error.stack = 'Error: private customer value\n at render (/Users/person/customer/App.tsx:1:2)';
    expect(javascriptErrorCandidate(error, 'unknown')).toBeNull();
  });

  it('suppresses a duplicate network classification but allows a later crash classification', () => {
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportJavascriptError: report });
    const error = new Error('private transport detail');
    error.stack = 'Error: private transport detail\n at send (app://rallywithai/assets/index.js:10:2)';

    reportJavascriptError(error, 'network_error');
    reportJavascriptError(error, 'network_error');
    expect(report).toHaveBeenCalledOnce();

    reportJavascriptError(error, 'unhandled_rejection');

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, {
      process: 'renderer',
      errorCode: 'network_error',
      frames: ['index.js:10:2'],
    });
    expect(report).toHaveBeenNthCalledWith(2, {
      process: 'renderer',
      errorCode: 'unhandled_rejection',
      frames: ['index.js:10:2'],
    });
  });

  it('coalesces repeated network failures with the same sanitized fingerprint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T20:00:00.000Z'));
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportJavascriptError: report });
    const errorAtSameFrame = (): Error => {
      const error = new Error('private transport detail');
      error.stack = 'Error: private transport detail\n at send (app://rallywithai/assets/throttle.js:20:2)';
      return error;
    };

    reportJavascriptError(errorAtSameFrame(), 'network_error');
    reportJavascriptError(errorAtSameFrame(), 'network_error');
    expect(report).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5 * 60 * 1_000);
    reportJavascriptError(errorAtSameFrame(), 'network_error');
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('does not let a coalesced network report suppress a later crash classification', () => {
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportJavascriptError: report });
    const errorAtSameFrame = (): Error => {
      const error = new Error('private transport detail');
      error.stack = 'Error: private transport detail\n at send (app://rallywithai/assets/upgrade.js:20:2)';
      return error;
    };
    const laterCrash = errorAtSameFrame();

    reportJavascriptError(errorAtSameFrame(), 'network_error');
    reportJavascriptError(laterCrash, 'network_error');
    expect(report).toHaveBeenCalledOnce();

    reportJavascriptError(laterCrash, 'unhandled_rejection');

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith({
      process: 'renderer',
      errorCode: 'unhandled_rejection',
      frames: ['upgrade.js:20:2'],
    });
  });

  it('keeps telemetry observational when preload lookup or invocation throws synchronously', () => {
    desktopBridge.mockImplementation(() => { throw new Error('preload unavailable'); });
    expect(() => reportTelemetryScreen('workspace_home')).not.toThrow();
    expect(() => reportTelemetryProductIntent({
      kind: 'run_requested', entrypoint: 'composer',
      operationId: '018f22f2-4c22-7abc-8def-0123456789ab',
    })).not.toThrow();
    const error = new TypeError('private');
    error.stack = 'TypeError: private\n at render (app://rallywithai/assets/index.js:1:2)';
    expect(() => reportJavascriptError(error, 'type_error')).not.toThrow();
  });
});
