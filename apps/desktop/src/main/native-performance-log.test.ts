import { describe, expect, it, vi } from 'vitest';

import { NativePerformanceLog, nativeUnifiedLogAddonPath } from './native-performance-log';

const intent = {
  kind: 'renderer_perf_flow',
  operationId: '018f22f2-4c22-7abc-8def-0123456789ab',
  flow: 'workstream_open',
  workstreamId: '00000000-0000-4000-8000-000000000201',
  outcome: 'snapshot',
  durationMs: 814.2,
  blockedMs: 10.1,
  longTaskCount: 'one',
  socketTicketMs: 212.4,
  dialMs: 2.1,
  handshakeMs: 480.2,
  firstFrameMs: 119.5,
} as const;

describe('native performance log', () => {
  it('writes the governed performance event as public structured Unified Log data', () => {
    const writePerformance = vi.fn();
    const unavailable = vi.fn();
    const subject = new NativePerformanceLog(
      () => ({ writePerformance }),
      () => '1.172.0',
      () => new Date('2026-08-26T20:00:00.000Z'),
      unavailable,
    );

    subject.write(intent);

    expect(writePerformance).toHaveBeenCalledOnce();
    expect(JSON.parse(writePerformance.mock.calls[0]![0])).toEqual({
      timestamp: '2026-08-26T20:00:00.000Z',
      appVersion: '1.172.0',
      ...intent,
    });
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('reports an unavailable native bridge once without changing later operations', () => {
    const failure = new Error('missing addon');
    const load = vi.fn(() => { throw failure; });
    const unavailable = vi.fn();
    const subject = new NativePerformanceLog(load, () => '1.172.0', () => new Date(), unavailable);

    subject.write(intent);
    subject.write(intent);

    expect(load).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledWith(failure);
  });

  it('resolves packaged and development addon paths without user input', () => {
    expect(nativeUnifiedLogAddonPath({
      currentDirectory: '/repo/apps/desktop/out/main',
      isPackaged: false,
      resourcesPath: '/Applications/Rally.app/Contents/Resources',
    })).toBe('/repo/apps/desktop/.native-build/unified-log.node');
    expect(nativeUnifiedLogAddonPath({
      currentDirectory: '/ignored',
      isPackaged: true,
      resourcesPath: '/Applications/Rally.app/Contents/Resources',
    })).toBe('/Applications/Rally.app/Contents/Resources/native/unified-log.node');
  });
});
