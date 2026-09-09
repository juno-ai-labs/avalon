import { PROJECT_COLOR_KEYS, type ProjectColorKey } from '@rally/contracts';
import { serpentineRows } from './grid-layout';

/**
 * Columns in the swatch grid. Fourteen hues over seven columns is two full rows
 * with nothing left over: the first ends on `emerald`, the second runs back the
 * other way and starts beneath it on `cyan`, and `pink` closes the ring under
 * `rose` at the far end. Both seams meet and there is no empty cell.
 *
 * `app.css` sets the same number on `.project-color-grid` and
 * `.workstream-appearance-colors`; changing one without the other puts the
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
