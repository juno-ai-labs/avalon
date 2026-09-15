import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), 'src/renderer');

/** Every non-test TypeScript source under the renderer. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function callers(pattern: RegExp): string[] {
  return sources(root)
    .map((path) => [relative(root, path).replaceAll('\\', '/'), path] as const)
    .filter(([, path]) => pattern.test(readFileSync(path, 'utf8')))
    .map(([name]) => name)
    .sort();
}

/**
 * One copy control, asserted where it can actually be broken.
 *
 * Every button that copied a value used to write to the bridge itself and keep
 * its own idea of what happened next: a sentence under the field, a label that
 * silently never changed, a check that came back after one and a half seconds
 * here and two there. `CopyButton` is the fix — an icon whose glyph, name and
 * live region say what the copy did — and `useCopy` under it is the one place
 * the outcome and its timer live. They stay the fix only while nothing goes
 * round them.
 *
 * What may still call the bridge directly is a control that is not a button
 * beside a value: a menu item, whose row is its label and whose menu closes on
 * the click, and the helper those menu items share. A new entry here is a
 * decision that a surface has such a control; a button that copies belongs in
 * the component. Tests are excluded because they stand up the bridge to assert
 * on it.
 */
describe('copy controls', () => {
  it('write to the clipboard through the hook, except from a menu item', () => {
    expect(callers(/\.copyText\(/u)).toEqual([
      // The context menu's copy-id items, and the link item beside them.
      // The message-action row's Copy: a pill among labelled pills, not an icon
      // beside a value, and the row is owned by conversation-surfaces.md.
      'components/workstream-blocks.tsx',
      // The link every menu's "Copy work-stream link" resolves through.
      'lib/copy-workstream-link.ts',
      // The hook itself.
      'lib/use-copy.ts',
      // The unopenable stream's menu item.
      'screens/conversation-surface.tsx',
      // The header menu's three copy items.
      'screens/workstream.tsx',
    ]);
  });

  it('shows the outcome through the shared state rather than a timer of its own', () => {
    // The hook holds the only reset timer; a control that sets its own back to
    // idle drifts from the rest, which is the inconsistency this replaced.
    expect(callers(/\buseCopy\b/u)).toEqual([
      'components/copy-button.tsx',
      'components/workstream-blocks.tsx',
      'lib/use-copy.ts',
    ]);
    for (const file of ['components/copy-button.tsx', 'components/workstream-blocks.tsx']) {
      expect(readFileSync(resolve(root, file), 'utf8')).not.toMatch(/setCopied|copied\s*=\s*useState/u);
    }
  });
});
