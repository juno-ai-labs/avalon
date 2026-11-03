/**
 * Which organization and resource a site's hostname belongs to, for someone
 * signing in from the site itself.
 *
 * The browser client's site-opening page knows only the hostname it was sent
 * from. The platform route table maps that to an artifact and deliberately
 * holds no workspace, so the artifact's own supervisor supplies the workspace
 * and resource it was published under. Ordinary resource authorization then
 * decides whether this person may read it, so the answer is the same 404 for
 * a site that does not exist and one they cannot see.
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
  const notFound = () => new ApiError(404, "site_not_found", "This site does not exist, or you do not have access to it.");
  const artifactId = await resolveArtifactHostname(env, hostnameStub);
  if (!artifactId) throw notFound();
  const state = await durableObjectStubForArtifact(
    env,
    env.ARTIFACT_HOSTS,
    artifactHostDOName(env.AVALON_REGION, asArtifactId(artifactId)),
  ).currentState();
  if (!state) throw notFound();
  await new AuthorizationService(env)
    .readResource({ workspaceId: asWorkspaceId(state.workspaceId), userId: asUserId(userId), delegation: null }, state.resourceId)
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    });
  return { workspaceId: state.workspaceId, resourceId: state.resourceId };
}
