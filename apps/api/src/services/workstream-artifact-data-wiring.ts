/**
 * The wiring that gives the artifact data tools a work stream to read from,
 * and decides which runs may write (`artifactDataWriteAccess`).
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
import { asArtifactId, asWorkspaceId, IdSchema, type ExecutionPrincipal } from "@rally/contracts";

import { artifactHostDOName, workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { createConversationResourceLinks } from "../runtime/resource-port";
import { loadVisibleWorkstreamResourcesByIds } from "./workstream-resource-visibility";
import {
  durableObjectStubForArtifact,
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { artifactRowScope } from "../artifacts/read-only-sql";
import type {
  ArtifactDataHost,
  ArtifactDataToolContext,
  ResolvedArtifact,
  WritableArtifactResolution,
} from "./workstream-artifact-data-tools";

/**
 * Who a run reads a site's data as: the member sending the input that
 * continues a Sidekick run, `null` for an unattended Sidekick run or a
 * background agent one started, and otherwise the user the run runs as.
 */
export function artifactDataReader(input: {
  executionPrincipal: { type: string; userId?: string | undefined };
  automationRun?: unknown;
  automationDelegation?: unknown;
  automationContinuation?: { senderUserId?: string | undefined } | undefined;
}): string | null {
  if (input.automationContinuation) return input.automationContinuation.senderUserId ?? null;
  if (input.automationRun || input.automationDelegation) return null;
  return input.executionPrincipal.type === "user" ? input.executionPrincipal.userId ?? null : null;
}

/**
 * Which runs may change a site's rows with `write_artifact_data`, or null for
 * a run that is not offered the tool at all.
 *
 * - A Canvas's Chat (parent kind `canvas`, conversation `"0"`, a person's
 *   principal): the sites linked to that Canvas, which is what its reads
 *   resolve already.
 * - A Sidekick run (`automationRun` present): the sites of Canvases attached
 *   to that Sidekick, which WorkspaceDO answers per site.
 *
 * Everyone else gets null: a Sidekick's wizard conversation, a background
 * agent, a loop under Organization authority, and any other parent kind. The
 * answer is host-derived from the loop input, in the style of
 * `conversationToolAccess`; no model argument reaches it.
 */
export type ArtifactDataWriteAccess =
  | { kind: "canvas_chat" }
  | { kind: "sidekick_run"; sidekickId: string };

export function artifactDataWriteAccess(input: {
  executionPrincipal: { type: string };
  parentKind: string;
  substreamId?: string | undefined;
  automationRun?: { automationId: string } | undefined;
  automationDelegation?: unknown;
  backgroundAgent?: boolean | undefined;
}): ArtifactDataWriteAccess | null {
  if (input.executionPrincipal.type !== "user") return null;
  if (input.backgroundAgent === true || input.automationDelegation) return null;
  if (input.automationRun) {
    return input.parentKind === "automation"
      ? { kind: "sidekick_run", sidekickId: input.automationRun.automationId }
      : null;
  }
  if (input.parentKind !== "canvas") return null;
  return (input.substreamId ?? "0") === "0" ? { kind: "canvas_chat" } : null;
}

export interface ArtifactDataWiringInput {
  workspaceId: string;
  workstreamId: string;
  principal: ExecutionPrincipal;
  /**
   * The person this run reads as, or `null` for an unattended run (a Sidekick
   * run nobody is typing into, a background agent one started, an
   * Organization principal), which reads every row because its job is
   * usually the whole data set: a digest, a tally, a refresh. A member typing
   * into a Sidekick's wizard or run reads as that member.
   */
  reader: string | null;
  /**
   * Whether this run may write, from {@link artifactDataWriteAccess}. Left out
   * or null, the context resolves nothing for a write and the write tool is
   * not built.
   */
  write?: ArtifactDataWriteAccess | null;
}

export function createArtifactDataToolContext(
  env: Env,
  input: ArtifactDataWiringInput,
): ArtifactDataToolContext {
  /** The site a reference names, if the run's own visibility admits it; shared by reads and writes. */
  async function visibleSite(reference: string) {
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
    return match && match.resource_type === "generated_site" ? match : null;
  }
  /** Whose rows this run touches on a site; the resource row records who the publishing run ran as. */
  function scopeOn(site: Record<string, unknown>) {
    const author = typeof site.uploaded_by_user_id === "string" ? site.uploaded_by_user_id : null;
    return artifactRowScope(input.reader, author);
  }
  const write = input.write ?? null;

  return {
    async resolveArtifact(reference: string): Promise<ResolvedArtifact | null> {
      const match = await visibleSite(reference);
      if (!match) return null;
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
      return {
        artifactId: row.artifact_id,
        slug: match.slug,
        mode: row.mode === "active" ? "active" : "static",
        stateful: row.stateful === 1,
        scope: scopeOn(match),
      };
    },

    // The gate for a row write. The acting person must be able to read the
    // site, exactly as for a read; then one WorkspaceDO call, taking the place
    // of the registry read above, answers what the artifact is, whether its
    // Canvas is archived, and, for a Sidekick run, whether that Canvas is
    // attached to the Sidekick. A Canvas's Chat writes only a site its own
    // Canvas holds, whatever else is linked to its conversation.
    ...(write ? {
      async resolveWritableArtifact(reference: string): Promise<WritableArtifactResolution> {
        const match = await visibleSite(reference);
        if (!match) return { outcome: "not_found" };
        const workspaceId = asWorkspaceId(input.workspaceId);
        const workspace = await durableObjectStubForWorkspace(
          env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
        const facts = await workspace.artifactDataWriteFacts({
          workspaceId: input.workspaceId,
          resourceId: match.id,
          sidekickId: write.kind === "sidekick_run" ? write.sidekickId : null,
        });
        if (!facts) return { outcome: "not_found" };
        if (facts.canvasArchived) return { outcome: "canvas_archived" };
        if (write.kind === "sidekick_run" && !facts.attachedToSidekick) return { outcome: "not_attached" };
        // A Chat changes its own Canvas's sites. One from another Canvas,
        // attached here as context, is linked to this conversation and so
        // readable, and that link is not leave to write to it.
        if (write.kind === "canvas_chat" && facts.canvasId !== input.workstreamId) return { outcome: "other_canvas" };
        return {
          outcome: "writable",
          artifact: {
            artifactId: facts.artifactId,
            slug: match.slug,
            mode: facts.mode,
            stateful: facts.stateful,
            scope: scopeOn(match),
          },
        };
      },
    } : {}),

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
