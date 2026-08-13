import { describe, expect, it, vi } from 'vitest';
import {
  javascriptErrorCandidate,
  reportJavascriptError,
  reportTelemetryProductIntent,
  reportTelemetryScreen,
  telemetryScreenForPath,
  uuidV7,
} from './telemetry';

const desktopBridge = vi.hoisted(() => vi.fn());
vi.mock('./platform', () => ({ desktopBridge }));

describe('renderer semantic telemetry helpers', () => {
  it('maps only planned router destinations to stable screen enums', () => {
    expect(telemetryScreenForPath('/workstreams/new')).toBe('workspace_home');
    expect(telemetryScreenForPath('/workstreams/opaque-id')).toBe('workstream');
    expect(telemetryScreenForPath('/settings')).toBe('application_settings');
    expect(telemetryScreenForPath('/notes/private-id')).toBeNull();
    expect(telemetryScreenForPath('/unknown')).toBeNull();
  });

  it('creates time-ordered UUIDv7 operation identifiers', () => {
    const earlier = uuidV7(1_700_000_000_000);
    const later = uuidV7(1_700_000_000_001);
    expect(earlier[14]).toBe('7');
    expect(earlier < later).toBe(true);
  });

  it('reduces renderer stacks to bounded bundle-relative frame coordinates', () => {
    const error = new TypeError('private customer value');
    error.stack = `TypeError: private customer value
      at render (file:///Users/person/customer/.vite/renderer/index.js?token=secret:123:45)
      at run (app://avalon/assets/vendor.js:8:9)`;

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

  it('keeps telemetry observational when preload lookup or invocation throws synchronously', () => {
    desktopBridge.mockImplementation(() => { throw new Error('preload unavailable'); });
    expect(() => reportTelemetryScreen('workspace_home')).not.toThrow();
    expect(() => reportTelemetryProductIntent({
      kind: 'run_requested', entrypoint: 'composer',
      operationId: '018f22f2-4c22-7abc-8def-0123456789ab',
    })).not.toThrow();
    const error = new TypeError('private');
    error.stack = 'TypeError: private\n at render (app://avalon/assets/index.js:1:2)';
    expect(() => reportJavascriptError(error, 'type_error')).not.toThrow();
  });
});
