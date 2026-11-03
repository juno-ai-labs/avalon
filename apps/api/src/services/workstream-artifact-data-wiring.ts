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
import { asArtifactId, IdSchema, type ExecutionPrincipal } from "@rally/contracts";

import { artifactHostDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { createConversationResourceLinks } from "../runtime/resource-port";
import { loadVisibleWorkstreamResourcesByIds } from "./workstream-resource-visibility";
import { durableObjectStubForArtifact, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { artifactRowScope } from "../artifacts/read-only-sql";
import type {
  ArtifactDataHost,
  ArtifactDataToolContext,
  ResolvedArtifact,
} from "./workstream-artifact-data-tools";

/**
 * Who a run reads a site's data as: `null` (every row) for a Sidekick run or
 * a background agent one started, and otherwise the user the run runs as.
 * People do not type into Sidekick runs, so every one is unattended.
 */
export function artifactDataReader(input: {
  executionPrincipal: { type: string; userId?: string | undefined };
  automationRun?: unknown;
  automationDelegation?: unknown;
}): string | null {
  if (input.automationRun || input.automationDelegation) return null;
  return input.executionPrincipal.type === "user" ? input.executionPrincipal.userId ?? null : null;
}

export interface ArtifactDataWiringInput {
  workspaceId: string;
  workstreamId: string;
  principal: ExecutionPrincipal;
  /**
   * The person this run reads as, or `null` for a Sidekick run, a background
   * agent one started, or an Organization principal, which reads every row
   * because its job is usually the whole data set: a digest, a tally, a
   * refresh. A member typing into a Sidekick's wizard reads as that member.
   */
  reader: string | null;
}

export function createArtifactDataToolContext(
  env: Env,
  input: ArtifactDataWiringInput,
): ArtifactDataToolContext {
  return {
    async resolveArtifact(reference: string): Promise<ResolvedArtifact | null> {
      // Resolve the supplied ID or alias, then use the same point authorization
      // as every resource reader. A Sidekick need not have this site attached.
      const parsedId = IdSchema.safeParse(reference);
      const candidate = parsedId.success ? { id: parsedId.data } : await env.DB.prepare(
        "SELECT id FROM resources WHERE workspace_id = ? AND slug = ? AND resource_type = 'generated_site'",
      ).bind(input.workspaceId, reference).first<{ id: string }>();
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
      if (!match || match.resource_type !== "generated_site") return null;
      // Read from the registry rather than the resource row: what an artifact
      // *is* — its id, its mode, whether it keeps data — lives there, and the
      // resource row deliberately records only what the path published as.
      const row = match.artifact !== undefined ? match.artifact : await env.DB.prepare(
        `SELECT artifact_id, mode, stateful FROM artifact_registry
          WHERE workspace_id = ? AND resource_id = ?`,
      ).bind(input.workspaceId, match.id).first<{
        artifact_id: string;
        mode: string;
        stateful: number;
      }>();
      if (!row) return null;
      // The resource row records who the publishing run ran as.
      const author = typeof match.uploaded_by_user_id === "string" ? match.uploaded_by_user_id : null;
      const scope = artifactRowScope(input.reader, author);
      return {
        artifactId: row.artifact_id,
        slug: match.slug,
        mode: row.mode === "active" ? "active" : "static",
        stateful: row.stateful === 1,
        scope,
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
