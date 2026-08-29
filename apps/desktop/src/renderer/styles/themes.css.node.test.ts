import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvedThemes, themeWindowBackground } from '../../common/themes';

// Read from disk for the same reason `app.css.node.test.ts` does: Vite hands
// `?raw` an empty string for a file it is already processing as CSS. This file
// is typed by `tsconfig.node.json` so that `node:fs` stays out of the renderer
// program.
const app = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8');

/**
 * The design-token JSON, two directories up at the repository root. It is the
 * source of truth for what a token is and what each theme sets; `themes.css` is
 * generated from it, and `scripts/build-theme-css.test.mjs` holds the two
 * together. What is left for this file is the half that JSON cannot see: how
 * `app.css` and the main process use the vocabulary.
 */
const tokensDirectory = resolve(process.cwd(), '../../config/design-tokens');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const registry = readJson<{ tokens: Record<string, { $type: string }> }>(
  join(tokensDirectory, 'registry.json'),
);
const themeFiles = readdirSync(join(tokensDirectory, 'themes'))
  .filter((entry) => entry.endsWith('.json'))
  .map((entry) => readJson<{ id: string; tokens: Record<string, string> }>(
    join(tokensDirectory, 'themes', entry),
  ));

/** The custom property a token path is written to; mirrors the generator. */
function customProperty(path: string): string {
  return `--av-${path.replace(/\./gu, '-')}`;
}

const declared = new Set(Object.keys(registry.tokens).map(customProperty));

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
  // `white-space`, `border-top`, and `var(--av-sys-color-danger-base)` all contain a colour name in
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
   * the border band `--av-ref-color-neutral-4` was simultaneously the default border and the
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
   * The navigation's tint is applied exactly once.
   *
   * `--av-cmp-sidebar-background` is translucent, so a second element painting it over a surface
   * that already carries it composites twice and comes out visibly darker. The
   * account row at the foot of the navigation did exactly that, and it is the
   * shape anything added inside the sidebar will reach for. Only the panel
   * itself may name the token.
   */
  it('paints the translucent navigation tint once', () => {
    const offenders = app
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .split('}')
      .filter((block) => /background(-color)?\s*:\s*var\(--av-cmp-sidebar-background\)/u.test(block))
      .map((block) => (block.split('{')[0] ?? '').trim().split('\n').pop() ?? '')
      // The Settings preview is the one legitimate second painter: it
      // composites the tint over the offered theme's own `--av-sys-color-surface-canvas`, which is
      // what the real navigation does over the shell, rather than over a
      // surface already carrying it.
      .filter((selector) => selector !== '.sidebar' && selector !== '.settings-theme-swatch-sidebar');

    expect(offenders).toEqual([]);
  });

  /**
   * The window's backdrop is painted by one element.
   *
   * The shell and the main pane each carried a copy so that the pane, being
   * opaque, would still show the theme's light. Two copies of one gradient
   * cannot be kept in register — a `fixed` attachment holds them together only
   * while both elements are viewport-sized — and a seam ran down the sidebar's
   * edge where Airy's glow stopped and started again. The pane takes a fill it
   * can set to `transparent` instead, and nothing else repaints the backdrop.
   */
  it('paints the backdrop once', () => {
    const painters = app
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .split('}')
      .filter((block) => /background-image\s*:\s*var\(--av-sys-backdrop-image\)/u.test(block))
      .map((block) => (block.split('{')[0] ?? '').trim().split('\n').pop() ?? '');

    // The Settings miniature is the exception, twice over: it draws the offered
    // theme's backdrop rather than the running one's, and under the `system`
    // mode it draws both halves of a family because which one you get depends
    // on the Mac. Neither is the window's backdrop, and both are 92px wide.
    expect(painters).toEqual([
      '.workspace-shell',
      '.settings-theme-swatch',
      '.settings-theme-swatch-alternate',
    ]);
  });

  /**
   * Rendered markdown takes no size from a literal.
   *
   * The engine's one guard is about colour, and a whole type scale slipped
   * through beside it: `.markdown-body` scaled with `sys.font.size.prose` while
   * the headings inside it stayed at a fixed 18/16/14.5/14, so Air rendered an
   * h2 smaller than the paragraph under it for as long as that went unnoticed.
   * A size written here is invisible in whichever theme it was measured
   * against, exactly as a colour would be.
   */
  it('takes every markdown size and weight from a token', () => {
    const offenders = app
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .split('}')
      .filter((block) => /\.markdown-body\s+(h[1-6]|strong|th|td|ul|ol|blockquote|hr|table)\b/u.test(block))
      .flatMap((block) => [...block.matchAll(/(font-size|font-weight|line-height)\s*:\s*([^;{}]+)/gu)]
        .filter((match) => {
          const value = match[2] ?? '';
          return !value.includes('var(') && !/^\s*(inherit|normal|0)\s*$/u.test(value);
        })
        .map((match) => match[0].trim()));

    // `0.88em` and friends are relative to the prose the theme already sets, so
    // they scale with it — a bare `px` is what does not.
    expect(offenders.filter((rule) => !/\d(em|%)/u.test(rule))).toEqual([]);
  });

  // The guard has to be able to see one, or it is asserting that its own
  // regular expressions are broken.
  it('would catch a colour that came back', () => {
    expect(literalColoursIn('.a { color: #ff0000; }')).toEqual(['#ff0000']);
    expect(literalColoursIn('.a { background: rgba(0, 0, 0, 0.4); }')).toEqual(['rgba(']);
    expect(literalColoursIn('.a { border: 1px solid white; }')).toEqual(['white']);
    expect(literalColoursIn('.a { white-space: nowrap; border-top: 0; }')).toEqual([]);
    expect(literalColoursIn('.a { color: var(--av-sys-color-danger-base); }')).toEqual([]);
  });
});

