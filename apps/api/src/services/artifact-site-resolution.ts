/**
 * Which organization and resource a site's hostname belongs to, for someone
 * signing in from the site itself.
 *
 * The browser client's site-opening page knows only the hostname it was sent
 * from. The platform route table maps that to an artifact and deliberately
 * holds no workspace, so the artifact's own supervisor supplies the workspace
 * and resource it was published under. Ordinary resource authorization then
 * decides whether this person may read it: 404 for a site that does not
 * exist, 403 for one that does and they cannot read.
 *
 * See `docs/live-web-artifacts.md`.
 */
import { asArtifactId, asUserId, asWorkspaceId } from "@rally/contracts";

import { resolveArtifactHostname } from "../artifacts/hostname-routes";
import { artifactHostDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForArtifact } from "../lib/durable-object-namespace";
import { AuthorizationService } from "./authorization-service";

export async function resolveSiteForViewer(
  env: Env,
  userId: string,
  hostnameStub: string,
): Promise<{ workspaceId: string; resourceId: string }> {
  const notFound = () => new ApiError(404, "site_not_found", "This site does not exist.");
  const artifactId = await resolveArtifactHostname(env, hostnameStub);
  if (!artifactId) throw notFound();
  const state = await durableObjectStubForArtifact(
    env,
    env.ARTIFACT_HOSTS,
    artifactHostDOName(env.AVALON_REGION, asArtifactId(artifactId)),
  ).currentState();
  if (!state) throw notFound();
  const [decision] = await new AuthorizationService(env).checkMany(
    { workspaceId: asWorkspaceId(state.workspaceId), userId: asUserId(userId), delegation: null },
    [{ kind: "resource", workspaceId: asWorkspaceId(state.workspaceId), resourceId: state.resourceId }],
  );
  if (decision?.status === "unavailable") {
    throw new ApiError(503, "authorization_unavailable", "Rally could not check your access just now. Try again.");
  }
  if (decision?.status === "not_found") throw notFound();
  if (decision?.status !== "allowed") {
    throw new ApiError(403, "site_access_denied", "This site exists, but your account doesn't have access to it.");
  }
  return { workspaceId: state.workspaceId, resourceId: state.resourceId };
}
