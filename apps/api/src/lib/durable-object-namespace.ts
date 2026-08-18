import type { Region } from "@avalon/contracts";
import type { DurableObject as RpcDurableObject } from "cloudflare:workers";

/**
 * EU workspaces must resolve Durable Object IDs through an EU-jurisdiction
 * namespace. Keeping this at the namespace boundary makes it difficult for a
 * caller to accidentally create a globally placed object for EU data.
 */
export function durableObjectNamespaceForRegion<T extends RpcDurableObject | undefined = undefined>(
  namespace: DurableObjectNamespace<T>,
  region: Region,
  environment: "development" | "test" | "staging" | "production" = "production",
): DurableObjectNamespace<T> {
  // workerd/Miniflare currently throws because jurisdiction restrictions are
  // not implemented locally. Keep local EU development functional while the
  // production Worker always resolves EU IDs through the constrained namespace.
  if (environment === "development") return namespace;
  return region === "eu" ? namespace.jurisdiction("eu") : namespace;
}
