import type { Region } from "@avalon/contracts";
import type { DurableObject as RpcDurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { durableObjectSelf } from "./durable-object-self";

type AvalonEnvironment = "development" | "test" | "staging" | "production";

const JURISDICTION_BY_REGION = {
  global: "us",
  eu: "eu",
} as const satisfies Record<Region, DurableObjectJurisdiction>;

/**
 * These are first-placement defaults, not residency guarantees. The
 * jurisdiction above is the guarantee; the hint only keeps a background job
 * from accidentally placing a new object near the job's execution location.
 */
const FALLBACK_LOCATION_HINT_BY_REGION = {
  global: "wnam",
  eu: "weur",
} as const satisfies Record<Region, DurableObjectLocationHint>;

export const WORKSPACE_PLACEMENT_AFFINITIES = ["wnam", "enam", "weur", "eeur"] as const;
export type WorkspacePlacementAffinity = (typeof WORKSPACE_PLACEMENT_AFFINITIES)[number];

export interface WorkspacePlacementDecision {
  affinity: WorkspacePlacementAffinity;
  source: "request_longitude" | "missing_request_metadata";
}

const WEST_EAST_LONGITUDE_SPLIT = {
  // The 100th meridian is the conventional coarse split between western and
  // eastern North America for a two-cell latency affinity.
  global: -100,
  // 15°E keeps the UK, Ireland, France, Benelux, Iberia, Italy, and most of
  // Germany in WEUR while routing the eastern half of Europe toward EEUR.
  eu: 15,
} as const satisfies Record<Region, number>;

const AFFINITIES_BY_REGION = {
  global: ["wnam", "enam"],
  eu: ["weur", "eeur"],
} as const satisfies Record<Region, readonly WorkspacePlacementAffinity[]>;

const placementCache = new WeakMap<D1Database, Map<string, Promise<WorkspacePlacementAffinity>>>();
const WORKSPACE_PLACEMENT_CACHE_LIMIT = 1_024;

export function fallbackWorkspacePlacementAffinity(region: Region): WorkspacePlacementAffinity {
  return FALLBACK_LOCATION_HINT_BY_REGION[region];
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
    && (AFFINITIES_BY_REGION[region] as readonly string[]).includes(value);
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
  if (region === "global") {
    return {
      affinity: longitude < WEST_EAST_LONGITUDE_SPLIT.global ? "wnam" : "enam",
      source: "request_longitude",
    };
  }
  return {
    affinity: longitude < WEST_EAST_LONGITUDE_SPLIT.eu ? "weur" : "eeur",
    source: "request_longitude",
  };
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
  return namespace.jurisdiction(JURISDICTION_BY_REGION[region]);
}

/**
 * The only supported resolver for Avalon product Durable Objects.
 *
 * Jurisdiction must be selected before deriving the name-based ID because the
 * same name identifies different objects in unrestricted, US, and EU
 * namespaces. Every possible first `get()` also carries a location hint;
 * Cloudflare only considers that option on the first lookup for an object.
 */
export function durableObjectStubForRegion<T extends RpcDurableObject | undefined = undefined>(
  namespace: DurableObjectNamespace<T>,
  region: Region,
  name: string,
  environment: AvalonEnvironment,
  locationHint: DurableObjectLocationHint,
): DurableObjectStub<T> {
  const regionalNamespace = durableObjectNamespaceForRegion(namespace, region, environment);
  const id = regionalNamespace.idFromName(name);
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
 * on, so parsing an EU object's ID through the unrestricted namespace is the
 * kind of mistake that surfaces as a confusing throw at `get()` rather than
 * here — and in production `assertDurableObjectJurisdiction` inside the object
 * would refuse it anyway.
 *
 * No location hint, deliberately. A hint is only considered on an object's
 * first lookup, and an object that has an ID in the account has already had one.
 */
export function durableObjectStubById<T extends RpcDurableObject | undefined = undefined>(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION">,
  namespace: DurableObjectNamespace<T>,
  objectId: string,
): DurableObjectStub<T> {
  const regionalNamespace = durableObjectNamespaceForRegion(
    namespace,
    env.AVALON_REGION,
    env.APP_ENV,
  );
  return regionalNamespace.get(regionalNamespace.idFromString(objectId));
}

/** Resolve a regional singleton that has no parent workspace affinity. */
export function durableObjectStubForRegionalSingleton<
  T extends RpcDurableObject | undefined = undefined,
>(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION">,
  namespace: DurableObjectNamespace<T>,
  name: string,
): DurableObjectStub<T> {
  const self = durableObjectSelf(env, namespace, name);
  if (self) return self;
  return durableObjectStubForRegion(
    namespace,
    env.AVALON_REGION,
    name,
    env.APP_ENV,
    fallbackWorkspacePlacementAffinity(env.AVALON_REGION),
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

  const pending = (async () => {
    try {
      const row = await env.DB.prepare(
        "SELECT placement_affinity FROM workspaces WHERE id = ? AND region = ?",
      ).bind(workspaceId, env.AVALON_REGION).first<{ placement_affinity: string }>();
      if (!row || !isWorkspacePlacementAffinityForRegion(env.AVALON_REGION, row.placement_affinity)) {
        throw new Error("workspace_placement_affinity_unavailable");
      }
      return row.placement_affinity;
    } catch (error) {
      // Focused unit doubles and pre-migration local databases do not always
      // expose the routing column. Production and staging fail closed so an
      // orphan child can never win first placement from an arbitrary caller.
      if (env.APP_ENV === "production" || env.APP_ENV === "staging") throw error;
      return fallbackWorkspacePlacementAffinity(env.AVALON_REGION);
    }
  })();
  if (databaseCache.size >= WORKSPACE_PLACEMENT_CACHE_LIMIT) {
    const oldest = databaseCache.keys().next().value;
    if (oldest) databaseCache.delete(oldest);
  }
  databaseCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    databaseCache.delete(key);
    throw error;
  }
}

export async function durableObjectStubForWorkspace<
  T extends RpcDurableObject | undefined = undefined,
>(
  env: Pick<Env, "APP_ENV" | "AVALON_REGION" | "DB">,
  namespace: DurableObjectNamespace<T>,
  workspaceId: string,
  name: string,
  affinity?: WorkspacePlacementAffinity,
): Promise<DurableObjectStub<T>> {
  // Before the affinity read, because an object addressing itself must not
  // depend on a D1 row to find the storage it is already holding.
  const self = durableObjectSelf(env, namespace, name);
  if (self) return self;
  const selected = affinity ?? await workspacePlacementAffinity(env, workspaceId);
  if (!isWorkspacePlacementAffinityForRegion(env.AVALON_REGION, selected)) {
    throw new Error(`workspace_placement_affinity_mismatch:${env.AVALON_REGION}:${selected}`);
  }
  return durableObjectStubForRegion(
    namespace,
    env.AVALON_REGION,
    name,
    env.APP_ENV,
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
  const expected = JURISDICTION_BY_REGION[region];
  if (id.jurisdiction !== expected) {
    throw new Error(`durable_object_jurisdiction_mismatch:${expected}:${id.jurisdiction ?? "none"}`);
  }
}
