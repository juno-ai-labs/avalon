/**
 * The wiring that gives the artifact data tools a work stream to read from.
 *
 * It lives beside the tools rather than inside them so that module stays a pure
 * contract with no `Env` and no routing rules: what a model sees on failure,
 * what a result looks like, and which sites are unreachable are all testable
 * without a Cloudflare binding in sight. Everything that *is* environment —
 * resolving a slug through the same visibility loader every attachment tool
 * uses, and reaching the supervisor through the one supported resolver — is
 * here.
 *
 * See `docs/live-web-artifacts.md`.
 */
import { asArtifactId, type ExecutionPrincipal } from "@rally/contracts";

import { artifactHostDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { createConversationResourceLinks } from "../runtime/resource-port";
import { loadVisibleWorkstreamResourcesByIds } from "./workstream-resource-visibility";
import { durableObjectStubForArtifact, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import type {
  ArtifactDataHost,
  ArtifactDataToolContext,
  ResolvedArtifact,
} from "./workstream-artifact-data-tools";

export interface ArtifactDataWiringInput {
  workspaceId: string;
  workstreamId: string;
  principal: ExecutionPrincipal;
}

export function createArtifactDataToolContext(
  env: Env,
  input: ArtifactDataWiringInput,
): ArtifactDataToolContext {
  return {
    async resolveArtifact(reference: string): Promise<ResolvedArtifact | null> {
      // Resolve the supplied ID or alias, then use the same point authorization
      // as every resource reader. A Sidekick need not have this site attached.
      const candidate = await env.DB.prepare(
        "SELECT id FROM resources WHERE workspace_id = ? AND (id = ? OR slug = ?) AND resource_type = 'generated_site'",
      ).bind(input.workspaceId, reference, reference).first<{ id: string }>();
      if (!candidate) return null;
      const [match] = await loadVisibleWorkstreamResourcesByIds(
        env.DB,
        createConversationResourceLinks(env, input.workspaceId, input.workstreamId, undefined, undefined, input.principal),
        {
          workspaceId: input.workspaceId,
          workstreamId: input.workstreamId,
          principal: input.principal,
          resourceIds: [candidate.id],
        },
      );
      if (!match) return null;
      // Read from the registry rather than the resource row: what an artifact
      // *is* — its id, its mode, whether it keeps data — lives there, and the
      // resource row deliberately records only what the path published as.
      const row = await env.DB.prepare(
        `SELECT artifact_id, mode, stateful FROM artifact_registry
          WHERE workspace_id = ? AND resource_id = ?`,
      ).bind(input.workspaceId, match.id).first<{
        artifact_id: string;
        mode: string;
        stateful: number;
      }>();
      if (!row) return null;
      return {
        artifactId: row.artifact_id,
        slug: match.slug,
        mode: row.mode === "active" ? "active" : "static",
        stateful: row.stateful === 1,
      };
    },

    async hostFor(artifactId: string): Promise<ArtifactDataHost> {
      const affinity = await workspacePlacementAffinity(env, input.workspaceId);
      return durableObjectStubForArtifact(
        env,
        env.ARTIFACT_HOSTS,
        artifactHostDOName(env.AVALON_REGION, asArtifactId(artifactId)),
        affinity,
      );
    },
  };
}
