import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), 'src');

/** Every TypeScript source under `src`, tests included. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/**
 * One renderer, asserted where it can actually be broken.
 *
 * The stylesheet test next door guards the other half of this: that no surface
 * grows its own copy of the markdown element styling. It cannot see the failure
 * that made that copying necessary in the first place — a screen importing
 * `react-markdown` and mounting it under a class of its own. Three screens did,
 * the three copies drifted, and for a while two of them silently rendered
 * bulleted lists as indented paragraphs because Tailwind's preflight had removed
 * the markers and only one of the three took them back.
 *
 * `MarkdownBody` is the fix, and it only stays the fix while it is the only
 * caller. A fourth surface that wants markdown should render it, and change it
 * if it does not fit — not start a second renderer whose divergence nobody will
 * notice until a rule written for the first one fails to reach it.
 */
describe('markdown renderer', () => {
  it('is mounted in exactly one place', () => {
    const importers = sources(root)
      .filter((path) => /from '(react-markdown|remark-gfm)'/u.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path).replaceAll('\\', '/'));

    expect(importers).toEqual(['renderer/components/workstream-blocks.tsx']);
  });
});
