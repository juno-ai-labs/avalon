import { regionConfiguration } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts";
import type { DurableObject as RpcDurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { logError } from "../observability/logger";
import { durableObjectSelfForId, selfAddressedOverRpc } from "./durable-object-self";

type AvalonEnvironment = "development" | "test" | "staging" | "production";

export const WORKSPACE_PLACEMENT_AFFINITIES = ["wnam", "enam", "weur", "eeur"] as const;
export type WorkspacePlacementAffinity = (typeof WORKSPACE_PLACEMENT_AFFINITIES)[number];
export interface WorkspacePlacementDecision {
  affinity: WorkspacePlacementAffinity;
  source: "request_longitude" | "missing_request_metadata";
}

const placementCache = new WeakMap<D1Database, Map<string, WorkspacePlacementAffinity>>();
const WORKSPACE_PLACEMENT_CACHE_LIMIT = 1_024;

export function fallbackWorkspacePlacementAffinity(region: Region): WorkspacePlacementAffinity {
  const affinity = regionConfiguration(region).affinities[0];
  if (!isWorkspacePlacementAffinity(affinity)) throw new Error("Invalid configured placement affinity");
  return affinity;
}

export function isWorkspacePlacementAffinity(value: unknown): value is WorkspacePlacementAffinity {
  return typeof value === "string"
    && (WORKSPACE_PLACEMENT_AFFINITIES as readonly string[]).includes(value);
}

export function isWorkspacePlacementAffinityForRegion(
  region: Region,
  value: unknown,
): value is WorkspacePlacementAffinity {
  return isWorkspacePlacementAffinity(value)
    && regionConfiguration(region).affinities.includes(value);
}

/** Select the immutable workspace affinity once, from the initiating request. */
export function deriveWorkspacePlacementAffinity(
  region: Region,
  cf: unknown,
): WorkspacePlacementDecision {
  const rawLongitude = cf && typeof cf === "object" && "longitude" in cf
    ? cf.longitude
    : undefined;
  const longitude = typeof rawLongitude === "number"
    ? rawLongitude
    : typeof rawLongitude === "string" && rawLongitude.trim() !== ""
      ? Number(rawLongitude)
      : Number.NaN;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return {
      affinity: fallbackWorkspacePlacementAffinity(region),
      source: "missing_request_metadata",
    };
  }
  const configuration = regionConfiguration(region);
  const affinity = configuration.affinities[longitude < configuration.longitudeSplit ? 0 : 1];
  if (!isWorkspacePlacementAffinity(affinity)) throw new Error("Invalid configured placement affinity");
  return { affinity, source: "request_longitude" };
}

function isLocalEnvironment(environment: AvalonEnvironment | undefined): boolean {
  // Real entrypoints validate APP_ENV before dispatch. Treat an omitted value
  // as local only for focused unit doubles that intentionally supply a partial
  // Env; staging and production remain the only jurisdictional modes.
  return environment !== "staging" && environment !== "production";
}

function durableObjectNamespaceForRegion<T extends RpcDurableObject | undefined = undefined>(
  namespace: DurableObjectNamespace<T>,
  region: Region,
  environment: AvalonEnvironment,
): DurableObjectNamespace<T> {
  // workerd/Miniflare currently throws because jurisdiction restrictions are
  // not implemented locally. Production and staging always resolve IDs through
  // a jurisdiction-constrained namespace for both product regions.
  if (isLocalEnvironment(environment)) return namespace;
  return namespace.jurisdiction(regionConfiguration(region).jurisdiction);
}

/**
 * What refusing or reporting a self-address needs off the environment.
 *
 * Every logged field but the region and the environment is optional so this
 * stays callable from the narrow `Pick` environments the resolvers already
 * accept — a helper that only receives routing bindings must not lose the
 * ability to resolve a stub because it cannot also log about one.
 */
type SelfAddressReportEnv = Pick<Env, "AVALON_REGION" | "APP_ENV">
  & Partial<Pick<Env, "LOG_LEVEL" | "APP_VERSION" | "BUILD_SHA">>;