/**
 * The one value written down twice. The main process needs a window's
 * background before any renderer exists to ask, so it cannot read a stylesheet;
 * this is what stops the copy drifting from the original.
 */
describe('window background', () => {
  it.each(resolvedThemes.map((theme) => [theme] as const))('matches the %s theme’s own canvas', (theme) => {
    const file = themeFiles.find((candidate) => candidate.id === theme);

    expect(file?.tokens['sys.color.surface.canvas']).toBe(themeWindowBackground[theme]);
  });
});

/**
 * Every `var()` in the stylesheet names a token the registry declares.
 *
 * A custom property that resolves to nothing is the quietest failure in CSS:
 * the declaration is dropped and the element keeps whatever it inherited, which
 * usually looks almost right. With about 1,300 references and names as long as
 * `--av-sys-color-surface-raised-hover`, a transposition is a matter of time,
 * and nothing else in the build would say a word about it.
 */
describe('token references', () => {
  // Properties the stylesheet defines for its own use rather than taking from a
  // theme. Each is set by a rule in this same file.
  const RULE_LOCAL = ['--sidebar-row-background', '--pill-overhang', '--rail-slot',
    '--composer-line-height', '--composer-text-padding', '--system-message-lines',
    '--tw-fade-scrollbar-thumb', '--tw-fade-scrollbar-width', '--av-cmp-sidebar-width'];

  // Set at runtime rather than in CSS: two by components as inline styles, three
  // by libraries on their own elements. They cannot be checked from this file,
  // so they are listed to say they were considered.
  const RUNTIME = ['--rail-width', '--person-accent', '--markdown-table-columns', '--arrival-index',
    '--radix-select-content-available-height', '--radix-select-trigger-width'];

  it('names only tokens the registry declares', () => {
    const referenced = new Set(
      [...app.matchAll(/var\((--[a-z0-9-]+)/giu)].map((match) => match[1]!),
    );
    const known = new Set([...declared, ...RULE_LOCAL, ...RUNTIME]);
    const unknown = [...referenced].filter((name) => !known.has(name));

    expect(unknown).toEqual([]);
  });

  it('defines every rule-local property it names', () => {
    for (const name of RULE_LOCAL) {
      expect(app.includes(`${name}:`), `${name} is never defined`).toBe(true);
    }
  });
});
