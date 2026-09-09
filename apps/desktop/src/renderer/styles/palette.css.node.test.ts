import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PALETTE_INK,
  PALETTE_KEYS,
  PERSONAL_COLOR_KEYS,
  PROJECT_COLOR_KEYS,
  PersonalColorSchema,
  personalColorKey,
} from '@rally/contracts';

import { PROJECT_COLOR_COLUMNS, glyphInk, projectColorCells } from '../lib/project-palette';

// Read from disk for the same reason `themes.css.node.test.ts` does: Vite hands
// `?raw` an empty string for a file it is already processing as CSS.
const app = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8');
const onboarding = readFileSync(resolve(process.cwd(), 'src/renderer/styles/onboarding.css'), 'utf8');
const tokensDirectory = resolve(process.cwd(), '../../config/design-tokens');

function themeValues(theme: 'light' | 'dark'): Record<string, string> {
  const file = JSON.parse(
    readFileSync(join(tokensDirectory, 'themes', `${theme}.json`), 'utf8'),
  ) as { tokens: Record<string, string> };
  return file.tokens;
}

/** WCAG relative luminance; the sRGB transfer function, not a brightness approximation. */
function luminance(hex: string): number {
  const channel = (pair: string): number => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7));
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('project palette', () => {
  it('given each palette fill, when contrast decides the ink, then it agrees with PALETTE_INK', () => {
    // The table is checked in so a token edit that flips an ink has to be a
    // visible change rather than a silent one. This is the half that proves the
    // checked-in value is still the right one, recomputed from the fills
    // themselves in both appearances.
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeValues(theme);
      for (const key of PALETTE_KEYS) {
        const fill = tokens[`sys.color.project.${key}`];
        expect(fill, `${theme} is missing a fill for ${key}`).toMatch(/^#[0-9a-f]{6}$/);
        const onFill = luminance(fill as string);
        const white = contrast(luminance('#ffffff'), onFill);
        const black = contrast(luminance('#000000'), onFill);
        expect(PALETTE_INK[key], `${key} in ${theme} (white ${white.toFixed(2)}, black ${black.toFixed(2)})`)
          .toBe(black > white ? 'black' : 'white');
        // Whichever ink wins must actually be readable, not merely the better
        // of two bad options.
        expect(Math.max(white, black), `${key} in ${theme} has no readable ink`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('given the ring, when it is laid out, then it meets itself at both ends with no empty cell', () => {
    const cells = projectColorCells();
    expect(cells).toHaveLength(PROJECT_COLOR_COLUMNS * 2);
    // Two full rows: fourteen hues over seven columns leaves nothing over, so
    // unlike the fifteen-key layout there is no padding cell at all.
    expect(cells.every((cell) => cell !== null)).toBe(true);

    const firstRow = cells.slice(0, PROJECT_COLOR_COLUMNS);
    const secondRow = cells.slice(PROJECT_COLOR_COLUMNS);

    // The row break is a continuation, not a jump: the last swatch of the top
    // row sits directly above the one that follows it in the palette.
    const lastOfFirst = firstRow[PROJECT_COLOR_COLUMNS - 1];
    expect(lastOfFirst).toBe('emerald');
    expect(secondRow[PROJECT_COLOR_COLUMNS - 1]).toBe('cyan');
    expect(PROJECT_COLOR_KEYS.indexOf('cyan')).toBe(PROJECT_COLOR_KEYS.indexOf('emerald') + 1);

    // And the far end closes: `pink` is the last hue, `rose` the first, and they
    // land in the same column, so the grid reads as an oval rather than as two
    // unrelated rows.
    expect(firstRow[0]).toBe('rose');
    expect(secondRow[0]).toBe('pink');

    // A project can never be the neutral.
    expect(cells).not.toContain('black');

    // Every key is placed exactly once and nothing is invented.
    expect(cells.filter((cell) => cell !== null).sort()).toEqual([...PROJECT_COLOR_KEYS].sort());
  });

  it('given the swatch grids, when app.css is read, then both use the column count the layout assumes', () => {
    // The serpentine order is computed against PROJECT_COLOR_COLUMNS; a grid
    // that renders at a different width silently reorders the swatches.
    expect(app).toContain(`grid-template-columns: repeat(${PROJECT_COLOR_COLUMNS}, 32px)`);
    expect(app).toContain(`.workstream-appearance-colors { grid-template-columns: repeat(${PROJECT_COLOR_COLUMNS}, minmax(0, 1fr)); }`);
  });

  it('given the accent ink rules, when onboarding.css is read, then they mirror the ink table', () => {
    // The accent set is a subset of the palette, so the CSS has to name the same
    // exception the table does.
    const whiteInk = Object.entries(PALETTE_INK)
      .filter(([, ink]) => ink === 'white')
      .map(([key]) => key);
    expect(whiteInk).toContain('black');
    // Of the accents a person can pick, only `black` takes white ink; the
    // retired `slate` resolves to it and needs the same rule.
    const whiteAccents = PERSONAL_COLOR_KEYS.filter((key) => PALETTE_INK[key] === 'white');
    expect(whiteAccents).toEqual(['black']);
    expect(onboarding).toContain("html[data-personal-color] { --av-sys-color-accent-on: var(--personal-ink-dark); }");
    expect(onboarding).toContain("html[data-personal-color='black'], html[data-personal-color='slate'] { --av-sys-color-accent-on: var(--personal-ink-light); }");
  });

  it('given every accent a person can hold, when onboarding.css is read, then each resolves to the token the contract gives', () => {
    // `data-personal-color` is written verbatim from the stored value, and the
    // rules below it feed `--personal-color` into `color-mix()`. A missing
    // selector leaves the variable unset, which yields nothing rather than
    // failing loudly, so the app chrome quietly loses its accent while the
    // avatar and the message bubble — which resolve through `personalColorKey()`
    // in TypeScript — keep theirs. Every option, retired names included.
    for (const option of PersonalColorSchema.options) {
      const rule = `html[data-personal-color='${option}'] { --personal-color: var(--av-sys-color-project-${personalColorKey(option)}); }`;
      expect(onboarding, `no accent rule for "${option}" matching personalColorKey()`).toContain(rule);
    }
  });

  it('given every fill a glyph can take, when its symbol is drawn, then the ink clears the graphical-object threshold', () => {
    // The glyph paints an icon straight onto a palette fill. A single light
    // foreground used to work because the old ramp was dark; on this one white
    // over `lime` is 1.98:1. WCAG asks 3:1 of a meaningful graphical object, so
    // check the ink `glyphInk()` actually picks, in both appearances.
    // Resolved from the theme JSON so the test follows a token edit rather than
    // restating one; both inks are absolute, so neither varies by appearance.
    const inkFor = (expression: string, theme: 'light' | 'dark'): string => {
      const token = /var\(--av-sys-color-palette-ink-(light|dark)\)/u.exec(expression)?.[1];
      expect(token, `glyphInk returned an unexpected expression: ${expression}`).toBeDefined();
      return themeValues(theme)[`sys.color.palette-ink.${token}`] as string;
    };

    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeValues(theme);
      for (const key of PALETTE_KEYS) {
        const fill = tokens[`sys.color.project.${key}`] as string;
        const ratio = contrast(luminance(inkFor(glyphInk(key), theme)), luminance(fill));
        expect(ratio, `${key} in ${theme}: glyph symbol at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
