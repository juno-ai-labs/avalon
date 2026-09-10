import { PALETTE_INK, PROJECT_COLOR_KEYS, type PaletteKey, type ProjectColorKey } from '@rally/contracts';
import { serpentineRows } from './grid-layout';

/**
 * Columns in the swatch grid. Fourteen hues over seven columns is two full rows
 * with nothing left over: the first ends on `emerald`, the second runs back the
 * other way and starts beneath it on `cyan`, and `pink` closes the ring under
 * `rose` at the far end. Both seams meet and there is no empty cell.
 *
 * `app.css` sets the same number on `.project-color-grid` and
 * `.appearance-picker-colors`; changing one without the other puts the
 * swatches in an order nobody chose.
 */
export const PROJECT_COLOR_COLUMNS = 7;

/**
 * What a new project starts as.
 *
 * There is no neutral to fall back on any more — `gray` was retired and `black`
 * belongs to the account accent — so this is a hue like any other rather than a
 * deliberate absence of one. `blue` is the quietest of the fourteen for an
 * object nobody has expressed a preference about; it is one constant because
 * the new-project form both initialises and resets to it, and it is the team's
 * to change.
 */
export const PROJECT_COLOR_DEFAULT: ProjectColorKey = 'blue';

/**
 * The swatches in render order, `null` for the cell that keeps the second row
 * right-aligned. Both pickers use this so they lay out identically.
 */
export function projectColorCells(): (ProjectColorKey | null)[] {
  return serpentineRows(PROJECT_COLOR_KEYS, PROJECT_COLOR_COLUMNS);
}

/**
 * The ink to draw a glyph's symbol in, over a palette fill.
 *
 * Follows `PALETTE_INK` rather than one fixed near-white: on the previous darker
 * ramp a single light foreground worked everywhere, and on this one it goes
 * illegible over the brightest fills — white on `lime` is APCA Lc 42 against
 * black's Lc 66, and `lime` is one of the three that still take black. The inks
 * are the absolute pair, not the neutral ramp, which inverts with the
 * appearance — a fill does not change with the theme, so its ink must not
 * either. `--glyph-ink` is consumed by `.workstream-glyph` and
 * `.automation-glyph`.
 */
export function glyphInk(color: PaletteKey): string {
  return PALETTE_INK[color] === 'white'
    ? 'var(--av-sys-color-palette-ink-light)'
    : 'var(--av-sys-color-palette-ink-dark)';
}
