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
  // Matching the quoted module name rather than `from '…'` covers a dynamic
  // `import()` and a `require()` as well as a static import — the same reason
  // the stylesheet guard reads selectors instead of searching for one spelling
  // of a rule. The cost is that this file's own mention of the names would count
  // as a use, so it excludes itself by path.
  const specifier = /['"](react-markdown|remark-gfm)['"]/u;
  const self = 'renderer/components/markdown-renderer.node.test.ts';

  it('is mounted in exactly one place', () => {
    const importers = sources(root)
      .map((path) => [relative(root, path).replaceAll('\\', '/'), path] as const)
      .filter(([name]) => name !== self)
      .filter(([, path]) => specifier.test(readFileSync(path, 'utf8')))
      .map(([name]) => name);

    expect(importers).toEqual(['renderer/components/workstream-blocks.tsx']);
  });
});
