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
