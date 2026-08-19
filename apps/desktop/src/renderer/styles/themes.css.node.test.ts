import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvedThemes, themeWindowBackground } from '../../common/themes';

// Read from disk for the same reason `app.css.node.test.ts` does: Vite hands
// `?raw` an empty string for a file it is already processing as CSS. This file
// is typed by `tsconfig.node.json` so that `node:fs` stays out of the renderer
// program.
function stylesheet(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src/renderer/styles', name), 'utf8');
}

const themes = stylesheet('themes.css');
const app = stylesheet('app.css');

/** One theme's declaration block, by the selector that introduces it. */
function themeBlock(selector: string): string {
  const start = themes.indexOf(`${selector} {`);
  expect(start, `${selector} is not declared in themes.css`).toBeGreaterThan(-1);
  return themes.slice(themes.indexOf('{', start) + 1, themes.indexOf('\n}', start));
}

function tokensIn(block: string): Map<string, string> {
  const declared = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)) {
    if (name && value) declared.set(name, value.trim());
  }
  return declared;
}

const BLOCKS = {
  dark: ":root,\n[data-theme='dark']",
  light: "[data-theme='light']",
  airy: "[data-theme='airy']",
} as const;

const dark = tokensIn(themeBlock(BLOCKS.dark));

/**
 * The engine's one structural rule: `app.css` names tokens and never a colour.
 *
 * A literal that slips back in does not fail anywhere else. It renders
 * correctly under whichever theme it was sampled from and is invisible in every
 * other one until somebody switches — which is how the stylesheet accumulated
 * 268 of them before this engine existed. Nothing but this assertion catches
 * the 269th.
 */
describe('no colour is written into app.css', () => {
  // `white-space`, `border-top`, and `var(--red)` all contain a colour name in
  // a position that is not a colour, so the check reads declaration values
  // rather than searching the file.
  const COLOUR_NAMES = [
    'white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'silver', 'orange',
    'yellow', 'purple', 'pink', 'brown', 'navy', 'teal', 'olive', 'maroon',
    'lime', 'aqua', 'fuchsia', 'crimson', 'gold', 'beige', 'ivory', 'tan',
  ];

  function literalColoursIn(css: string): string[] {
    const found: string[] = [];
    for (const [, value] of css.replace(/\/\*[\s\S]*?\*\//gu, ' ').matchAll(/:\s*([^;{}]+)[;}]/gu)) {
      if (!value) continue;
      // A token's own value is not a literal in this file — `themes.css` is
      // where colours are allowed to be written down.
      const outsideVar = value.replace(/var\([^)]*\)/gu, ' ');
      for (const [hex] of outsideVar.matchAll(/#[0-9a-fA-F]{3,8}\b/gu)) found.push(hex);
      for (const [fn] of outsideVar.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gu)) found.push(fn);
      for (const name of COLOUR_NAMES) {
        if (new RegExp(`(?:^|[\\s,(])${name}(?:$|[\\s,)])`, 'u').test(outsideVar)) found.push(name);
      }
    }
    return found;
  }

  it('writes no hex, functional, or named colour outside a var()', () => {
    expect(literalColoursIn(app)).toEqual([]);
  });

  /**
   * And neither does the renderer's TypeScript. Two palettes lived there —
   * `prism-react-renderer`'s theme object and the per-participant accent — and
   * both are handed to inline styles rather than to a class, which is exactly
   * the shape that looks like it has no choice but to name a colour. It does:
   * a custom property in an inline style resolves against the cascade like any
   * other reference.
   */
  it('names no colour in a renderer source file either', () => {
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/u.test(entry.name) && !entry.name.includes('.test.')) {
          const source = readFileSync(path, 'utf8');
          for (const [match] of source.matchAll(/#[0-9a-fA-F]{6}\b|\brgba?\(/gu)) {
            offenders.push(`${entry.name}: ${match}`);
          }
        }
      }
    };
    walk(resolve(process.cwd(), 'src/renderer'));

    expect(offenders).toEqual([]);
  });

  /**
   * Lines come off the line ramp and fills come off the neutral one.
   *
   * The two were one ramp until Airy needed borders that all but disappear: at
   * the border band `--n-4` was simultaneously the default border and the
   * selected sidebar row's fill, so making the border vanish took the selection
   * with it. A border that reaches back onto `--n-*` re-creates that coupling
   * silently — it looks right in whichever theme it was written against.
   */
  it('draws every border and outline from the line ramp', () => {
    const offenders = app
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .split('\n')
      .filter((line) => /(?:border[a-z-]*|outline(?:-color)?)\s*:[^;{}]*var\(--n-\d+\)/u.test(line))
      .map((line) => line.trim().slice(0, 70));

    expect(offenders).toEqual([]);
  });

  /**
   * The navigation's width and the room it occupies are different numbers.
   *
   * `--sidebar-width` is the floating panel; `--sidebar-slot` is that plus the
   * gutter on either side of it. A rule that sits beside the navigation and
   * measures the width overlaps the panel by twice the inset — 16px, which
   * reads as a rendering glitch rather than as a layout bug, and only in themes
   * whose inset is non-zero. Two places may name the width: the derivation
   * itself, and the panel's own `width`.
   */
  it('measures the navigation slot rather than the panel width', () => {
    const offenders = app
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .split('\n')
      .filter((line) => line.includes('var(--sidebar-width)'))
      .filter((line) => !line.includes('--sidebar-slot:') && !/^\s*width: var\(--sidebar-width\);/u.test(line))
      .map((line) => line.trim().slice(0, 80));

    expect(offenders).toEqual([]);
  });

  // The derivation has to live where the resize handle writes the width, or it
  // freezes at the default and nothing looks wrong until someone drags.
  it('derives the slot on the element the resize handle writes to', () => {
    const shell = app.slice(app.indexOf('.workspace-shell {'), app.indexOf('}', app.indexOf('.workspace-shell {')));

    expect(shell).toContain('--sidebar-slot:');
  });

  // The guard has to be able to see one, or it is asserting that its own
  // regular expressions are broken.
  it('would catch a colour that came back', () => {
    expect(literalColoursIn('.a { color: #ff0000; }')).toEqual(['#ff0000']);
    expect(literalColoursIn('.a { background: rgba(0, 0, 0, 0.4); }')).toEqual(['rgba(']);
    expect(literalColoursIn('.a { border: 1px solid white; }')).toEqual(['white']);
    expect(literalColoursIn('.a { white-space: nowrap; border-top: 0; }')).toEqual([]);
    expect(literalColoursIn('.a { color: var(--red); }')).toEqual([]);
  });
});

