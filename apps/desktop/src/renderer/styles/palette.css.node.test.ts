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
const app = readFileSync(resolve(process.cwd(), '../../packages/ui/src/styles/app.css'), 'utf8');
const onboarding = readFileSync(resolve(process.cwd(), '../../packages/ui/src/styles/onboarding.css'), 'utf8');
const tokensDirectory = resolve(process.cwd(), '../../config/design-tokens');

/**
 * An appearance's tokens with the base file's under them, the way the build
 * resolves them: the palette fills and both inks are absolute, so they live in
 * `base.json` rather than in either appearance.
 */
function themeValues(theme: 'light' | 'dark'): Record<string, string> {
  const base = JSON.parse(
    readFileSync(join(tokensDirectory, 'base.json'), 'utf8'),
  ) as { tokens: Record<string, string> };
  const file = JSON.parse(
    readFileSync(join(tokensDirectory, 'themes', `${theme}.json`), 'utf8'),
  ) as { tokens: Record<string, string> };
  return { ...base.tokens, ...file.tokens };
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

/**
 * APCA lightness contrast, transcribed from the published algorithm (APCA
 * 0.1.9 / W3 0.0.98G-4g, the contrast method the WCAG 3 drafts use), read
 * 2026-09-10. Returns Lc, whose sign is the polarity and whose magnitude is
 * what the levels below are stated in.
 *
 * This is here rather than in `@rally/contracts` because it exists to *check*
 * the table, not to compute it. `PALETTE_INK` is checked in on purpose.
 */
function apcaY(hex: string): number {
  const channel = (pair: string): number => (Number.parseInt(pair, 16) / 255) ** 2.4;
  const y = 0.2126729 * channel(hex.slice(1, 3))
    + 0.7151522 * channel(hex.slice(3, 5))
    + 0.0721750 * channel(hex.slice(5, 7));
  // Soft-clamp near-black, which the raw curve exaggerates.
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

function apcaLc(text: string, background: string): number {
  const textY = apcaY(text);
  const backgroundY = apcaY(background);
  if (Math.abs(backgroundY - textY) < 0.0005) return 0;
  if (backgroundY > textY) {
    const sapc = (backgroundY ** 0.56 - textY ** 0.57) * 1.14;
    return (sapc < 0.1 ? 0 : sapc - 0.027) * 100;
  }
  const sapc = (backgroundY ** 0.65 - textY ** 0.62) * 1.14;
  return (sapc > -0.1 ? 0 : sapc + 0.027) * 100;
}

/**
 * The two inks that actually ship, read from the theme rather than idealised as
 * pure black and white. `#fcfcfc` and `#141414` are what a glyph is painted in,
 * so they are what every judgement here is made against; comparing `#ffffff`
 * against `#000000` would let a change to either ink token move the real winner
 * without moving this test.
 */
function inks(theme: 'light' | 'dark'): { white: string; black: string } {
  const values = themeValues(theme);
  return {
    white: values['sys.color.palette-ink.light'] as string,
    black: values['sys.color.palette-ink.dark'] as string,
  };
}

/** The ink APCA would pick, which the table follows everywhere but the ties below. */
function apcaWinner(fill: string, theme: 'light' | 'dark'): 'white' | 'black' {
  const { white, black } = inks(theme);
  return Math.abs(apcaLc(white, fill)) > Math.abs(apcaLc(black, fill)) ? 'white' : 'black';
}

/**
 * APCA's minimum readable level for a mark of this weight — large or bold text
 * and meaningful non-text alike. Transcribed from its published readability
 * levels, read 2026-09-10; not a number chosen here.
 */
const READABLE_LC = 45;

/**
 * The two fills where the table departs from `apcaWinner`, and why it is allowed
 * to. Both are ties in APCA's own terms — `cyan` Lc 52 white against 57 black,
 * `emerald` 54 against 55 — and the ring reads better with one ink running
 * through it than with two exceptions stranded mid-ramp. Listing them by name is
 * what keeps the exception from spreading: a token edit that puts a *third* fill
 * on the wrong side of the model fails rather than joining the list.
 */
const APCA_TIES = new Set(['cyan', 'emerald']);

/**
 * Fills whose chosen ink does not clear WCAG 2's 3:1 for a graphical object.
 *
 * This is accepted debt, not an oversight: WCAG 2's relative luminance misjudges
 * saturated mid-tones, `PALETTE_INK` follows APCA instead, and the contract
 * comment records the trade. The list is pinned so the debt cannot quietly grow
 * — a token change that drags a fifth fill under the bar fails here. *Nine*
 * more sit between 3:1 and the 4.5:1 that standard asks of text; thirteen is
 * the count below 4.5:1 in total, these four being the ones under even the
 * graphical-object bar.
 *
 * Asserted by set equality, so *improving* one of these fills fails this test
 * too. That is intended — a fill leaving the set is exactly as much a change to
 * the recorded debt as one joining it, and `yellow` at 2.86:1 is close enough to
 * the bar that a small edit could do it.
 */
const BELOW_WCAG_GRAPHICAL = new Set(['cyan', 'emerald', 'orange', 'yellow']);

describe('project palette', () => {
  it('given APCA\'s published check values, when the transcription runs, then it reproduces them', () => {
    // `apcaY`/`apcaLc` are transcribed by hand, so a mistyped exponent would
    // quietly re-decide the whole table while every other test in this file
    // agreed with it — they all read the same function. These are the
    // algorithm's own keystone check values, stated to full precision and taken
    // from its documentation rather than from this implementation, which is what
    // makes them able to catch that.
    //
    // The set matters as much as the numbers. A vector over white or black
    // exercises nothing on the background side, because `1 ** x` and `0 ** x`
    // are the same whatever `x` is — the first draft of this test used only
    // those and survived changing `0.56` to `0.57`. The mid-tone backgrounds
    // below are what pin both background exponents, and the last pair sits under
    // the low-contrast clip.
    const vectors: readonly [string, string, number][] = [
      ['#888888', '#ffffff', 63.056469930209424],
      ['#ffffff', '#888888', -68.54146436644962],
      ['#000000', '#aaaaaa', 58.146262578561334],
      ['#aaaaaa', '#000000', -56.24113336839742],
      ['#112233', '#ddeeff', 91.66830811481631],
      ['#ddeeff', '#112233', -93.06770049484275],
      ['#112233', '#444444', 8.32326136957393],
      ['#444444', '#112233', -7.526878460278154],
    ];
    for (const [text, background, expected] of vectors) {
      expect(apcaLc(text, background), `${text} on ${background}`).toBeCloseTo(expected, 6);
    }
  });

  it('given each palette fill, when APCA decides the ink, then it agrees with PALETTE_INK', () => {
    // The table is checked in so a token edit that flips an ink has to be a
    // visible change rather than a silent one. This is the half that proves the
    // checked-in value is still the right one, recomputed from the fills
    // themselves in both appearances.
    //
    // APCA, not the WCAG 2 ratio this once used. That ratio made black the
    // winner on sixteen of these nineteen fills — `blue`, `red`, `violet` among
    // them — where a white mark plainly reads better; thirteen of those sixteen
    // are what this change reversed, the other three still taking black. Its
    // luminance curve misjudges saturated mid-tones, and the whole palette is
    // saturated mid-tones.
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeValues(theme);
      for (const key of PALETTE_KEYS) {
        const fill = tokens[`sys.color.project.${key}`];
        expect(fill, `${theme} is missing a fill for ${key}`).toMatch(/^#[0-9a-f]{6}$/);
        const white = Math.abs(apcaLc(inks(theme).white, fill as string));
        const black = Math.abs(apcaLc(inks(theme).black, fill as string));
        const detail = `${key} in ${theme} (white Lc ${white.toFixed(0)}, black Lc ${black.toFixed(0)})`;

        if (APCA_TIES.has(key)) {
          // The exemption is only honest while the fill really is a tie. If one
          // ink stops being readable the disagreement is no longer a coin-flip,
          // and the table has to follow the model rather than keep its
          // exception. Stated as "both inks clear the floor" so there is no
          // invented tolerance to argue about.
          expect(Math.min(white, black), `${detail} is no longer a tie`).toBeGreaterThanOrEqual(READABLE_LC);
        } else {
          expect(PALETTE_INK[key], detail).toBe(apcaWinner(fill as string, theme));
        }

        // Whichever ink the table takes has to actually be readable, tie or not.
        const chosen = PALETTE_INK[key] === 'white' ? white : black;
        expect(chosen, `${detail} is below the readable floor`).toBeGreaterThanOrEqual(READABLE_LC);
      }
    }
  });

  it('given the fills that fail WCAG 2, when the ink is chosen, then the accepted debt has not grown', () => {
    // Following APCA means some fills carry an ink WCAG 2 would reject. That is
    // a decision, recorded on `PALETTE_INK`. What must not happen is the set
    // growing by accident when somebody nudges a token, so it is pinned here by
    // name — the same reason the ink table itself is checked in.
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeValues(theme);
      const failing = PALETTE_KEYS.filter((key) => {
        const fill = tokens[`sys.color.project.${key}`] as string;
        const ink = PALETTE_INK[key] === 'white' ? inks(theme).white : inks(theme).black;
        return contrast(luminance(ink), luminance(fill)) < 3;
      });
      expect(new Set(failing), `${theme}: the WCAG 2 shortfall changed`).toEqual(BELOW_WCAG_GRAPHICAL);
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
    expect(app).toContain(`.appearance-picker-colors { grid-template-columns: repeat(${PROJECT_COLOR_COLUMNS}, minmax(0, 1fr)); }`);
  });

  it('given an accent, when onboarding.css is read, then it colours marks and controls but fills no row', () => {
    // The accent may re-point what it likes in `sys.color.accent.*`; what it
    // may not re-point is `cmp.row.background-selected`. That token is a fill,
    // and only about half its readers are selections — the rest are an inline
    // mention chip, a resting dictation button, two hovers and the letter
    // beside an option, none of which anybody chose to paint in a reader's
    // colour. A future accent that wants a row back should give that row a
    // token of its own rather than re-point the one everything shares.
    //
    // Matched as a *declaration*, with comments stripped first. Asserting on
    // the file text passed only because the comment beside the deleted line
    // spells the token as a path (`cmp.row.background-selected`) rather than
    // as the custom property — a distinction the prose is right to draw and
    // the guard has no business depending on. As written, prose may spell it
    // either way and only a re-point fails; reading the token through `var()`
    // stays allowed, because borrowing the fill was never the problem.
    const declarations = onboarding.replace(/\/\*[\s\S]*?\*\//gu, ' ');
    expect(declarations).not.toMatch(/--av-cmp-row-background-selected\s*:/u);
  });

  it('given the accent ink rules, when onboarding.css is read, then they mirror the ink table', () => {
    // `accent-on` is paired with `accent-base`, a mix toward `text-default`, so
    // it follows the appearance rather than the accent — one rule, no per-hue
    // exception. Pinning a per-hue rule here is what locked in near-black ink on
    // a near-black mix for every light-theme accent.
    expect(onboarding).toContain("html[data-personal-color] { --av-sys-color-accent-on: var(--av-sys-color-text-on-inverse); }");
    expect(onboarding).not.toMatch(/--av-sys-color-accent-on: var\(--personal-ink/u);

    // The swatch checkmark does sit on a raw fill, and that one follows the
    // table. Pinned by name rather than recomputed: the point is that a change
    // to `PALETTE_INK` shows up as an edit here, so somebody has to look at the
    // swatch row when the ring's ink moves. `lime` is the one accent a person
    // can hold that still takes black.
    const whiteAccents = PERSONAL_COLOR_KEYS.filter((key) => PALETTE_INK[key] === 'white');
    expect(whiteAccents).toEqual(['rose', 'orange', 'emerald', 'blue', 'violet', 'fuchsia', 'black']);
  });

  it('given the personal ink pair, when the appearance swaps the ramp under it, then the pair does not invert', () => {
    // `personalColorInk()` is the other reader of `PALETTE_INK`, and it resolves
    // through `--personal-ink-light`/`-dark` rather than the palette-ink tokens
    // the glyph uses. Those two are defined off `ref.color.neutral.*`, which
    // *does* invert with the appearance, and onboarding.css swaps which neutral
    // each one points at to cancel that out. Two inversions cancelling is
    // exactly the kind of thing that silently stops cancelling, and until now
    // nothing checked it — the flip to sixteen white accents raised the stakes.
    for (const theme of ['light', 'dark'] as const) {
      const values = themeValues(theme);
      const rule = theme === 'dark'
        ? "html[data-theme='dark'] { --personal-ink-light: var(--av-ref-color-neutral-14); --personal-ink-dark: var(--av-ref-color-neutral-1); }"
        : 'html { --personal-ink-light: var(--av-ref-color-neutral-1); --personal-ink-dark: var(--av-ref-color-neutral-14); }';
      expect(onboarding, `${theme} no longer declares the personal ink pair as expected`).toContain(rule);

      const light = values[theme === 'dark' ? 'ref.color.neutral.14' : 'ref.color.neutral.1'] as string;
      const dark = values[theme === 'dark' ? 'ref.color.neutral.1' : 'ref.color.neutral.14'] as string;

      // Threshold-free: whatever the ramp does, the light ink has to stay
      // lighter than every fill it can be painted on and the dark ink darker.
      for (const key of PERSONAL_COLOR_KEYS) {
        const fill = values[`sys.color.project.${key}`] as string;
        expect(luminance(light), `${theme}: personal-ink-light is not light over ${key}`)
          .toBeGreaterThan(luminance(fill));
        expect(luminance(dark), `${theme}: personal-ink-dark is not dark over ${key}`)
          .toBeLessThan(luminance(fill));

        // And the ink the table actually picks has to be readable on it.
        const chosen = PALETTE_INK[key] === 'white' ? light : dark;
        expect(Math.abs(apcaLc(chosen, fill)), `${key} in ${theme}: accent ink below the floor`)
          .toBeGreaterThanOrEqual(READABLE_LC);
      }
    }
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

  it('given every fill a glyph can take, when glyphInk resolves it, then the token names the ink the table chose', () => {
    // The glyph paints an icon straight onto a palette fill, and `glyphInk()`
    // is the only thing standing between the table and the CSS variable. A
    // mapping that inverted would be invisible to the test above, which never
    // leaves the table. Resolved through the theme JSON so this follows a token
    // edit rather than restating one; both inks are absolute, so neither varies
    // by appearance.
    const inkFor = (expression: string, theme: 'light' | 'dark'): string => {
      const token = /var\(--av-sys-color-palette-ink-(light|dark)\)/u.exec(expression)?.[1];
      expect(token, `glyphInk returned an unexpected expression: ${expression}`).toBeDefined();
      return themeValues(theme)[`sys.color.palette-ink.${token}`] as string;
    };

    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeValues(theme);
      for (const key of PALETTE_KEYS) {
        const resolved = inkFor(glyphInk(key), theme);
        const fill = tokens[`sys.color.project.${key}`] as string;
        const expected = tokens[`sys.color.palette-ink.${PALETTE_INK[key] === 'white' ? 'light' : 'dark'}`];
        expect(resolved, `${key} in ${theme} took the wrong ink token`).toBe(expected);
        expect(Math.abs(apcaLc(resolved, fill)), `${key} in ${theme} draws its symbol below the floor`)
          .toBeGreaterThanOrEqual(READABLE_LC);
      }
    }
  });
});
