import { describe, expect, it } from 'vitest';
import { mobileCrashSummary } from '../src/telemetry/mobile-crash';

describe('mobile crash external projection', () => {
  it('keeps Hermes numeric locations and OTA identity, excluding exception messages and URLs', () => {
    expect(mobileCrashSummary({ kind: 'hermes', fatal: true,
      updateId: '018f22f2-4c22-7abc-8def-0123456789ad',
      report: 'Error: private conversation\n    at send (address at index.bundle:1:2195)\n    at render (https://private.example/bundle?token=secret:2:831)',
    })).toEqual({
      crash_type: 'javascript_fatal', mechanism: 'hermes', handled: false,
      threads: [{ crashed: true, frames: [
        { module: '018f22f2-4c22-7abc-8def-0123456789ad', function: 'hermes_1_2195' },
        { module: '018f22f2-4c22-7abc-8def-0123456789ad', function: 'hermes_2_831' },
      ] }],
    });
  });
  it('rejects arbitrary module names and signals instead of exporting sanitized customer text', () => {
    expect(() => mobileCrashSummary({ kind: 'ios-native', report: '', signal: 'PrivateMessage', threads: [] })).toThrow();
    expect(() => mobileCrashSummary({ kind: 'ios-native', report: '', signal: 'SIGABRT', threads: [{ crashed: true,
      frames: [{ imageUUID: 'private-image-name', offset: '1' }] }] })).toThrow();
  });
});

it('does not project numeric coordinates from exception messages or continuation text', () => {
  expect(mobileCrashSummary({ kind: 'hermes', fatal: false, updateId: null,
    report: 'Error: private record 12345:67890\nprivate continuation 987:654\n    at send (address at index.bundle:1:42)',
  })).toMatchObject({ threads: [{ frames: [{ module: 'embedded', function: 'hermes_1_42' }] }] });
});
it('bounds mobile projections before constructing external summaries', () => {
  const summary = mobileCrashSummary({ kind: 'hermes', fatal: true, updateId: null,
    report: Array.from({ length: 1000 }, (_, i) => `    at send (address at index.bundle:1:${i})`).join('\n'),
  });
  expect(summary.threads[0]!.frames).toHaveLength(256);
  expect(summary.threads[0]!.frames.at(-1)).toEqual({ module: 'embedded', function: 'hermes_1_255' });
});
it('bounds native projection arrays during schema parsing as well as normalization', () => {
  const summary = mobileCrashSummary({ kind: 'ios-native', report: 'Raw private report', signal: 'SIGABRT',
    threads: Array.from({ length: 100 }, () => ({ crashed: true,
      frames: Array.from({ length: 300 }, () => ({ imageUUID: 'AAAA-BBBB', offset: '1A' })),
    })),
  });
  expect(summary.threads).toHaveLength(64);
  expect(summary.threads[0]!.frames).toHaveLength(256);
  expect(summary.threads[0]!.frames[0]).toEqual({ module: 'aaaa-bbbb', function: 'offset_1a' });
});
