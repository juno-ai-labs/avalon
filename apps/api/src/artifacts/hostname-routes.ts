import { ArtifactHostnameRouteSchema } from "@rally/contracts";
import type { Region } from "@rally/contracts/regions";

/**
 * Resolve a public stub through the content-free platform database.
 *
 * The artifact Worker receives this one D1 binding instead of either product
 * region's database. A composite primary key makes the lookup one row and keeps
 * equal stubs in `-g` and a configured suffix independent origins.
 */
export async function resolveArtifactHostname(
  env: { PLATFORM_DB: D1Database; AVALON_REGION: Region },
  hostnameStub: string,
): Promise<string | null> {
  const row = await env.PLATFORM_DB.prepare(
    `SELECT hostname_stub, artifact_id, region FROM artifact_hostname_routes
      WHERE region = ? AND hostname_stub = ?`,
  ).bind(env.AVALON_REGION, hostnameStub).first<{
    hostname_stub: string;
    artifact_id: string;
    region: string;
  }>();
  if (!row) return null;
  const route = ArtifactHostnameRouteSchema.safeParse({
    version: 1,
    hostnameStub: row.hostname_stub,
    artifactId: row.artifact_id,
    region: row.region,
  });
  if (!route.success) return null;
  // Keep the trust decision explicit even though the SQL predicate already
  // names both values: a malformed or misbound index must never turn this
  // regional Worker into a cross-region artifact resolver.
  if (route.data.region !== env.AVALON_REGION || route.data.hostnameStub !== hostnameStub) return null;
  return route.data.artifactId;
}
