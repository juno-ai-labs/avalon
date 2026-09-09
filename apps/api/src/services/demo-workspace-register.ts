/**
 * The record of which workspaces this feature published, read from the
 * operation that made each one.
 *
 * There is no register table of its own: the operation row is the register. A
 * workspace enters it when the creating phase allocates its id onto the row,
 * is published when `ready_at` is set, and is closed when `retired_at` is set.
 * Two things read it. Discovery withholds a candidate — a row with no
 * `ready_at` — from its members until preparation finishes, so nobody opens a
 * half-seeded sidebar. And the Demos page lists every operation, of which any
 * number may be live at once. It is not an authorization input for
 * retirement; that gate was considered and dropped, and retirement is an
 * operator action on any workspace, behind Ace's Access policy and a
 * confirmation.
 *
 * Publishing is written by the operation's own wait phase, in the same fenced
 * statement as its status: `ready_at` and `status = 'ready'` land together or
 * not at all. This module holds only the one write that arrives from outside
 * the operation — the retirement walk's.
 */

/**
 * The regional shadow of the tombstone.
 *
 * Written only once the walk reported its whole graph closed, so the register
 * never says a demo is gone while an object under it is still open. It exists
 * so the Demos page can say a demo is gone without waking a retired object to
 * ask it. A no-op for a workspace this feature never made.
 */
export async function markDemoWorkspaceRetired(
  db: D1Database,
  workspaceId: string,
  now: string,
): Promise<void> {
  await db.prepare(
    "UPDATE demo_operations SET retired_at = ?, updated_at = ? WHERE workspace_id = ? AND retired_at IS NULL",
  ).bind(now, now, workspaceId).run();
}
