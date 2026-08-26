import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonPendingWorkstreamFeedOpen,
  abandonWorkstreamFeedOpenOutsideRoute,
  javascriptErrorCandidate,
  cancelWorkstreamFeedOpen,
  completeWorkstreamFeedPaint,
  markWorkstreamFeedCacheState,
  markWorkstreamFeedDataReady,
  markWorkstreamFeedOpenStarted,
  markWorkstreamFeedSocketLease,
  markWorkstreamNavigation,
  noteNavigation,
  reportJavascriptError,
  reportWorkstreamFeedAfterPaint,
  reportTelemetryProductIntent,
  reportTelemetryScreen,
  telemetryScreenForPath,
  telemetrySurfaceForPath,
  telemetryVisibility,
  uuidV7,
  workstreamFeedOpenCacheState,
  workstreamFeedOpenAttemptId,
  workstreamNavigation,
} from './telemetry';

const desktopBridge = vi.hoisted(() => vi.fn());
vi.mock('./platform', () => ({ desktopBridge }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  desktopBridge.mockReset();
});

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

  it('measures the first sidebar click through data readiness and a painted feed', () => {
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportTelemetryProductIntent: report });
    const workstreamId = '00000000-0000-4000-8000-000000000204';
    const socketLeaseId = '018f22f2-4c22-7abc-8def-012345678901';
    const operationId = markWorkstreamFeedOpenStarted(
      workstreamId,
      'pinned',
      'control_warmup',
      100,
      socketLeaseId,
    );
    expect(markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 110))
      .toBe(operationId);
    expect(workstreamFeedOpenAttemptId(workstreamId)).toBe(operationId);
    markWorkstreamFeedCacheState(workstreamId, 'detail_cached');
    expect(workstreamFeedOpenCacheState(workstreamId)).toBe('detail_cached');
    expect(markWorkstreamFeedDataReady(workstreamId, 320)).toBe(true);
    expect(markWorkstreamFeedDataReady(workstreamId, 340)).toBe(false);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_open_started', operationId, workstreamId, socketLeaseId,
    }));
    expect(completeWorkstreamFeedPaint(workstreamId, 'boot_payload', 'six_to_twenty', 360, socketLeaseId))
      .toEqual({
        operationId,
        intent: {
          kind: 'workstream_feed_visible',
          operationId,
          workstreamId,
          socketLeaseId,
          durationMs: 260,
          dataReadyDurationMs: 220,
          sidebarSection: 'pinned',
          cacheState: 'detail_cached',
          socketPoolState: 'control_warmup',
          feedSource: 'boot_payload',
          messageCount: 'six_to_twenty',
        },
        outcomeIntent: {
          kind: 'workstream_open_outcome',
          operationId,
          workstreamId,
          outcome: 'visible',
          durationMs: 260,
          socketLeaseId,
        },
      });
    expect(workstreamFeedOpenAttemptId(workstreamId)).toBeUndefined();
  });

  it('replaces a pending feed measurement when another sidebar row is chosen', () => {
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportTelemetryProductIntent: report });
    const first = '00000000-0000-4000-8000-000000000205';
    const second = '00000000-0000-4000-8000-000000000206';
    const firstLease = '018f22f2-4c22-7abc-8def-012345678903';
    const secondLease = '018f22f2-4c22-7abc-8def-012345678904';
    const firstAttempt = markWorkstreamFeedOpenStarted(first, 'recent', 'cold', 10, firstLease);
    const secondAttempt = markWorkstreamFeedOpenStarted(second, 'recent', 'retained_pair', 20, secondLease);
    expect(report).toHaveBeenCalledWith({
      kind: 'workstream_open_outcome',
      operationId: firstAttempt,
      workstreamId: first,
      outcome: 'superseded',
      durationMs: 10,
      socketLeaseId: firstLease,
      supersedingWorkstreamId: second,
    });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_open_started', operationId: secondAttempt, workstreamId: second,
    }));
    expect(workstreamFeedOpenAttemptId(first)).toBeUndefined();
    expect(markWorkstreamFeedDataReady(first, 30)).toBe(false);
    markWorkstreamFeedCacheState(second, 'feed_cached');
    expect(workstreamFeedOpenCacheState(second)).toBe('feed_cached');
    expect(markWorkstreamFeedDataReady(second, 30)).toBe(true);
    expect(completeWorkstreamFeedPaint(second, 'feed_cache', 'zero', 40, secondLease)?.intent)
      .toMatchObject({
        workstreamId: second,
        durationMs: 20,
        socketPoolState: 'retained_pair',
        feedSource: 'feed_cache',
      });
  });

  it('reports feed visibility only after the committed transcript crosses a paint', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportTelemetryProductIntent: report });
    const workstreamId = '00000000-0000-4000-8000-000000000207';
    markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 100);
    report.mockClear();
    markWorkstreamFeedCacheState(workstreamId, 'cold');
    markWorkstreamFeedDataReady(workstreamId, 120);

    reportWorkstreamFeedAfterPaint(workstreamId, 'boot_payload', 'one');
    expect(report).not.toHaveBeenCalled();
    frames[0]?.(130);
    expect(report).not.toHaveBeenCalled();
    frames[1]?.(140);
    await Promise.resolve();

    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_feed_visible',
      workstreamId,
      dataReadyDurationMs: 20,
    }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_open_outcome',
      workstreamId,
      outcome: 'visible',
    }));
  });

  it('assigns fresh attempt IDs across a rapid A to B to A switch', () => {
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportTelemetryProductIntent: report });
    const first = '00000000-0000-4000-8000-000000000208';
    const second = '00000000-0000-4000-8000-000000000209';
    const firstAttempt = markWorkstreamFeedOpenStarted(first, 'recent', 'cold', 10);
    const firstLease = '018f22f2-4c22-7abc-8def-012345678907';
    markWorkstreamFeedSocketLease(first, firstLease);
    const secondAttempt = markWorkstreamFeedOpenStarted(second, 'recent', 'cold', 20);
    const returnAttempt = markWorkstreamFeedOpenStarted(first, 'recent', 'retained_pair', 30);

    expect(new Set([firstAttempt, secondAttempt, returnAttempt])).toHaveLength(3);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_open_outcome',
      operationId: firstAttempt,
      outcome: 'superseded',
      socketLeaseId: firstLease,
      supersedingWorkstreamId: second,
    }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_open_outcome',
      operationId: secondAttempt,
      outcome: 'superseded',
      supersedingWorkstreamId: first,
    }));
    expect(markWorkstreamFeedDataReady(second, 35)).toBe(false);
    markWorkstreamFeedCacheState(first, 'feed_cached');
    expect(markWorkstreamFeedDataReady(first, 40)).toBe(true);
    expect(completeWorkstreamFeedPaint(first, 'feed_cache', 'one', 50)?.operationId)
      .toBe(returnAttempt);
  });

  it('abandons a pending click when its route is left and starts a fresh clock on return', () => {
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportTelemetryProductIntent: report });
    const workstreamId = '00000000-0000-4000-8000-000000000211';
    const firstAttempt = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 100);

    abandonWorkstreamFeedOpenOutsideRoute(workstreamId, 140);
    expect(workstreamFeedOpenAttemptId(workstreamId)).toBe(firstAttempt);
    abandonWorkstreamFeedOpenOutsideRoute(null, 160);

    expect(report).toHaveBeenCalledWith({
      kind: 'workstream_open_outcome',
      operationId: firstAttempt,
      workstreamId,
      outcome: 'abandoned',
      durationMs: 60,
    });
    const returnAttempt = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold', 60_100);
    expect(returnAttempt).not.toBe(firstAttempt);
    abandonPendingWorkstreamFeedOpen(60_120);
  });

  it('ends a failed opening with the same attempt and socket lease IDs', () => {
    const report = vi.fn(async () => undefined);
    desktopBridge.mockReturnValue({ reportTelemetryProductIntent: report });
    const workstreamId = '00000000-0000-4000-8000-000000000210';
    const socketLeaseId = '018f22f2-4c22-7abc-8def-012345678906';
    const operationId = markWorkstreamFeedOpenStarted(
      workstreamId,
      'pinned',
      'retained_pair',
      100,
      socketLeaseId,
    );

    cancelWorkstreamFeedOpen(workstreamId, 145, socketLeaseId);

    expect(report).toHaveBeenCalledWith({
      kind: 'workstream_open_outcome',
      operationId,
      workstreamId,
      outcome: 'load_failed',
      durationMs: 45,
      socketLeaseId,
    });
    expect(workstreamFeedOpenAttemptId(workstreamId)).toBeUndefined();
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
