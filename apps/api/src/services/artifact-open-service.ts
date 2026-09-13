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
  ArtifactHostnameStubSchema,
  artifactOrigin,
  asArtifactId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";

import { artifactHostDOName, workstreamDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { ensureArtifactHostname } from "./artifact-hostname";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
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
  private readonly env: Env;
  private readonly regionalEnv: Env;

  /**
   * `artifact_registry` lives in **WorkspaceDO**, not regional D1.
   *
   * Without this wrap every statement naming it falls through to D1, which has
   * no such table, and every door into an artifact origin answers a 500 — the
   * open endpoint, the Data view, the table page, and the error log alike.
   * `users` is not a workspace-local table, so the display-name read still
   * takes the regional fallthrough on the same handle.
   */
  constructor(env: Env, private readonly auth: AuthContext) {
    this.regionalEnv = env;
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
  }

  /**
   * Resolve an artifact and authorize its current viewer.
   *
   * The two checks are deliberately separate authorities, and neither
   * substitutes for the other: the registry says which artifact a resource is,
   * and `WorkstreamDO` — which owns visibility in its own SQL — says whether
   * this person may see the work stream it belongs to. A resource the caller
   * cannot see and one that does not exist produce the same answer, so this
   * endpoint is not an existence oracle.
   */
  private async resolveAuthorized(resourceId: string) {
    const workspaceId = this.auth.workspaceId;
    if (!workspaceId) throw new ApiError(403, "workspace_required", "Choose a workspace before opening an artifact.");
    const row = await this.env.DB.prepare(
      `SELECT artifact_id, workstream_id, mode, stateful, hostname_stub FROM artifact_registry
        WHERE workspace_id = ? AND resource_id = ?`,
    ).bind(workspaceId, resourceId).first<{
      artifact_id: string;
      workstream_id: string;
      mode: string;
      stateful: number;
      hostname_stub: string | null;
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
    return { row, host };
  }

  /**
   * Authorize a navigation and mint its single-use viewer grant.
   *
   * Inspection callers use `resolveAuthorized` alone because they neither need
   * a migrated hostname nor a viewer session. Keeping those effects here
   * prevents a read of artifact data or errors from creating a grant nobody
   * will redeem.
   */
  async open(resourceId: string): Promise<ArtifactOpenResult> {
    const { row, host } = await this.resolveAuthorized(resourceId);
    const workspaceId = this.auth.workspaceId;
    // Pre-stub artifacts are migrated lazily, but only after the ordinary
    // visibility check. The platform-D1 reservation is durable before the
    // WorkspaceDO registry starts returning the public address.
    const hostnameStub = row.hostname_stub === null
      ? await ensureArtifactHostname(
          this.regionalEnv,
          { workspaceId, artifactId: row.artifact_id },
        )
      : ArtifactHostnameStubSchema.parse(row.hostname_stub);
    if (row.hostname_stub === null) {
      await this.env.DB.prepare(
        `UPDATE artifact_registry SET hostname_stub = ?
          WHERE workspace_id = ? AND artifact_id = ? AND hostname_stub IS NULL`,
      ).bind(hostnameStub, workspaceId, row.artifact_id).run();
    }

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
      hostnameStub,
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

  /**
   * The tables a stateful artifact keeps, for the rail's **Data** view.
   *
   * Behind the same visibility as opening, because these rows are work-stream
   * content: they were written by the page's visitors.
   */
  async describeData(resourceId: string): Promise<{
    tables: { name: string; columns: { name: string; type: string }[]; rowCount: number }[];
  }> {
    const { row, host } = await this.resolveAuthorized(resourceId);
    if (row.stateful !== 1) return { tables: [] };
    return await host.describeData();
  }

  /**
   * One page of one table, as rows and as CSV.
   *
   * Both shapes come from one read so the export can never disagree with what
   * the view showed. The table name is admitted against the live schema inside
   * the facet, never interpolated here.
   */
  async pageData(resourceId: string, table: string, offset: number): Promise<{
    rows: Record<string, unknown>[];
    csv: string;
  }> {
    const { row, host } = await this.resolveAuthorized(resourceId);
    if (row.stateful !== 1) return { rows: [], csv: "" };
    const page = await host.pageData(table, offset, DATA_PAGE_ROWS);
    if (!page.ok) {
      throw new ApiError(404, "artifact_table_not_found", "That table is not part of this site's data.");
    }
    return { rows: page.rows, csv: toCsv(page.rows) };
  }

  /** What the model's server module threw, for the rail's error log. */
  async errors(resourceId: string): Promise<{
    occurredAt: number;
    version: number;
    requestPath: string;
    message: string;
    stack: string | null;
  }[]> {
    // The same registry and parent authorization as navigation, without
    // minting a browser bootstrap code that this read never consumes.
    const { host } = await this.resolveAuthorized(resourceId);
    return await host.readErrors();
  }
}

/** How many rows one Data-view page holds. Matches the facet's own bound. */
const DATA_PAGE_ROWS = 200;

/**
 * Render rows as CSV, quoting every field.
 *
 * Quoted unconditionally rather than only where a comma appears, because these
 * are **model-designed columns holding visitor-written values**: deciding
 * per-field which need quoting is a decision that gets one case wrong, and the
 * wrong case is a value that breaks a row apart in a spreadsheet.
 *
 * A leading `=`, `+`, `-`, or `@` is prefixed with an apostrophe. A spreadsheet
 * treats those as the start of a formula, so a visitor who types one into a
 * sign-up sheet writes a formula into whoever opens the export.
 */
function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0] ?? {});
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvField(row[column])).join(","));
  return lines.join("\r\n");
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = value instanceof ArrayBuffer ? `<${value.byteLength} bytes>` : String(value);
  const guarded = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}
