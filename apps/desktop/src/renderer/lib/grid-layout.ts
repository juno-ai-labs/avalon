/**
 * Lay a sequence out boustrophedon: the first row runs left to right, the next
 * runs right to left, and so on, so the sequence never jumps back across the
 * grid at a row break.
 *
 * For an ordered palette this turns the break into a continuation. The last
 * swatch of a forward row sits directly above the first swatch of the row
 * below it, and — when the sequence is a closed ring, as `PROJECT_COLOR_KEYS`
 * is — the far end wraps around to meet the beginning again, so the grid reads
 * as an oval rather than as two unrelated rows.
 *
 * A short final row is padded before it is reversed, which right-aligns it and
 * leaves the empty cells at the leading edge. Callers render a `null` as an
 * inert cell so the alignment survives; a forward final row keeps no padding,
 * since trailing holes would just be dead space.
 *
 * The returned order is the render order, which keeps the DOM, the visual
 * layout, and keyboard traversal in agreement.
 */
export function serpentineRows<T>(items: readonly T[], columns: number): (T | null)[] {
  if (columns < 1) throw new RangeError(`serpentineRows needs at least one column, got ${columns}`);
  const laid: (T | null)[] = [];
  for (let start = 0; start < items.length; start += columns) {
    const row: (T | null)[] = [...items.slice(start, start + columns)];
    const reversed = (start / columns) % 2 === 1;
    if (reversed) {
      while (row.length < columns) row.push(null);
      row.reverse();
    }
    laid.push(...row);
  }
  return laid;
}
