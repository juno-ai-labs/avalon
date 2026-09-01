/**
 * One supervisor object per live web artifact.
 *
 * It owns the artifact's *serving-side* truth — which version is current, who
 * currently holds a viewer session, and the bounded log of what the model's
 * server module threw — and, for a stateful artifact, it hosts the model's own
 * storage class as a Durable Object **facet** with its own isolated SQLite
 * database.
 *
 * **It is addressed by the artifact id its hostname carries, and that is what
 * makes serving possible at all.** The artifact serving Worker holds no D1, so
 * given nothing but `Host: <artifact-id>-<region>.rallyusercontent.com` it has
 * to reach the right object without a lookup. The id *is* the label, so the
 * Worker parses it out and names this object from it — no index, no directory
 * hop, no per-request database read before the first byte. Everything else the
 * request needs (which work stream, which version, which bucket prefix) comes
 * from this object once it is addressed.
 *
 * Two authorities own facts this object does not, and it asks each rather than
 * guessing — `docs/access-revocation.md` is explicit that they must never be
 * merged:
 *
 * - *Session and membership revocation is a D1 fact*, so it arrives on the
 *   access-revocation queue like every other one. This object joins that
 *   fan-out at the **workspace** hop, because `artifact_registry` lives beside
 *   the resource authority in `WorkspaceDO` and only the object holding a list
 *   can name its children.
 * - *Work-stream visibility is not a D1 fact* — it lives in `WorkstreamDO`'s
 *   own SQL — so this object resolves each viewer against that object and
 *   caches the answer for a bounded interval rather than putting a Durable
 *   Object hop in front of every asset byte.
 *
 * See `docs/live-web-artifacts.md`.
 */
import {
  ARTIFACT_VIEWER_ID_HEADER,
  ARTIFACT_VIEWER_NAME_HEADER,
  ArtifactManifestSchema,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type ArtifactManifest,
} from "@rally/contracts";
import { rallyHeaderAliases } from "@rally/contracts/http-headers";
import { z } from "zod";

import type { Env } from "../env";
import {
  assertDurableObjectJurisdiction,
  durableObjectStubForWorkspace,
} from "../lib/durable-object-namespace";
import { sha256Hex } from "../lib/crypto";
import { workstreamDOName } from "./names";
import {
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";
import {
  MigratableDurableObject,
  type DurableObjectMigrationPlan,
} from "./migratable-durable-object";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

const MIGRATION_COMPONENT = "artifact_host";

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
  region: z.enum(["global", "eu"]),
  current_version: z.number().int().positive(),
  mode: z.enum(["static", "active"]),
  stateful: z.number().int(),
  manifest_json: z.string(),
});

export const ArtifactPublishSchema = z.object({
  artifactId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  resourceId: z.string().uuid(),
  region: z.enum(["global", "eu"]),
  manifest: ArtifactManifestSchema,
}).strict();
export type ArtifactPublish = z.infer<typeof ArtifactPublishSchema>;

export const ArtifactOpenRequestSchema = z.object({
  userId: z.string().uuid(),
  appSessionId: z.string().min(1).max(200).nullable(),
  displayName: z.string().max(300),
}).strict();

export interface ArtifactSessionCheck {
  ok: boolean;
  /** Why a request was refused, for the serving Worker's response choice. */
  reason?: "no_session" | "expired" | "not_visible";
  viewerId?: string;
  viewerName?: string;
  version?: number;
  mode?: "static" | "active";
  stateful?: boolean;
  manifest?: ArtifactManifest;
}

export class ArtifactHostDO extends MigratableDurableObject<Env> {
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
   * Called by the serving Worker before anything reaches model-authored code,
   * so this is where the two revocation questions are actually answered — the
   * queue having dropped rows for the first, and `WorkstreamDO` being asked for
   * the second when the cached answer has aged out.
   */
  async checkSession(sessionValue: string, visibilityCacheMs: number): Promise<ArtifactSessionCheck> {
    await this.initialized;
    const state = this.stateRow();
    if (!state) return { ok: false, reason: "no_session" };
    const now = Date.now();
    const digest = await sha256Hex(new TextEncoder().encode(sessionValue));
    const rows = this.state.storage.sql.exec<{
      user_id: string;
      display_name: string;
      expires_at: number;
      visibility_checked_at: number | null;
      visible: number;
    }>(
      `SELECT user_id, display_name, expires_at, visibility_checked_at, visible
         FROM viewer_sessions WHERE session_sha256 = ? AND redeemed_at IS NOT NULL`,
      digest,
    ).toArray();
    const row = rows[0];
    if (!row) return { ok: false, reason: "no_session" };
    if (row.expires_at <= now) {
      this.state.storage.sql.exec(`DELETE FROM viewer_sessions WHERE session_sha256 = ?`, digest);
      return { ok: false, reason: "expired" };
    }
    const fresh = row.visibility_checked_at !== null
      && now - row.visibility_checked_at < visibilityCacheMs;
    const visible = fresh ? row.visible === 1 : await this.confirmVisibility(digest, row.user_id, now);
    if (!visible) return { ok: false, reason: "not_visible" };
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

  /** Read a specific version's manifest, for a prior-version render. */
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
    if (request.sessionId === null) {
      // The membership is gone, so nothing this person holds is admissible.
      this.state.storage.sql.exec(`DELETE FROM viewer_sessions WHERE user_id = ?`, request.userId);
    } else {
      // One session ended; the person's other windows keep working. An unknown
      // `app_session_id` is dropped rather than spared, matching
      // `revocationClosesSocket`: that costs a re-open, where sparing it keeps
      // a dead session reading.
      this.state.storage.sql.exec(
        `DELETE FROM viewer_sessions
          WHERE user_id = ? AND (app_session_id IS NULL OR app_session_id = ?)`,
        request.userId,
        request.sessionId,
      );
    }
    return {};
  }

