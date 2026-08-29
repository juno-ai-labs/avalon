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

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { allocateWorkstreamEmailAddressCandidate } from "../lib/workstream-email-address";
import { logWarn } from "../observability/logger";
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

/** The WorkspaceDO that owns this workspace's resource aliases. */
function workspaceObject(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

/**
 * The resource's alias, allocating one if it has none.
 *
 * Returns null for a resource this workspace does not have — a draft deleted
 * between a creation path committing and this call, which is not an error.
 *
 * The generator stays here — it is an HMAC over a Worker secret the object
 * does not hold — while each attempt is one typed claim: the conditional
 * update and the read that explains a refusal used to be two round trips, and
 * `candidate_taken` is the object's signal to try the next attempt.
 */
export async function ensureResourceSlug(
  env: Env,
  workspaceId: string,
  resourceId: string,
): Promise<string | null> {
  const workspace = await workspaceObject(env, workspaceId);
  const secretKey = await resourceSlugKey(env);
  for (let attempt = 0; attempt < MAXIMUM_SLUG_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = await slugCandidate(secretKey, workspaceId, resourceId, attempt);
    const claim = await workspace.claimResourceSlug({ workspaceId, resourceId, candidate });
    if (claim.outcome === "allocated" || claim.outcome === "already_named") return claim.slug;
    if (claim.outcome === "missing") return null;
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
  // The batch bound lives with the read, in the object's storage module — the
  // same bound the reapers this pass runs beside use, not a second one.
  const pending = await (await workspaceObject(env, workspaceId))
    .listResourcesAwaitingSlug({ workspaceId });
  let named = 0;
  for (const resourceId of pending.items) {
    try {
      if (await ensureResourceSlug(env, workspaceId, resourceId) !== null) named += 1;
    } catch (error) {
      // The batch is ordered oldest-first, so a row that cannot be named would
      // otherwise sit at its head and block every row behind it on every pass.
      // Skipping it keeps the pass making progress and leaves the row due.
      logWarn(env, "resource_slug_allocation_deferred", {
        resource_id: resourceId,
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

