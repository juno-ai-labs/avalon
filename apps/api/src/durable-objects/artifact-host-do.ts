import { revocationClosesSession } from "../services/access-revocation";
import { RegionSchema } from "@rally/contracts/regions";
/**
 * One supervisor object per live web artifact.
 *
 * It owns the artifact's *serving-side* truth — which version is current, who
 * currently holds a viewer session, and the bounded log of what the model's
 * server module threw — and, for a stateful artifact, it hosts the model's own
 * storage class as a Durable Object **facet** with its own isolated SQLite
 * database.
 *
 * **It remains addressed by artifact UUID, even though the public hostname is
 * readable.** The serving Worker resolves
 * `Host: <stub>-<region>.rallyusercontent.com` through the content-free shared
 * platform D1 database, then names this object from the returned UUID. Existing
 * UUID-named objects and their facet databases therefore keep their identity
 * when a public stub is allocated. Everything else the request needs (which
 * work stream, which version, which bucket prefix) comes from this object once
 * it is addressed.
 *
 * Access is admitted before a viewer session is created. After that, this
 * object trusts the durable session until an explicit revocation removes it or
 * its fixed lifetime expires:
 *
 * - *Session and membership revocation is a D1 fact*, so it arrives on the
 *   access-revocation queue like every other one. This object joins that
 *   fan-out at the **workspace** hop, because `artifact_registry` lives beside
 *   the resource authority in `WorkspaceDO` and only the object holding a list
 *   can name its children.
 * - Resource visibility is resolved by the canonical authorization service
 *   before `openForViewer`; ordinary artifact requests do not poll that
 *   authority again.
 *
 * See `docs/live-web-artifacts.md`.
 */
import {
  ArtifactManifestSchema,
  artifactAssetKey,
  artifactIsolateId,
  type ArtifactManifest,
} from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";
import {
  assertDurableObjectJurisdiction,
} from "../lib/durable-object-namespace";
import { sha256Hex } from "../lib/crypto";
import {
  FACET_HOST_CLASS,
  FACET_HOST_MODULE,
  FACET_HOST_MODULE_SOURCE,
  FACET_NAME,
} from "../artifacts/facet-host";
import { ASSET_SHIM_MODULE, ASSET_SHIM_SOURCE } from "../artifacts/asset-shim";
import {
  admitReadOnlyStatement,
  admitTableName,
  quoteIdentifier,
  scopeStatementToViewer,
  VIEWER_COLUMN,
  type ArtifactRowScope,
} from "../artifacts/read-only-sql";

