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

describe('where a theme backdrop is allowed to appear', () => {
  /**
   * The main window and nowhere else.
   *
   * The standalone Settings and meeting windows return their own surfaces from
   * `App` before `AppShell` is reached, so they never mounted this — but by
   * omission rather than by decision, which is a different thing and reads the
   * same in a diff. Both are dense forms and keep a flat `surface-default`
   * ground; on Air that does mean the two windows look different side by side.
   *
   * This is the counterpart to the stylesheet's "painted once" guard, which
   * checks that no *second* surface paints a backdrop. Nothing checked which
   * surfaces mount the frame, so a third one gaining or losing one would have
   * been invisible in review. Changing this list is changing the decision.
   */
  it('is mounted by the application shell alone', () => {
    const mounting = sourceFiles(renderer)
      .filter((path) => /<ThemeBackdrop\b/u.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(renderer.length + 1))
      .sort();

    expect(mounting).toEqual(['components/app-shell.tsx']);
  });
});
