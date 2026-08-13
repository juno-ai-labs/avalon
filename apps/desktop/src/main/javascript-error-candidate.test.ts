import { describe, expect, it } from 'vitest';
import { javascriptErrorProcessHealthState, normalizeJavascriptErrorCandidate } from './javascript-error-candidate';

describe('JavaScript error candidate normalization', () => {
  it.each(['react_boundary', 'network_error'] as const)(
    'accepts bounded bundle-relative frames for %s',
    async (errorCode) => {
      await expect(normalizeJavascriptErrorCandidate({
        process: 'renderer', errorCode,
        frames: ['index-CX8Z.js:120:4', 'vendor.js:88:2'],
      })).resolves.toEqual({
        process: 'renderer', errorCode,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        generatedFrames: ['index-CX8Z.js:120:4', 'vendor.js:88:2'],
      });
    },
  );

  it.each([
    { process: 'renderer', errorCode: 'unknown', frames: ['/Users/ada/private.js:1:2'] },
    { process: 'renderer', errorCode: 'unknown', frames: ['../private.js:1:2'] },
    { process: 'renderer', errorCode: 'unknown', frames: ['bundle.js?token=secret:1:2'] },
    { process: 'renderer', errorCode: 'unknown', frames: [], message: 'secret' },
  ])('rejects paths, query data, empty stacks, and arbitrary fields', async (candidate) => {
    await expect(normalizeJavascriptErrorCandidate(candidate)).rejects.toThrow('Invalid JavaScript error candidate');
  });

  it('does not classify a handled network failure as process-health degradation', () => {
    expect(javascriptErrorProcessHealthState('network_error')).toBeNull();
    expect(javascriptErrorProcessHealthState('unhandled_rejection')).toBe('rejection');
    expect(javascriptErrorProcessHealthState('type_error')).toBe('exception');
  });
});