/**
 * Refuse, or report, a stub that reaches the object resolving it.
 *
 * Every resolver here answers the caller's own id locally before reaching this,
 * so nothing that gets here is a self-call the routing could have avoided — it
 * is one the routing could not *see*: a registration that was not on the
 * environment handed down, or a caller that skipped the self-aware resolvers.
 * Both are defects.
 *
 * So it is fatal where a human is watching and a diagnostic where one is not.
 * Development and test throw, because a failing test is the cheapest possible
 * version of this news; staging and production log at error and hand the stub
 * back, because refusing there would turn a latent defect into an outage, and
 * the call does complete. That split is `isLocalEnvironment`, the same one that
 * decides jurisdictional routing.
 *
 * Error rather than warning because it is not a slow path — it is re-entrancy
 * the code does not model, and it accumulates: fifteen of these in one
 * invocation exhausted Cloudflare's subrequest depth on 2026-08-24 and killed a
 * work stream mid-run, with nothing in any log saying an object had been
 * talking to itself.
 *
 * Deliberately not rate limited or sampled. A run that does this does it a
 * bounded number of times before the platform stops it, the entries are the
 * only evidence that it happened at all, and choosing how many to drop is not a
 * number this file gets to invent
 * ([`docs/adding-security-defensive-and-other-limits.md`](../../../../docs/adding-security-defensive-and-other-limits.md)).
 */
function refuseSelfAddressedStub<T extends RpcDurableObject | undefined>(
  env: SelfAddressReportEnv,
  namespace: DurableObjectNamespace<T>,
  id: DurableObjectId,
  resolver: "region" | "object_id",
  requestedName: string | null,
): void {
  const registration = selfAddressedOverRpc(env, namespace, id);
  if (!registration) return;
  if (isLocalEnvironment(env.APP_ENV)) {
    throw new Error(
      `durable_object_self_addressed_over_rpc:${resolver}:${requestedName ?? id.toString()}`,
    );
  }
  logError({
    LOG_LEVEL: env.LOG_LEVEL ?? "info",
    AVALON_REGION: env.AVALON_REGION,
    ...(env.APP_VERSION === undefined ? {} : { APP_VERSION: env.APP_VERSION }),
    ...(env.BUILD_SHA === undefined ? {} : { BUILD_SHA: env.BUILD_SHA }),
  }, "durable_object_self_addressed_over_rpc", {
    resolver,
    requested_name: requestedName,
    // `null` here says the object could not name itself. That no longer
    // changes any routing — the id decided that — but it distinguishes an
    // object mid-initialization from one whose registration never reached the
    // environment at all.
    self_name: registration.name,
    object_id: id.toString(),
  });
}

/**
 * The id a name resolves to in this region, without resolving a stub.
 *
 * Split out of the resolver below so a caller can ask which object a name is
 * about to reach without depending on the stub having an `id` — a focused unit
 * double stands in for the stub, never for the namespace.
 */
function durableObjectIdForRegion<T extends RpcDurableObject | undefined>(
  namespace: DurableObjectNamespace<T>,
  region: Region,
  name: string,
  environment: AvalonEnvironment,
): DurableObjectId {
  return durableObjectNamespaceForRegion(namespace, region, environment).idFromName(name);
}

/**
 * The only supported resolver for Avalon product Durable Objects.
 *
 * Jurisdiction must be selected before deriving the name-based ID because the
 * same name identifies different objects in unrestricted, US, and regional
 * namespaces. Every possible first `get()` also carries a location hint;
 * Cloudflare only considers that option on the first lookup for an object.
 */
export function durableObjectStubForRegion<T extends RpcDurableObject | undefined = undefined>(
  env: SelfAddressReportEnv,
  namespace: DurableObjectNamespace<T>,
  region: Region,
  name: string,
  locationHint: DurableObjectLocationHint,
): DurableObjectStub<T> {
  const environment = env.APP_ENV;
  const regionalNamespace = durableObjectNamespaceForRegion(namespace, region, environment);
  const id = regionalNamespace.idFromName(name);
  // Here rather than in the callers below, because this is the one function
  // every stub in this repository comes from — `durable-object-region-routing`
  // rejects raw namespace access, so guarding it guards everything the lint
  // rule allows. The self-aware resolvers have already answered locally by the
  // time they call this, so what this catches is a caller that skipped them.
  refuseSelfAddressedStub(env, namespace, id, "region", name);
  return isLocalEnvironment(environment)
    ? regionalNamespace.get(id)
    : regionalNamespace.get(id, { locationHint });
}

