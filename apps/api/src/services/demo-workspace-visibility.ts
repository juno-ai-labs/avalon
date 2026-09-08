/**
 * Which workspaces a member is not offered, and why.
 *
 * Two different things are withheld here and they are withheld for different
 * reasons, which is why they are answered by one function rather than by a
 * shared rule.
 *
 * **The template** is withheld permanently. It is built by hand, holds the demo
 * cast's real connections, and is never something a member should find in their
 * switcher. It is identified by its UUID rather than its name, so renaming it
 * does not defeat the filter and naming another workspace `demo-template` does
 * not acquire it. This is a specific exclusion, not a general hidden-workspace
 * feature: an authorized operator maintaining the template still reaches it, and
 * this filter is deliberately not its security gate — ordinary membership and
 * role checks are.
 *
 * **A candidate** is withheld only until it is published. Preparation is a real
 * admission state: a demo workspace exists and is being filled for minutes
 * before anyone should see it, and offering it in between shows a presenter a
 * half-seeded sidebar and lets them open a room the pack has not finished
 * writing. `ready_at` is what ends that, and retirement does not re-hide
 * anything — a retired demo is closed by its tombstone, not by this list.
 */

/**
 * `demo-template`, in Global, confirmed against the workspace itself.
 *
 * Hardcoded because there is exactly one and it is built by hand, so there is no
 * row anywhere that could name it: the operation rows record what this feature
 * *published*, and the template is the one workspace it never does. That is also
 * why the template needs no second exclusion from retirement — the same absence
 * covers it.
 */
export const DEMO_TEMPLATE_WORKSPACE_ID = "01a06d5d-4624-751e-8269-e7950b51a835";

export type DemoWorkspaceAdmission = "open" | "template" | "preparing";

/**
 * How this workspace should be treated by discovery and switching.
 *
 * `open` is every workspace in Rally that is not one of the two exceptions,
 * which is almost all of them: the operation rows are read only when the id is
 * not the template, and answer `open` for an id no operation allocated.
 */
export async function demoWorkspaceAdmission(
  db: D1Database,
  workspaceId: string,
): Promise<DemoWorkspaceAdmission> {
  if (workspaceId === DEMO_TEMPLATE_WORKSPACE_ID) return "template";
  const row = await db.prepare(
    "SELECT ready_at, retired_at FROM demo_operations WHERE workspace_id = ?",
  ).bind(workspaceId).first<{ ready_at: string | null; retired_at: string | null }>();
  if (!row) return "open";
  // A published demo is an ordinary workspace to its presenter, and a retired
  // one is closed by its tombstone rather than by being hidden — hiding it would
  // leave somebody who is already in it looking at a workspace that silently
  // vanished from their switcher while its rooms still answered.
  return row.ready_at === null && row.retired_at === null ? "preparing" : "open";
}

/**
 * The ids to drop from a member's workspace list, given the ids they belong to.
 *
 * Takes the candidate set rather than reading every demo, so discovery pays one
 * query bounded by what the member is actually in — usually one workspace, and
 * never every operation ever prepared.
 */
export async function withheldDemoWorkspaceIds(
  db: D1Database,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  const withheld = new Set<string>();
  const candidates = workspaceIds.filter((id) => {
    if (id === DEMO_TEMPLATE_WORKSPACE_ID) {
      withheld.add(id);
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return withheld;
  const placeholders = candidates.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT workspace_id FROM demo_operations
      WHERE workspace_id IN (${placeholders}) AND ready_at IS NULL AND retired_at IS NULL`,
  ).bind(...candidates).all<{ workspace_id: string }>();
  for (const row of rows.results ?? []) withheld.add(row.workspace_id);
  return withheld;
}
