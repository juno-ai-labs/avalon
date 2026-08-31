import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('renderer content security policy', () => {
  it('admits only same-origin and in-memory media in both development and runtime policies', () => {
    const runtimeSource = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const html = readFileSync(`${process.cwd()}/src/renderer/index.html`, 'utf8');

    for (const policySource of [runtimeSource, html]) {
      expect(policySource).toContain("media-src 'self' blob:");
      expect(policySource).not.toMatch(/media-src[^;]*https:/u);
      expect(policySource).not.toMatch(/media-src[^;]*data:/u);
    }
  });
});