/**
 * Resolve an object this region already has, by its Durable Object ID.
 *
 * The only resolver here that does not start from a name, and the only one a
 * caller should reach for when it holds an ID instead: the forced-migration
 * consumer is handed object IDs by the tracker, whose inventory sweep reads
 * them from Cloudflare's account API and never learns the names behind them.
 *
 * The ID is parsed through the same jurisdiction-restricted namespace that
 * minted it. `idFromString` validates the ID against the namespace it is called
 * on, so parsing a regional object's ID through the unrestricted namespace is the
 * kind of mistake that surfaces as a confusing throw at `get()` rather than
 * here — and in production `assertDurableObjectJurisdiction` inside the object
 * would refuse it anyway.
 *
 * No location hint, deliberately. A hint is only considered on an object's
 * first lookup, and an object that has an ID in the account has already had one.
 */
export function durableObjectStubById<T extends RpcDurableObject | undefined = undefined>(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION"> & SelfAddressReportEnv,
  namespace: DurableObjectNamespace<T>,
  objectId: string,
): DurableObjectStub<T> {
  const regionalNamespace = durableObjectNamespaceForRegion(
    namespace,
    env.AVALON_REGION,
    env.APP_ENV,
  );
  const id = regionalNamespace.idFromString(objectId);
  const self = durableObjectSelfForId(env, namespace, id);
  if (self) return self;
  // No `refuseSelfAddressedStub` here, unlike `durableObjectStubForRegion`.
  // The two predicates are the same walk of the same registrations, so a
  // refusal below a self-check that already returned is unreachable by
  // construction — and unreachable code that looks like a guard is worse than
  // no guard, because the next reader counts it as one. The refusal belongs
  // where nothing has answered locally first, which is that resolver.
  return regionalNamespace.get(id);
}

/** Resolve a regional singleton that has no parent workspace affinity. */
export function durableObjectStubForRegionalSingleton<
  T extends RpcDurableObject | undefined = undefined,
>(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION"> & SelfAddressReportEnv,
  namespace: DurableObjectNamespace<T>,
  name: string,
): DurableObjectStub<T> {
  const self = durableObjectSelfForId(
    env,
    namespace,
    durableObjectIdForRegion(namespace, env.AVALON_REGION, name, env.APP_ENV),
  );
  if (self) return self;
  return durableObjectStubForRegion(
    env,
    namespace,
    env.AVALON_REGION,
    name,
    fallbackWorkspacePlacementAffinity(env.AVALON_REGION),
  );
}

/**
 * Resolve a live web artifact's supervisor, which is region-scoped but not
 * workspace-addressed.
 *
 * The third supported resolver, and it exists because the artifact host is the
 * one object whose *name carries no workspace segment*. The serving Worker
 * resolves a public hostname stub through platform D1 to the UUID this
 * resolver receives. That rules out {@link durableObjectStubForWorkspace},
 * which reads the workspace's placement affinity from D1, and there is no
 * singleton here for {@link durableObjectStubForRegionalSingleton}: one object
 * per artifact.
 *
 * **The fallback hint is correct rather than merely tolerable, and that is
 * worth stating because it looks like a compromise.** Cloudflare honours a
 * location hint only on an object's *first* lookup, and an artifact object's
 * first lookup is at publish, from the API Worker, which resolves it through
 * this same function while holding the workspace's real affinity — passed as
 * `preferredAffinity`. Every later call, including every one the serving Worker
 * makes, reaches an object that is already placed, so the hint it passes is
 * ignored by the platform. Get this backwards and artifact objects are minted a
 * continent away from the work streams they check visibility against.
 *
 * Jurisdiction is not relaxed: this goes through the same region-restricted
 * namespace as everything else, which is the property the region-routing lint
 * rule exists to protect.
 */
export function durableObjectStubForArtifact<T extends RpcDurableObject | undefined = undefined>(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION"> & SelfAddressReportEnv,
  namespace: DurableObjectNamespace<T>,
  name: string,
  preferredAffinity?: WorkspacePlacementAffinity,
): DurableObjectStub<T> {
  const self = durableObjectSelfForId(
    env,
    namespace,
    durableObjectIdForRegion(namespace, env.AVALON_REGION, name, env.APP_ENV),
  );
  if (self) return self;
  return durableObjectStubForRegion(
    env,
    namespace,
    env.AVALON_REGION,
    name,
    preferredAffinity ?? fallbackWorkspacePlacementAffinity(env.AVALON_REGION),
  );
}

