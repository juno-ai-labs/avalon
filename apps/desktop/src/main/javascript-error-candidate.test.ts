import { describe, expect, it } from 'vitest';
import { normalizeJavascriptErrorCandidate } from './javascript-error-candidate';

describe('JavaScript error candidate normalization', () => {
  it('accepts only bounded bundle-relative frames and returns a stable content-free fingerprint', async () => {
    await expect(normalizeJavascriptErrorCandidate({
      process: 'renderer', errorCode: 'react_boundary',
      frames: ['index-CX8Z.js:120:4', 'vendor.js:88:2'],
    })).resolves.toEqual({
      process: 'renderer', errorCode: 'react_boundary',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      generatedFrames: ['index-CX8Z.js:120:4', 'vendor.js:88:2'],
    });
  });

  it.each([
    { process: 'renderer', errorCode: 'unknown', frames: ['/Users/ada/private.js:1:2'] },
    { process: 'renderer', errorCode: 'unknown', frames: ['../private.js:1:2'] },
    { process: 'renderer', errorCode: 'unknown', frames: ['bundle.js?token=secret:1:2'] },
    { process: 'renderer', errorCode: 'unknown', frames: [], message: 'secret' },
  ])('rejects paths, query data, empty stacks, and arbitrary fields', async (candidate) => {
    await expect(normalizeJavascriptErrorCandidate(candidate)).rejects.toThrow('Invalid JavaScript error candidate');
  });
});
