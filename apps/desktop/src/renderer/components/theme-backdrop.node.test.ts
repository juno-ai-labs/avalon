import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = join(import.meta.dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry) ? [path] : [];
  });
}

describe('where a retired theme backdrop may appear', () => {
  /** The single GrokBot design has flat surfaces in every window. Keep the old
   * backdrop frame unmounted until its remaining generated plumbing is removed. */
  it('is not mounted by any renderer surface', () => {
    const mounting = sourceFiles(renderer)
      .filter((path) => /<ThemeBackdrop\b/u.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(renderer.length + 1))
      .sort();

    expect(mounting).toEqual([]);
  });
});
