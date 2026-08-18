import type { Region } from "@avalon/contracts";
import type { DurableObject as RpcDurableObject } from "cloudflare:workers";

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
const LOCATION_HINT_BY_REGION = {
  global: "wnam",
  eu: "weur",
} as const satisfies Record<Region, DurableObjectLocationHint>;

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
  locationHint: DurableObjectLocationHint = LOCATION_HINT_BY_REGION[region],
): DurableObjectStub<T> {
  const regionalNamespace = durableObjectNamespaceForRegion(namespace, region, environment);
  const id = regionalNamespace.idFromName(name);
  return isLocalEnvironment(environment)
    ? regionalNamespace.get(id)
    : regionalNamespace.get(id, { locationHint });
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
