/**
 * Minting one person's access to one live artifact.
 *
 * This is the only door into an artifact origin, and it is the place work-stream
 * visibility is checked *at open time* — the supervisor object re-checks it on
 * every request afterwards, because a grant frozen at open is exactly the
 * regression `access-revocation.md` records.
 *
 * **What it returns is a URL whose code lives in the fragment.** A fragment is
 * never sent to a server, so the proof stays out of Cloudflare's invocation log,
 * the Logpush export, and every trace span — none of which any redaction in this
 * repository reaches. The caller navigates to it; a Rally-served bootstrap page
 * on the artifact's own origin reads the fragment, clears it from the address
 * bar, and posts the code in a request body to an endpoint that never serves
 * artifact content.
 *
 * See `docs/live-web-artifacts.md` and `docs/security.md`.
 */
import {
  ARTIFACT_RESERVED_PREFIX,
  artifactOrigin,
  asArtifactId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";

import { artifactHostDOName, workstreamDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  durableObjectStubForArtifact,
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";

export interface ArtifactOpenResult {
  /** Navigate here. The single-use code is the fragment. */
  openUrl: string;
  /** The address to copy or cite: no code, and always the newest version. */
  canonicalUrl: string;
  artifactId: string;
  mode: "static" | "active";
  stateful: boolean;
}

export class ArtifactOpenService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  /**
   * Authorize one viewer and mint their access.
   *
   * The two checks are deliberately separate authorities, and neither
   * substitutes for the other: the registry says which artifact a resource is,
   * and `WorkstreamDO` — which owns visibility in its own SQL — says whether
   * this person may see the work stream it belongs to. A resource the caller
   * cannot see and one that does not exist produce the same answer, so this
   * endpoint is not an existence oracle.
   */
  async open(resourceId: string): Promise<ArtifactOpenResult> {
    const workspaceId = this.auth.workspaceId;
    if (!workspaceId) throw new ApiError(403, "workspace_required", "Choose a workspace before opening an artifact.");
    const row = await this.env.DB.prepare(
      `SELECT artifact_id, workstream_id, mode, stateful FROM artifact_registry
        WHERE workspace_id = ? AND resource_id = ?`,
    ).bind(workspaceId, resourceId).first<{
      artifact_id: string;
      workstream_id: string;
      mode: string;
      stateful: number;
    }>();
    if (!row) throw new ApiError(404, "artifact_not_found", "That artifact does not exist here.");

    const workspace = asWorkspaceId(workspaceId);
    const workstreamId = asWorkstreamId(row.workstream_id);
    const affinity = await workspacePlacementAffinity(this.env, workspaceId);
    const workstream = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      workspace,
      workstreamDOName(this.env.AVALON_REGION, workspace, workstreamId),
      affinity,
    );
    // Asked rather than inferred. Work-stream visibility is not a D1 fact — it
    // lives in that object's own SQL — so no query here could answer it, and
    // inferring it from resource visibility would be a second authority.
    if (!await workstream.canReadWorkstream(asUserId(this.auth.userId))) {
      // The same answer a nonexistent artifact gets: knowing an identifier
      // grants nothing, and distinguishing the two would leak which artifacts
      // exist in work streams the caller cannot see.
      throw new ApiError(404, "artifact_not_found", "That artifact does not exist here.");
    }

    const host = durableObjectStubForArtifact(
      this.env,
      this.env.ARTIFACT_HOSTS,
      artifactHostDOName(this.env.AVALON_REGION, asArtifactId(row.artifact_id)),
      affinity,
    );
    const { code } = await host.openForViewer({
      userId: this.auth.userId,
      // Carried so a single revoked session drops only the windows that
      // presented it, rather than every window this person has open.
      appSessionId: this.auth.sessionId ?? null,
      // Read here rather than carried on the auth context: the artifact needs a
      // name to attribute a vote to, and the session that authorized the open
      // carries only the identity, not the profile.
      displayName: await this.displayName(),
    });

    const origin = artifactOrigin(
      row.artifact_id,
      this.env.AVALON_REGION,
      this.env.ARTIFACT_SERVING_DOMAIN,
    );
    return {
      // The code is the fragment and nothing else. Everything before the `#`
      // is loggable; everything after it never leaves the browser.
      openUrl: `${origin}${ARTIFACT_RESERVED_PREFIX}/open#${code}`,
      canonicalUrl: origin,
      artifactId: row.artifact_id,
      mode: row.mode === "active" ? "active" : "static",
      stateful: row.stateful === 1,
    };
  }

  /**
   * The viewer's display name, as artifact code will show it.
   *
   * Empty rather than absent when the row has none: the header is present for
   * every authenticated viewer, and its *absence* is reserved to mean an
   * anonymous one — a meaning a missing profile must not accidentally claim.
   */
  private async displayName(): Promise<string> {
    const row = await this.env.DB.prepare(`SELECT name FROM users WHERE id = ?`)
      .bind(this.auth.userId).first<{ name: string | null }>();
    return row?.name ?? "";
  }

  /** What the model's server module threw, for the rail's error log. */
  async errors(resourceId: string): Promise<{
    occurredAt: number;
    version: number;
    requestPath: string;
    message: string;
    stack: string | null;
  }[]> {
    // Through `open`, so reading the log needs the same visibility as opening
    // the artifact: an error log names request paths a page defines, and is not
    // something to hand to somebody who may not see the work stream.
    const opened = await this.open(resourceId);
    const host = durableObjectStubForArtifact(
      this.env,
      this.env.ARTIFACT_HOSTS,
      artifactHostDOName(this.env.AVALON_REGION, asArtifactId(opened.artifactId)),
      await workspacePlacementAffinity(this.env, this.auth.workspaceId),
    );
    return await host.readErrors();
  }
}
