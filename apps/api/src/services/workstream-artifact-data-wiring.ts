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
import { loadVisibleWorkstreamResourcePage } from "./workstream-resource-visibility";
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

/**
 * How many site resources one work stream's lookup considers.
 *
 * A page size rather than a defensive bound: the loader is paged, and this is
 * the page the reference is matched against. Sites are a handful per work
 * stream, so one page is the whole set in practice; a work stream that somehow
 * exceeded it would fail a lookup rather than reach a wrong artifact, because
 * the match is by exact id or slug.
 */
const SITE_LOOKUP_PAGE = 50;

export function createArtifactDataToolContext(
  env: Env,
  input: ArtifactDataWiringInput,
): ArtifactDataToolContext {
  return {
    async resolveArtifact(reference: string): Promise<ResolvedArtifact | null> {
      // The same visibility loader every attachment tool uses, filtered to the
      // one kind that can have data. Going through it rather than querying here
      // is what makes nonexistent, foreign, and invisible references collapse
      // to one answer — the property that keeps these tools from being an
      // existence oracle.
      const page = await loadVisibleWorkstreamResourcePage(
        env.DB,
        createConversationResourceLinks(env, input.workspaceId, input.workstreamId, undefined, undefined, input.principal),
        {
          workspaceId: input.workspaceId,
          workstreamId: input.workstreamId,
          principal: input.principal,
          attachmentKind: "site",
          limit: SITE_LOOKUP_PAGE,
        },
      );
      const match = page.rows.find((row) => row.id === reference || row.slug === reference);
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
