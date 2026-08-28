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
import { MAXIMUM_CLEANUP_BATCH } from "./resource-object-cleanup";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { refreshWorkspaceSchedule } from "./workstream-wakeup-service";

/** What the generator's frozen vocabulary produces: four lowercase words. */
export const RESOURCE_SLUG_PATTERN = /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u;

/**
 * Attempts before allocation gives up, matching the work-stream address
 * reservation this borrows its generator — and its collision odds — from.
 * At one in a billion, reaching a second attempt is already remarkable.
 */
const MAXIMUM_SLUG_ALLOCATION_ATTEMPTS = 1_024;

/**
 * The allocator's key, domain-separated from the work-stream address key.
 *
 * Separation makes the two mappings independent — a resource's alias reveals
 * nothing about a work stream's address and vice versa. It does not make the
 * two *value spaces* disjoint: both draw the same four words from the same
 * frozen vocabulary, so a slug can equal some work stream's local part. That
 * is harmless while nothing routes on a slug, and the reason a slug must never
 * become a routing key without changing its shape first.
 */
async function resourceSlugKey(env: Env): Promise<string> {
  return sha256(`resource-slug:${env.SESSION_SIGNING_KEY}`);
}

async function slugCandidate(
  secretKey: string,
  workspaceId: string,
  resourceId: string,
  attempt: number,
): Promise<string> {
  return allocateWorkstreamEmailAddressCandidate({
    secretKey,
    workstreamId: `resource:${workspaceId}:${resourceId}`,
    attempt,
  });
}

/** The candidate for one attempt. Exported so a test can park it on a row. */
export async function resourceSlugCandidate(
  env: Env,
  workspaceId: string,
  resourceId: string,
  attempt: number,
): Promise<string> {
  return slugCandidate(await resourceSlugKey(env), workspaceId, resourceId, attempt);
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
  const secretKey = await resourceSlugKey(env);
  for (let attempt = 0; attempt < MAXIMUM_SLUG_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = await slugCandidate(secretKey, workspaceId, resourceId, attempt);
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
  // The batch bound of the reapers this pass runs beside, not a second one.
  ).bind(workspaceId, MAXIMUM_CLEANUP_BATCH).all<{ id: string }>();
  let named = 0;
  for (const resource of pending.results) {
    try {
      if (await ensureResourceSlug(routed, workspaceId, resource.id) !== null) named += 1;
    } catch (error) {
      // The batch is ordered oldest-first, so a row that cannot be named would
      // otherwise sit at its head and block every row behind it on every pass.
      // Skipping it keeps the pass making progress and leaves the row due.
      logWarn(env, "resource_slug_allocation_deferred", {
        resource_id: resource.id,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
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
    // `resources` is not an alarm source table, so nothing re-derives the
    // workspace's due index when a row appears needing a name. Without this
    // the pass waits for whatever else wakes the object next, which on a quiet
    // workspace is activity-event retention — a quarter away.
    await refreshWorkspaceSchedule(env, workspaceId).catch(() => undefined);
  }
}

