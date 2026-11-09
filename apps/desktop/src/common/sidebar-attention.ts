/**
 * What counts as needing attention, in one place: the rail's section counts, the dock
 * badge (their sum) and the menu bar's Needs attention rows and count all read
 * these two predicates, so they cannot disagree. Structural rather than tied
 * to a list's row type, because the renderer holds the contract rows and the
 * main process holds the slimmer rows its own socket keeps.
 */

/** A Canvas counts when it holds something this person has not read. */
export function canvasNeedsAttention(row: { readonly unread: boolean }): boolean {
  return row.unread;
}

/** A Sidekick counts when it is waiting on input or holds something unread. */
export function sidekickNeedsAttention(row: { readonly needsInput?: boolean | undefined; readonly unread?: boolean | undefined }): boolean {
  return row.needsInput === true || row.unread === true;
}