/** Every theme restates the whole palette; see `colourTokens` for why. */
describe('theme completeness', () => {
  /**
   * A token whose dark value names a colour. These are the ones a theme has to
   * restate: a length, a font stack, or an alias means the same thing whatever
   * the theme, but a colour inherited from the dark block is a dark colour, and
   * inheriting one is silent. A light theme missing `--tooltip-ink` draws a
   * tooltip in near-black on near-black; nothing else looks wrong, and nobody
   * finds it until a person hovers something.
   */
  function colourTokens(block: Map<string, string>): string[] {
    return [...block]
      .filter(([, value]) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/iu.test(value))
      .map(([name]) => name);
  }

  const required = colourTokens(dark);

  it('has colour tokens to check', () => {
    // Guards the guard: a refactor that stopped these matching would leave the
    // two assertions below passing over an empty list.
    expect(required.length).toBeGreaterThan(60);
  });

  it.each([['light'], ['airy']] as const)('%s restates every colour the dark theme names', (name) => {
    const declared = tokensIn(themeBlock(BLOCKS[name]));
    const missing = required.filter((token) => !declared.has(token));

    expect(missing).toEqual([]);
  });

  it.each([['light'], ['airy']] as const)('%s introduces no token the other themes lack', (name) => {
    const extra = [...tokensIn(themeBlock(BLOCKS[name])).keys()].filter((token) => !dark.has(token));

    expect(extra).toEqual([]);
  });

  // The aliases are the vocabulary the stylesheet already spoke, and they are
  // defined once — in the dark block, which is also `:root` — as `var(--n-*)`.
  // A theme that redefined one to a literal would be pinning a colour that a
  // ramp step already decides, and the two would drift.
  it('leaves the legacy aliases pointing at ramp steps', () => {
    for (const alias of ['--ink', '--ink-soft', '--muted', '--muted-2']) {
      expect(dark.get(alias)).toMatch(/^var\(--n-\d+\)$/u);
    }
    // The three line aliases point at the *line* ramp, not the neutral one. A
    // border and a faint fill sit at the same contrast level and want opposite
    // treatment in a theme that draws with space, so they cannot share a step.
    for (const alias of ['--line', '--line-soft', '--line-strong']) {
      expect(dark.get(alias)).toMatch(/^var\(--line-\d+\)$/u);
    }
    for (const name of ['light', 'airy'] as const) {
      expect(tokensIn(themeBlock(BLOCKS[name])).has('--ink')).toBe(false);
    }
  });

  it.each([['--n-', 14], ['--line-', 6]] as const)('orders the %s ramp by contrast', (prefix, length) => {
    for (const [name, selector] of Object.entries(BLOCKS)) {
      const declared = tokensIn(themeBlock(selector));
      const steps = Array.from({ length }, (_, index) => declared.get(`${prefix}${index + 1}`));

      expect(steps.every(Boolean), `${name} declares all ${length} ${prefix} steps`).toBe(true);
      // Ordered by contrast against the surface, so the direction is whichever
      // way the theme runs: monotonic *distance* from the first step is what
      // has to hold, in a light theme and a dark one alike.
      const distances = steps.map((step) => Math.abs(luminance(step!) - luminance(steps[0]!)));
      const ascending = distances.every((value, index) => index === 0 || value >= distances[index - 1]!);

      expect(ascending, `${name} ramp is monotonic: ${distances.map(Math.round).join(', ')}`).toBe(true);
    }
  });
});

function luminance(hex: string): number {
  const value = hex.trim().replace('#', '');
  const channel = (offset: number): number => Number.parseInt(value.slice(offset, offset + 2), 16);
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * The one value written down twice. The main process needs a window's
 * background before any renderer exists to ask, so it cannot read a stylesheet;
 * this is what stops the copy drifting from the original.
 */
describe('window background', () => {
  it.each(resolvedThemes.map((theme) => [theme] as const))('matches the %s theme’s own canvas', (theme) => {
    expect(tokensIn(themeBlock(BLOCKS[theme])).get('--canvas')).toBe(themeWindowBackground[theme]);
  });
});
