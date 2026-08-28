/**
 * A resource's short alias, and how one is allocated.
 *
 * Every internal reference — the primary key, storage keys, receipts, links —
 * is the resource's UUID and stays that way. The alias exists for the surfaces
 * a model reads and writes identifiers on, where a UUID costs about thirteen
 * tokens each time it is mentioned and is easy to copy wrong.
 *
 * It is minted by the same generator work-stream email addresses use, over the
 * resource's own coordinates: one vocabulary, one set of collision odds, one
 * place to change either. The key is domain-separated from the address key so
 * a resource alias can never be an address candidate or the reverse.
 */

import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { allocateWorkstreamEmailAddressCandidate } from "../lib/workstream-email-address";
import { logWarn } from "../observability/logger";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

/** What the generator's frozen vocabulary produces: four lowercase words. */
export const RESOURCE_SLUG_PATTERN = /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u;

/**
 * Attempts before allocation gives up, matching the work-stream address
 * reservation this borrows its generator — and its collision odds — from.
 * At one in a billion, reaching a second attempt is already remarkable.
 */
const MAXIMUM_SLUG_ALLOCATION_ATTEMPTS = 1_024;

/** How many resources one maintenance pass names, matching its neighbours. */
const MAXIMUM_SLUG_BACKFILL_BATCH = 100;

/** The candidate for one attempt. Exported so a test can park it on a row. */
export async function resourceSlugCandidate(
  env: Env,
  workspaceId: string,
  resourceId: string,
  attempt: number,
): Promise<string> {
  return allocateWorkstreamEmailAddressCandidate({
    secretKey: await sha256(`resource-slug:${env.SESSION_SIGNING_KEY}`),
    workstreamId: `resource:${workspaceId}:${resourceId}`,
    attempt,
  });
}

/**
 * The resource's alias, allocating one if it has none.
 *
 * Returns null for a resource this workspace does not have — a draft deleted
 * between a creation path committing and this call, which is not an error.
 *
 * `UPDATE OR IGNORE` plus a returned witness rather than a caught constraint
 * error: a candidate another row already holds leaves this row untouched and
 * returns nothing, which is the signal to try the next attempt.
 */
export async function ensureResourceSlug(
  env: Env,
  workspaceId: string,
  resourceId: string,
): Promise<string | null> {
  // `env.DB` as the caller handed it over: every creation path already holds
  // the workspace-routed environment, and re-deriving one here would build a
  // second port over the object that is already answering.
  const database = env.DB;
  for (let attempt = 0; attempt < MAXIMUM_SLUG_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = await resourceSlugCandidate(env, workspaceId, resourceId, attempt);
    const allocated = await database.prepare(
      `UPDATE OR IGNORE resources SET slug = ?
        WHERE id = ? AND workspace_id = ? AND slug IS NULL
        RETURNING slug`,
    ).bind(candidate, resourceId, workspaceId).first<{ slug: string }>();
    if (allocated?.slug) return allocated.slug;
    const current = await database.prepare(
      "SELECT slug FROM resources WHERE id = ? AND workspace_id = ?",
    ).bind(resourceId, workspaceId).first<{ slug: string | null }>();
    if (!current) return null;
    if (current.slug) return current.slug;
  }
  throw new Error("resource_slug_exhausted");
}

/**
 * Name the resources that have no alias yet, one bounded batch at a time.
 *
 * Both the workspaces that predate the column and any resource whose creation
 * path could not finish its own allocation land here: the row itself is the
 * durable record that one is owed, so the inline call at creation is only the
 * fast path and this pass is what guarantees the alias arrives.
 *
 * Returns how many it named, which the alarm reads as progress.
 */
export async function backfillResourceSlugs(env: Env, workspaceId: string): Promise<number> {
  // The alarm calls this with the unrouted environment, as it does the
  // reapers beside it, so the routing happens once here.
  const routed = withWorkspaceRuntimeDatabase(env, workspaceId);
  const pending = await routed.DB.prepare(
    `SELECT id FROM resources
      WHERE workspace_id = ? AND slug IS NULL
      ORDER BY created_at, id
      LIMIT ?`,
  ).bind(workspaceId, MAXIMUM_SLUG_BACKFILL_BATCH).all<{ id: string }>();
  let named = 0;
  for (const resource of pending.results) {
    if (await ensureResourceSlug(routed, workspaceId, resource.id) !== null) named += 1;
  }
  return named;
}

/**
 * Allocate an alias beside a resource that was just created, without letting
 * the attempt fail the creation.
 *
 * The resource exists and is addressable by UUID either way, and `slug IS
 * NULL` is exactly what the maintenance pass looks for — so a failure here
 * costs a delay, not the row.
 */
export async function allocateResourceSlugBesideCreation(
  env: Env,
  workspaceId: string,
  resourceId: string,
): Promise<void> {
  try {
    await ensureResourceSlug(env, workspaceId, resourceId);
  } catch (error) {
    logWarn(env, "resource_slug_allocation_deferred", {
      resource_id: resourceId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