  /** Remove every session, for an artifact whose resource was deleted. */
  async purge(): Promise<void> {
    await this.initialized;
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

  /**
   * Ask the authority that owns the scope, and cache what it says.
   *
   * Work-stream visibility is not a D1 fact — it lives in `WorkstreamDO`'s own
   * SQL — so it cannot arrive on the revocation queue, and this object must not
   * infer it from the session's own existence. That inference is precisely the
   * regression `access-revocation.md` records.
   */
  private async confirmVisibility(
    sessionDigest: string,
    userId: string,
    now: number,
  ): Promise<boolean> {
    const state = this.stateRow();
    if (!state) return false;
    let visible: boolean;
    try {
      visible = await this.resolveWorkstreamVisibility(state, userId);
    } catch {
      // A failed hop is not evidence of a lost scope. Keep the previous answer
      // rather than either admitting or refusing on a transport fault; the
      // cache is stale for one interval and the next request asks again.
      const previous = this.state.storage.sql.exec<{ visible: number }>(
        `SELECT visible FROM viewer_sessions WHERE session_sha256 = ?`,
        sessionDigest,
      ).toArray()[0];
      return previous?.visible === 1;
    }
    this.state.storage.sql.exec(
      `UPDATE viewer_sessions SET visibility_checked_at = ?, visible = ? WHERE session_sha256 = ?`,
      now,
      visible ? 1 : 0,
      sessionDigest,
    );
    return visible;
  }

  private async resolveWorkstreamVisibility(
    state: z.infer<typeof ARTIFACT_STATE_ROW>,
    userId: string,
  ): Promise<boolean> {
    const workspaceId = asWorkspaceId(state.workspace_id);
    const workstreamId = asWorkstreamId(state.workstream_id);
    const workstream = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSTREAM_DOS,
      workspaceId,
      workstreamDOName(this.env.AVALON_REGION, workspaceId, workstreamId),
    );
    return await workstream.canReadWorkstream(asUserId(userId));
  }
}

/**
 * The two headers artifact code is allowed to trust, and the strip that earns
 * that trust.
 *
 * Exported from here rather than inlined at the injection site because the
 * strip *is* the anti-spoof mechanism and has its own test: a page or proxy
 * that sends these names must never have them survive into the module. It
 * removes every alias, canonical and superseded alike, because every product
 * header reader widens to the superseded spelling — a family whose readers
 * widen and whose stripper does not has a forgeable back door.
 */
export function withViewerIdentity(
  request: Request,
  viewer: { id: string; name: string } | null,
): Request {
  const headers = new Headers(request.headers);
  for (const header of [ARTIFACT_VIEWER_ID_HEADER, ARTIFACT_VIEWER_NAME_HEADER]) {
    headers.delete(header);
    // `rallyHeaderAliases` is the one place the superseded prefixes live, so
    // the strip reads them from there rather than restating the list.
    for (const alias of rallyHeaderAliases(header)) headers.delete(alias);
  }
  if (viewer) {
    headers.set(ARTIFACT_VIEWER_ID_HEADER, viewer.id);
    // A header value is ASCII-only by RFC 7230, so a display name needs *some*
    // encoding. This is deliberately the `decodeURIComponent` idiom rather than
    // RFC 8187's `UTF-8''…` form — chosen for how reliably a small model
    // decodes it, and named here so nobody mistakes a house convention for a
    // standard header encoding.
    headers.set(ARTIFACT_VIEWER_NAME_HEADER, encodeURIComponent(viewer.name));
  }
  return new Request(request, { headers });
}
