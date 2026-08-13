import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Electron telemetry wiring', () => {
  it('reports preload startup failure through bounded process and exception signals', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const handler = source.match(
      /window\.webContents\.on\('preload-error',[\s\S]*?\n {2}\}\);/u,
    )?.[0];

    expect(handler).toBeDefined();
    expect(handler).toContain("processHealth('preload', 'exception', 'launch_failure')");
    expect(handler).toContain("process: 'preload'");
    expect(handler).not.toContain('preloadPath');
  });
});