export type { ArtifactRowScope };
import {
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";
import { InternallyInspectableDurableObject } from "./internally-inspectable-durable-object";
import { type DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

const MIGRATION_COMPONENT = "artifact_host";

// Migration 1 retains the former per-request visibility columns. New sessions
// record their admission there, but serving trusts the session until explicit
// revocation or expiry. Keep this explanation outside the published SQL:
// migration statement bytes, including SQL comments, are immutable receipts.
export const ARTIFACT_HOST_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "artifact serving state, viewer sessions, and the error log",
  statements: [
    // One row. The object *is* the artifact, so its identity is a singleton
    // rather than a keyed table — and a second row would mean this object was
    // addressed by two artifacts, which the UUID label makes impossible.
    `CREATE TABLE artifact_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      artifact_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      current_version INTEGER NOT NULL CHECK (current_version > 0),
      mode TEXT NOT NULL CHECK (mode IN ('static', 'active')),
      stateful INTEGER NOT NULL CHECK (stateful IN (0, 1)),
      manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    // The cookie value is never stored, only its digest: this database is a
    // credential store otherwise, and a dump of it would be a set of live
    // sessions. `code_sha256` is the single-use open code, cleared the moment
    // it is redeemed so a replay finds nothing to redeem.
    `CREATE TABLE viewer_sessions (
      session_sha256 TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_session_id TEXT,
      display_name TEXT NOT NULL,
      issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
      expires_at INTEGER NOT NULL CHECK (expires_at > 0),
      code_sha256 TEXT UNIQUE,
      code_expires_at INTEGER,
      redeemed_at INTEGER,
      -- When this principal's work-stream visibility was last confirmed
      -- against WorkstreamDO, and what the answer was. Cached for a bounded
      -- interval rather than asked per request: a live artifact must not put
      -- a Durable Object hop in front of every asset byte.
      visibility_checked_at INTEGER,
      visible INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0, 1))
    ) STRICT`,
    `CREATE INDEX viewer_sessions_principal_idx ON viewer_sessions(user_id, session_sha256)`,
    `CREATE INDEX viewer_sessions_expiry_idx ON viewer_sessions(expires_at)`,
    // A bounded ring. The model's server module throws where a participant can
    // see it and nowhere else, so this is what turns "the page is broken" into
    // something pasteable back into chat.
    `CREATE TABLE error_log (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      artifact_version INTEGER NOT NULL CHECK (artifact_version > 0),
      request_path TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT
    ) STRICT`,
    `CREATE INDEX error_log_recent_idx ON error_log(occurred_at DESC, entry_id DESC)`,
  ],
}, { version: 2, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_artifact_state\" AS SELECT * FROM \"artifact_state\"",
  "DELETE FROM \"artifact_state\"",
  "DROP TABLE \"artifact_state\"",
  "CREATE TABLE artifact_state (\n      id INTEGER PRIMARY KEY CHECK (id = 1),\n      artifact_id TEXT NOT NULL,\n      workspace_id TEXT NOT NULL,\n      workstream_id TEXT NOT NULL,\n      resource_id TEXT NOT NULL,\n      region TEXT NOT NULL,\n      current_version INTEGER NOT NULL CHECK (current_version > 0),\n      mode TEXT NOT NULL CHECK (mode IN ('static', 'active')),\n      stateful INTEGER NOT NULL CHECK (stateful IN (0, 1)),\n      manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),\n      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)\n    ) STRICT",
  "INSERT INTO \"artifact_state\" SELECT * FROM \"_region_copy_artifact_state\"",
  "DROP TABLE \"_region_copy_artifact_state\"",
  "PRAGMA defer_foreign_keys = OFF"
]
}];

/**
 * How long a viewer session lives, fixed from mint and never sliding.
 *
 * **The shape, not just the number, is the artifact platform's sleep
 * guarantee.** Nothing about an artifact executes without a viewer request, so
 * compute per open is bounded by the request-rate ceiling times this lifetime
 * — a product that only exists because the lifetime does not renew on use.
 * Sliding renewal reads as viewer convenience and quietly deletes the ceiling,
 * because an abandoned-but-visible page would then poll forever.
 *
 * Twenty-four hours is a team-set value, not an author's guess: one re-open per
 * day at most for a person actually working, and an abandoned page burns at
 * most a day of modest polling. The accepted casualty is a wall dashboard left
 * up past expiry.
 */
export const VIEWER_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/**
 * How long an unredeemed open code stays redeemable.
 *
 * Short because it has exactly one job: survive the hop from the API's `open`
 * response to the bootstrap page's `POST`. It is not a defensive bound on abuse
 * — single-use redemption is that — so it is transcribed from the round trip it
 * covers rather than handed back as an open limit.
 */
export const ARTIFACT_OPEN_CODE_LIFETIME_MS = 60_000;

/**
 * How many error entries the ring keeps.
 *
 * A display bound rather than a defensive one: the rail shows a list a person
 * reads, and a page that throws on every request would otherwise fill this
 * object's storage with copies of one stack trace.
 */
const ERROR_LOG_ENTRIES = 50;

/**
 * The compatibility date model-authored artifact code runs under.
 *
 * Pinned rather than tracking the platform's newest, because an artifact is
 * published once and served for as long as anyone opens it: a date that moved
 * underneath it would change the runtime semantics of code nobody is going to
 * revisit. Advancing it is a deliberate change with its own reason.
 */
const ARTIFACT_COMPATIBILITY_DATE = "2026-08-01";

/**
 * The Rally-authored methods the facet answers, which the model's class never
 * defined and cannot reach.
 *
 * Branded as a Durable Object so `ctx.facets.get<T>()` returns a typed stub
 * rather than something a cast has to rescue. The class this describes is
 * authored as source in `artifacts/facet-host.ts` and compiled into the
 * artifact's own isolate, so there is no TypeScript class to point at — this
 * interface is the contract between the two sides, and it is the only place
 * either can be changed without the other noticing.
 */
interface ArtifactFacetHost extends Rpc.DurableObjectBranded {
  rallyDescribe(): Promise<{
    tables: { name: string; columns: { name: string; type: string }[]; rowCount: number }[];
  }>;
  rallyTableNames(): Promise<string[]>;
  rallyQuery(sql: string, params: (string | number | null)[], maxRows: number): Promise<{
    columns: string[];
    rows: ArtifactRow[];
    rowCount: number;
    truncated: boolean;
  }>;
  rallyPage(quotedTable: string, offset: number, limit: number): Promise<{
    rows: ArtifactRow[];
  }>;
}

/**
 * A 256-bit random token, hex-encoded.
 *
 * `getRandomValues` rather than a UUID of either kind, because these are
 * **secrets rather than identities**: the open code and the viewer session
 * cookie are bearer values, and the repository's identity rule points at
 * `uuidV7`, which is deliberately time-ordered and therefore partly guessable
 * from when it was minted. Neither of these is ever a key anything is looked up
 * by in a way a person reads — only their digests are stored — so nothing is
 * lost by using the primitive built for unpredictability.
 */
function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ARTIFACT_STATE_ROW = z.object({
  artifact_id: z.string(),
  workspace_id: z.string(),
  workstream_id: z.string(),
  resource_id: z.string(),
  region: RegionSchema,
  current_version: z.number().int().positive(),
  mode: z.enum(["static", "active"]),
  stateful: z.number().int(),
  manifest_json: z.string(),
});

export const ArtifactPublishSchema = z.strictObject({
  artifactId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  resourceId: z.string().uuid(),
  region: RegionSchema,
  manifest: ArtifactManifestSchema,
});
export type ArtifactPublish = z.infer<typeof ArtifactPublishSchema>;

export const ArtifactOpenRequestSchema = z.strictObject({
  userId: z.string().uuid(),
  appSessionId: z.string().min(1).max(200).nullable(),
  displayName: z.string().max(300),
});

/**
 * A read's outcome, refusals included.
 *
 * Discriminated rather than thrown for the reason `agent-tools.md` separates
 * the two: a caller-supplied statement that is not a read is a normal domain
 * outcome the model repairs from, while an exception is Rally's own fault, and
 * collapsing them makes both harder to find.
 */
/**
 * One row as it crosses the RPC boundary.
 *
 * Narrow on purpose: `unknown` is not in the runtime's serializable set, so a
 * row typed that way maps to `never` on the stub and the compiler stops being
 * able to say anything useful about it. SQLite's own value domain is exactly
 * these five, so nothing is lost by naming them.
 */
export type ArtifactRow = Record<string, string | number | boolean | null | ArrayBuffer>;

export type ArtifactQueryResult =
  | { ok: true; columns: string[]; rows: ArtifactRow[]; rowCount: number; truncated: boolean }
  | { ok: false; reason: "no_artifact_data" }
  | { ok: false; reason: "sql_refused"; detail: string };

export type ArtifactPageResult =
  | { ok: true; rows: ArtifactRow[] }
  | { ok: false; reason: "no_artifact_data" }
  | { ok: false; reason: "table_refused"; detail: string };

export interface ArtifactSessionCheck {
  ok: boolean;
  /** Why a request was refused, for the serving Worker's response choice. */
  reason?: "no_session" | "expired";
  viewerId?: string;
  viewerName?: string;
  version?: number;
  mode?: "static" | "active";
  stateful?: boolean;
  manifest?: ArtifactManifest;
}

/**
 * Inspectable rather than merely migratable, which is the one thing about this
 * declaration that is not obvious. The base above `MigratableDurableObject`
 * adds `runInspectionSql`, the unrestricted operator SQL RPC the engineering
 * MCP reaches through the private regional bridge — this object is not a
 * scheduled authority, so it does not pick the RPC up from the scheduler the
 * way WorkspaceDO and its siblings do, and inheriting it is deliberate.
 * `docs/engineering-mcp.md` owns what that RPC admits; it reaches this
 * supervisor's own database and never the facet's.
 */
export class ArtifactHostDO extends InternallyInspectableDurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;
  /**
   * What code the facet is believed to be running, in memory only.
   *
   * Cold after hibernation, which is exactly why the abort below is defensive:
   * `facets.abort` on a facet that is not running is a no-op, so aborting when
   * this cannot be confirmed costs nothing and assuming costs a stale class
   * serving live requests.
   */
  private facetVersion: number | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: ARTIFACT_HOST_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
    });
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: MIGRATION_COMPONENT,
      className: "ArtifactHostDO",
      migrations: ARTIFACT_HOST_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  /**
   * Record a publish, and point the artifact at it.
   *
   * Called from the publish path once the version's bytes are durable in the
   * bucket, so the pointer never names a manifest a viewer cannot read. The
   * facet is *not* restarted here: it is aborted lazily on the next request
   * that observes a version it cannot confirm, which is the reference
   * platform's own update lifecycle and avoids waking a facet nobody is using.
   */
  async recordPublish(publish: ArtifactPublish): Promise<void> {
    await this.initialized;
    const input = ArtifactPublishSchema.parse(publish);
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO artifact_state (
         id, artifact_id, workspace_id, workstream_id, resource_id, region,
         current_version, mode, stateful, manifest_json, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_version = excluded.current_version,
         mode = excluded.mode,
         stateful = excluded.stateful,
         manifest_json = excluded.manifest_json,
         resource_id = excluded.resource_id,
         updated_at = excluded.updated_at`,
      input.artifactId,
      input.workspaceId,
      input.workstreamId,
      input.resourceId,
      input.region,
      input.manifest.artifactVersion,
      input.manifest.mode,
      input.manifest.stateful ? 1 : 0,
      JSON.stringify(input.manifest),
      now,
    );
    // In-memory only, and deliberately pessimistic: the next request aborts
    // and reloads rather than trusting that this process is the one that will
    // serve it.
    this.facetVersion = null;
  }

  /**
   * Mint a single-use open code for one authorized viewer.
   *
   * The code never travels in a request URL — the caller hands it to the
   * bootstrap page in a fragment, which `POST`s it in a body. What is stored
   * here is its digest, so this database holds no redeemable secret.
   */
  async openForViewer(request: z.infer<typeof ArtifactOpenRequestSchema>): Promise<{ code: string }> {
    await this.initialized;
    const input = ArtifactOpenRequestSchema.parse(request);
    const code = randomSecret();
    const now = Date.now();
    this.pruneExpired(now);
    this.state.storage.sql.exec(
      `INSERT INTO viewer_sessions (
         session_sha256, user_id, app_session_id, display_name,
         issued_at, expires_at, code_sha256, code_expires_at, visibility_checked_at, visible
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      // The session digest is a placeholder until redemption swaps in the
      // cookie's own digest; the primary key needs a value now and this row is
      // unreachable without the code.
      await sha256Hex(new TextEncoder().encode(`pending:${code}`)),
      input.userId,
      input.appSessionId,
      input.displayName,
      now,
      now + VIEWER_SESSION_LIFETIME_MS,
      await sha256Hex(new TextEncoder().encode(code)),
      now + ARTIFACT_OPEN_CODE_LIFETIME_MS,
      now,
    );
    return { code };
  }

  /**
   * Consume an open code and return the cookie value it becomes.
   *
   * Single-use: the code digest is cleared in the same statement that reads it,
   * so a replay finds nothing. That bounds replay but is deliberately *not*
   * what keeps the code out of a log — nothing here can do that, which is why
   * the code travels in a fragment and a request body rather than a URL.
   */
  async redeemCode(code: string): Promise<{ session: string; expiresAt: number } | null> {
    await this.initialized;
    const now = Date.now();
    const digest = await sha256Hex(new TextEncoder().encode(code));
    const session = randomSecret();
    const sessionDigest = await sha256Hex(new TextEncoder().encode(session));
    const redeemed = this.state.storage.sql.exec<{ expires_at: number }>(
      `UPDATE viewer_sessions
          SET session_sha256 = ?, code_sha256 = NULL, code_expires_at = NULL, redeemed_at = ?
        WHERE code_sha256 = ? AND code_expires_at > ? AND expires_at > ?
      RETURNING expires_at`,
      sessionDigest,
      now,
      digest,
      now,
      now,
    ).toArray();
    const row = redeemed[0];
    return row ? { session, expiresAt: row.expires_at } : null;
  }

  /**
   * Admit or refuse one artifact request, and say who is making it.
   *
   * Called by the serving Worker before anything reaches model-authored code.
   * Admission already established resource access; this lookup answers whether
   * the durable session still exists and has not reached its fixed expiry.
   */
  async checkSession(sessionValue: string): Promise<ArtifactSessionCheck> {
    await this.initialized;
    const state = this.stateRow();
    if (!state) return { ok: false, reason: "no_session" };
    const now = Date.now();
    const digest = await sha256Hex(new TextEncoder().encode(sessionValue));
    const rows = this.state.storage.sql.exec<{
      user_id: string;
      display_name: string;
      expires_at: number;
    }>(
      `SELECT user_id, display_name, expires_at
         FROM viewer_sessions WHERE session_sha256 = ? AND redeemed_at IS NOT NULL`,
      digest,
    ).toArray();
    const row = rows[0];
    if (!row) return { ok: false, reason: "no_session" };
    if (row.expires_at <= now) {
      this.state.storage.sql.exec(`DELETE FROM viewer_sessions WHERE session_sha256 = ?`, digest);
      return { ok: false, reason: "expired" };
    }
    return {
      ok: true,
      viewerId: row.user_id,
      viewerName: row.display_name,
      version: state.current_version,
      mode: state.mode,
      stateful: state.stateful === 1,
      manifest: ArtifactManifestSchema.parse(JSON.parse(state.manifest_json)),
    };
  }

  /** Read the current manifest and execution shape for public serving and version routing. */
  async currentState(): Promise<{
    artifactId: string;
    workspaceId: string;
    workstreamId: string;
    resourceId: string;
    version: number;
    mode: "static" | "active";
    stateful: boolean;
    manifest: ArtifactManifest;
  } | null> {
    await this.initialized;
    const state = this.stateRow();
    if (!state) return null;
    return {
      artifactId: state.artifact_id,
      workspaceId: state.workspace_id,
      workstreamId: state.workstream_id,
      resourceId: state.resource_id,
      version: state.current_version,
      mode: state.mode,
      stateful: state.stateful === 1,
      manifest: ArtifactManifestSchema.parse(JSON.parse(state.manifest_json)),
    };
  }

  /** Record what the model's module threw, where a participant can read it. */
  async recordError(entry: {
    version: number;
    requestPath: string;
    message: string;
    stack: string | null;
  }): Promise<void> {
    await this.initialized;
    this.state.storage.sql.exec(
      `INSERT INTO error_log (occurred_at, artifact_version, request_path, message, stack)
       VALUES (?, ?, ?, ?, ?)`,
      Date.now(),
      entry.version,
      entry.requestPath.slice(0, 1_024),
      entry.message.slice(0, 4_000),
      entry.stack?.slice(0, 8_000) ?? null,
    );
    this.state.storage.sql.exec(
      `DELETE FROM error_log WHERE entry_id NOT IN (
         SELECT entry_id FROM error_log ORDER BY entry_id DESC LIMIT ?
       )`,
      ERROR_LOG_ENTRIES,
    );
  }

  async readErrors(): Promise<{
    occurredAt: number;
    version: number;
    requestPath: string;
    message: string;
    stack: string | null;
  }[]> {
    await this.initialized;
    return this.state.storage.sql.exec<{
      occurred_at: number;
      artifact_version: number;
      request_path: string;
      message: string;
      stack: string | null;
    }>(
      `SELECT occurred_at, artifact_version, request_path, message, stack
         FROM error_log ORDER BY entry_id DESC LIMIT ?`,
      ERROR_LOG_ENTRIES,
    ).toArray().map((row) => ({
      occurredAt: row.occurred_at,
      version: row.artifact_version,
      requestPath: row.request_path,
      message: row.message,
      stack: row.stack,
    }));
  }

  /**
   * Drop one principal's viewer sessions, and name no children.
   *
   * The same method name and the same contract as every other object on the
   * access-revocation walk, over a different thing: this object holds no
   * WebSockets, so there is nothing to close and `state.getWebSockets()` would
   * find nothing. What it holds is sessions, and a session that survived a
   * membership ending would keep serving an artifact to someone who is no
   * longer in the workspace.
   *
   * It is a leaf: an artifact has no children, so the walk stops here.
   */
  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<Record<string, never>> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    const sessions = this.state.storage.sql.exec<{ app_session_id: string | null }>(
      "SELECT DISTINCT app_session_id FROM viewer_sessions WHERE user_id = ?", request.userId,
    ).toArray();
    for (const session of sessions) {
      if (await revocationClosesSession(this.env, request, {
        userId: request.userId, sessionId: session.app_session_id ?? undefined,
      })) {
        // Redemption rotates the viewer digest while the D1 check is awaiting.
        // Its immutable app-session binding remains the revocation target.
        this.state.storage.sql.exec(
          "DELETE FROM viewer_sessions WHERE user_id = ? AND app_session_id IS ?",
          request.userId, session.app_session_id,
        );
      }
    }
    return {};
  }

  /**
   * Serve one request through the model's class, inside the facet.
   *
   * **Requests to a stateful artifact route through this object rather than
   * being served in the loader's own isolate**, and that is forced rather than
   * chosen: facet stubs cannot travel over RPC, so the object that owns the
   * facet is the only place that can forward into it. The serving Worker
   * already consults this object per request for the session check, so the hop
   * is one it was making anyway.
   */
  async fetchThroughFacet(request: Request): Promise<Response> {
    await this.initialized;
    const state = this.stateRow();
    if (!state) return new Response("artifact_not_published", { status: 404 });
    const facet = await this.facetFor(state);
    return await facet.fetch(request);
  }

  /**
   * The artifact's stored shape, for the rail and the describe tool.
   *
   * Row counts follow `scope`: a viewer limited to their own rows sees how
   * many of a per-viewer table's rows are theirs, not how many exist.
   */
  async describeData(scope: ArtifactRowScope): Promise<{
    tables: { name: string; columns: { name: string; type: string }[]; rowCount: number }[];
  }> {
    await this.initialized;
    const state = this.stateRow();
    if (!state || state.stateful !== 1) return { tables: [] };
    const host = await this.facetFor(state);
    const described = await host.rallyDescribe();
    if (scope.rows === "all") return described;
    const tables = [];
    for (const table of described.tables) {
      if (!isViewerTable(table)) { tables.push(table); continue; }
      const counted = await host.rallyQuery(
        `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(VIEWER_COLUMN)} = ?`,
        [scope.viewerId],
        1,
      );
      tables.push({ ...table, rowCount: Number(counted.rows[0]?.n ?? 0) });
    }
    return { tables };
  }

  /**
   * Run one read against the artifact's database.
   *
   * The statement is admitted *before* it reaches the facet, by the supervisor
   * rather than by the code that runs it: an always-rollback transaction is not
   * an authorization boundary, and the rollback inside the facet is the second
   * line of defence rather than the first. A viewer-scoped read is then
   * rewritten so per-viewer tables hold only that viewer's rows.
   */
  async queryData(
    sql: string,
    params: (string | number | null)[],
    maxRows: number,
    scope: ArtifactRowScope,
  ): Promise<ArtifactQueryResult> {
    await this.initialized;
    const state = this.stateRow();
    if (!state || state.stateful !== 1) return { ok: false, reason: "no_artifact_data" };
    // A refusal is a **domain outcome, not an exception**: a model writing the
    // wrong SQL is the ordinary case this contract exists to repair, and
    // throwing would log an uncaught rejection inside this object on every one
    // of them — burying the failures that are actually Rally's fault. The tool
    // layer turns this into the model-visible error.
    const admission = admitReadOnlyStatement(sql);
    if (!admission.admitted) return { ok: false, reason: "sql_refused", detail: admission.reason };
    const host = await this.facetFor(state);
    let statement = admission.sql;
    if (scope.rows === "viewer") {
      const [described, views] = await Promise.all([
        host.rallyDescribe(),
        host.rallyQuery("SELECT name, sql FROM sqlite_master WHERE type = 'view'", [], Number.MAX_SAFE_INTEGER),
      ]);
      statement = scopeStatementToViewer(statement, {
        viewerTables: described.tables.filter(isViewerTable).map((table) => table.name),
        views: views.rows.map((row) => ({ name: String(row.name), sql: String(row.sql) })),
        viewerId: scope.viewerId,
      });
    }
    const read = await host.rallyQuery(statement, params, maxRows);
    return { ok: true, columns: read.columns, rows: read.rows, rowCount: read.rowCount, truncated: read.truncated };
  }

  /** One page of one table, for the Data view and the CSV export. */
  async pageData(table: string, offset: number, limit: number, scope: ArtifactRowScope): Promise<ArtifactPageResult> {
    await this.initialized;
    const state = this.stateRow();
    if (!state || state.stateful !== 1) return { ok: false, reason: "no_artifact_data" };
    const host = await this.facetFor(state);
    // The allowlist is the *database's*, not the caller's: a name that is not a
    // real table in this facet never reaches SQL at all.
    const admitted = admitTableName(table, await host.rallyTableNames());
    if (!admitted.admitted) return { ok: false, reason: "table_refused", detail: admitted.reason };
    if (scope.rows === "viewer") {
      const described = await host.rallyDescribe();
      if (described.tables.some((candidate) => candidate.name === table && isViewerTable(candidate))) {
        const page = await host.rallyQuery(
          `SELECT * FROM ${admitted.quoted} WHERE ${quoteIdentifier(VIEWER_COLUMN)} = ? LIMIT ? OFFSET ?`,
          [scope.viewerId, limit, Math.max(0, offset)],
          limit,
        );
        return { ok: true, rows: page.rows };
      }
    }
    const page = await host.rallyPage(admitted.quoted, offset, limit);
    return { ok: true, rows: page.rows };
  }

  /**
   * Get the facet, aborting first whenever the running code cannot be confirmed.
   *
   * **The abort is defensive on purpose, and its necessity is not observable
   * locally.** `facets.abort` on a facet that is not running is a no-op, so
   * aborting when this object's in-memory tracking is cold — after
   * hibernation, or after a republish this process did not see — costs nothing,
   * while assuming costs a stale class serving live requests against a schema
   * that has moved. Storage survives the abort; only the code is reloaded.
   *
   * Removing this call leaves the workerd proofs passing, because the runtime
   * evidently reloads a facet whose class identity changed on its own. It stays
   * anyway: it is the reference platform's documented update lifecycle, the
   * behavior it guards against is a *cold-tracking* case a single-process test
   * does not reach, and the cost of keeping it is a no-op call. That it cannot
   * be shown load-bearing here is recorded rather than papered over.
   */
  private async facetFor(
    state: z.infer<typeof ARTIFACT_STATE_ROW>,
  ): Promise<Fetcher<ArtifactFacetHost>> {
    if (this.facetVersion !== state.current_version) {
      this.ctx.facets.abort(FACET_NAME, "artifact_version_changed");
      this.facetVersion = state.current_version;
    }
    const artifactId = state.artifact_id;
    const version = state.current_version;
    const env = this.env;
    // Parsed rather than cast, like every other read of this column: it was
    // written by a possibly older deployment.
    const manifest = ArtifactManifestSchema.parse(JSON.parse(state.manifest_json));
    return this.ctx.facets.get<ArtifactFacetHost>(FACET_NAME, async () => {
      const loader = env.ARTIFACT_LOADER;
      if (!loader) throw new Error("artifact_loader_binding_missing");
      const module = await env.PAYLOADS.get(artifactAssetKey(artifactId, version, "index.js"));
      if (!module) throw new Error("artifact_server_module_missing");
      const worker = loader.get(artifactIsolateId(artifactId, version), async () => ({
        compatibilityDate: ARTIFACT_COMPATIBILITY_DATE,
        // Rally's own module is the main one and imports the model's, so the
        // facet never loads the model's class directly.
        mainModule: FACET_HOST_MODULE,
        modules: {
          [FACET_HOST_MODULE]: FACET_HOST_MODULE_SOURCE,
          [ASSET_SHIM_MODULE]: ASSET_SHIM_SOURCE,
          "index.js": await module.text(),
        },
        // One binding and no network: an RPC stub that reads this version's
        // published files, and nothing else. The skill teaches
        // `this.env.ASSETS.fetch(request)` as the last line of `SiteData.fetch`,
        // and with an empty env every stateful site answered the routes its
        // model wrote and threw on its own `index.html`.
        //
        // A stub rather than a reader object because the loader's env
        // serializer rejects a value carrying a function; the bucket behind it
        // stays in the API Worker.
        env: {
          RALLY_ASSETS: this.ctx.exports.ArtifactAssetLoopback({
            props: {
              artifactId,
              version,
              assets: manifest.assets.map((asset) => ({
                path: asset.path,
                contentType: asset.contentType,
              })),
            },
          }),
        },
        globalOutbound: null,
      }));
      return { class: worker.getDurableObjectClass<ArtifactFacetHost>(FACET_HOST_CLASS) };
    });
  }

  /** Remove every session, for an artifact whose resource was deleted. */
  async purge(): Promise<void> {
    await this.initialized;
    // `facets.delete` permanently removes the facet's database. It rides the
    // same lifecycle that deletes the resource, so an artifact's data does not
    // outlive the artifact.
    this.ctx.facets.delete(FACET_NAME);
    this.facetVersion = null;
    this.state.storage.sql.exec(`DELETE FROM viewer_sessions`);
    this.state.storage.sql.exec(`DELETE FROM error_log`);
    this.state.storage.sql.exec(`DELETE FROM artifact_state`);
  }

  private stateRow(): z.infer<typeof ARTIFACT_STATE_ROW> | null {
    const rows = this.state.storage.sql.exec(
      `SELECT artifact_id, workspace_id, workstream_id, resource_id, region,
              current_version, mode, stateful, manifest_json
         FROM artifact_state WHERE id = 1`,
    ).toArray();
    return rows[0] ? ARTIFACT_STATE_ROW.parse(rows[0]) : null;
  }

  private pruneExpired(now: number): void {
    this.state.storage.sql.exec(`DELETE FROM viewer_sessions WHERE expires_at <= ?`, now);
  }

}

/** A table is per-viewer when it has the viewer column; see `VIEWER_COLUMN`. */
function isViewerTable(table: { columns: readonly { name: string }[] }): boolean {
  return table.columns.some((column) => column.name.toLowerCase() === VIEWER_COLUMN);
}
