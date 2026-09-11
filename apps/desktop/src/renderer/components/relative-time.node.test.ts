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

function importers(pattern: RegExp, self: string): string[] {
  return sources(root)
    .map((path) => [relative(root, path).replaceAll('\\', '/'), path] as const)
    .filter(([name]) => name !== self)
    .filter(([, path]) => pattern.test(readFileSync(path, 'utf8')))
    .map(([name]) => name)
    .sort();
}

/**
 * One relative label, asserted where it can actually be broken.
 *
 * `formatRelative` returns a string, and a string is a photograph: "7 minutes
 * ago" is right for the minute it was painted and quietly wrong for as long as
 * the screen stays open. Nine surfaces called it directly, so a work stream left
 * open over lunch showed a feed, a sidebar and an inspector all still claiming
 * the last message arrived seven minutes ago. `RelativeTime` is the fix — it
 * subscribes to the shared clock and re-renders itself — and it only stays the
 * fix while it is the only caller. A tenth surface that wants a relative label
 * should render it, and widen its `format` prop if the vocabulary does not fit,
 * rather than take the string and freeze it.
 *
 * The component's tests are what prove the label moves; this proves nothing has
 * gone round it. Matching the quoted name covers a dynamic import as well as a
 * static one, so this file excludes itself by path.
 */
describe('relative time', () => {
  it('is formatted in exactly one component', () => {
    expect(importers(/\bformatRelative\b/u, 'renderer/components/relative-time.node.test.ts'))
      .toEqual(['renderer/components/relative-time.tsx', 'renderer/lib/format.ts']);
  });

  /**
   * The guard above names `formatRelative` and nothing else, which is exactly
   * how the sidebar's own vocabulary slipped past it: `formatSidebarActivityTime`
   * produces the same kind of label — "Yesterday", a weekday, a clock time — and
   * two of its call sites survived the sweep because the grep that found the
   * others did not know the name. The visible row froze at `11:58 PM` while the
   * hover preview over it, which had been converted, read `Yesterday`. A
   * vocabulary is a `format` prop, so the module that defines one may name it and
   * the component that renders one may take it; anybody else calling it is
   * painting a label that will not move.
   */
  it('renders the sidebar vocabulary through the component too, not beside it', () => {
    expect(importers(/\bformatSidebarActivityTime\b/u, 'renderer/components/relative-time.node.test.ts'))
      .toEqual(['renderer/components/sidebar.tsx']);
    const sidebar = readFileSync(resolve(root, 'renderer/components/sidebar.tsx'), 'utf8');
    // Defined once, and passed rather than called: a bare call outside the
    // definition is the shape this is here to keep out.
    expect(sidebar.match(/formatSidebarActivityTime\(/gu)).toHaveLength(1);
    expect(sidebar).toContain('function formatSidebarActivityTime(');
  });

  /**
   * One interval for the whole window, not one per label. A feed with fifty
   * turns, both sidebars and an open inspector would otherwise arm fifty-odd
   * timers that all do the same thing, and each would drift into its own second.
   * `useNow` is the subscription; a component reaching for `setInterval` to keep
   * a label current is the defect this exists to keep out.
   */
  it('drives every label from the one shared clock', () => {
    expect(importers(/\buseNow\b/u, 'renderer/components/relative-time.node.test.ts'))
      .toEqual(['renderer/components/relative-time.tsx', 'renderer/lib/clock.test.tsx', 'renderer/lib/clock.ts']);
  });
});