/**
 * Resolve a workspace-scoped object with the affinity selected when its parent
 * workspace was created. The regional D1 row is an immutable routing
 * projection; a per-isolate cache removes repeated reads without introducing a
 * second mutable authority.
 */
export async function workspacePlacementAffinity(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION" | "DB">,
  workspaceId: string,
): Promise<WorkspacePlacementAffinity> {
  if (!env.DB || (typeof env.DB !== "object" && typeof env.DB !== "function")) {
    if (env.APP_ENV === "production" || env.APP_ENV === "staging") {
      throw new Error("workspace_placement_database_unavailable");
    }
    return fallbackWorkspacePlacementAffinity(env.AVALON_REGION);
  }
  let databaseCache = placementCache.get(env.DB);
  if (!databaseCache) {
    databaseCache = new Map();
    placementCache.set(env.DB, databaseCache);
  }
  const key = `${env.AVALON_REGION}:${workspaceId}`;
  const cached = databaseCache.get(key);
  if (cached) return cached;

  let affinity: WorkspacePlacementAffinity;
  try {
    const row = await env.DB.prepare(
      "SELECT placement_affinity FROM workspaces WHERE id = ? AND region = ?",
    ).bind(workspaceId, env.AVALON_REGION).first<{ placement_affinity: string }>();
    if (!row || !isWorkspacePlacementAffinityForRegion(env.AVALON_REGION, row.placement_affinity)) {
      throw new Error("workspace_placement_affinity_unavailable");
    }
    affinity = row.placement_affinity;
  } catch (error) {
    // Focused unit doubles and pre-migration local databases do not always
    // expose the routing column. Production and staging fail closed so an
    // orphan child can never win first placement from an arbitrary caller.
    if (env.APP_ENV === "production" || env.APP_ENV === "staging") throw error;
    return fallbackWorkspacePlacementAffinity(env.AVALON_REGION);
  }
  // D1 promises belong to the initiating request. A cancelled request can
  // leave one pending forever; other requests must never inherit its I/O.
  // Cache only the immutable value, after this request's read completes.
  if (!databaseCache.has(key) && databaseCache.size >= WORKSPACE_PLACEMENT_CACHE_LIMIT) {
    const oldest = databaseCache.keys().next().value;
    if (oldest) databaseCache.delete(oldest);
  }
  databaseCache.set(key, affinity);
  return affinity;
}

export async function durableObjectStubForWorkspace<
  T extends RpcDurableObject | undefined = undefined,
>(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION" | "DB"> & SelfAddressReportEnv,
  namespace: DurableObjectNamespace<T>,
  workspaceId: string,
  name: string,
  affinity?: WorkspacePlacementAffinity,
): Promise<DurableObjectStub<T>> {
  // Before the affinity read, because an object addressing itself must not
  // depend on a D1 row to find the storage it is already holding. Deriving the
  // id is a hash and no I/O, so it stays on this side of that rule.
  const self = durableObjectSelfForId(
    env,
    namespace,
    durableObjectIdForRegion(namespace, env.AVALON_REGION, name, env.APP_ENV),
  );
  if (self) return self;
  const selected = affinity ?? await workspacePlacementAffinity(env, workspaceId);
  if (!isWorkspacePlacementAffinityForRegion(env.AVALON_REGION, selected)) {
    throw new Error(`workspace_placement_affinity_mismatch:${env.AVALON_REGION}:${selected}`);
  }
  return durableObjectStubForRegion(
    env,
    namespace,
    env.AVALON_REGION,
    name,
    selected,
  );
}

/**
 * Production objects fail closed when a binding bypass or malformed ID reaches
 * the wrong jurisdiction. Local workerd cannot create jurisdictional IDs, so
 * development and test deliberately skip this runtime assertion.
 */
export function assertDurableObjectJurisdiction(
  id: DurableObjectId,
  region: Region,
  environment: AvalonEnvironment | undefined,
): void {
  if (environment !== "production" && environment !== "staging") return;
  const expected = regionConfiguration(region).jurisdiction;
  if (id.jurisdiction !== expected) {
    throw new Error(`durable_object_jurisdiction_mismatch:${expected}:${id.jurisdiction ?? "none"}`);
  }
}
