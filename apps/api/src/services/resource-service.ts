import { ConnectorError, type ConnectorConnectionContext } from "@avalon/connectors";
import type { ConnectorManifest } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import type { AuthContext, Env } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { decryptString, encryptString } from "../lib/crypto";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";

export interface ResolveResourceInput {
  connectionId: string;
  provider: string;
  providerResourceId: string;
  resourceType: string;
  title: string;
  canonicalUrl?: string | null | undefined;
}

export interface ListResourcesInput {
  query?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

interface ResourceCursor {
  updatedAt: string;
  id: string;
}

const ENABLE_RESOURCE_WATCH_SQL = `INSERT INTO resource_watches
  (id, workspace_id, workstream_id, resource_id, connection_id, watch_type,
   cursor_json, next_poll_at, enabled, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?)
  ON CONFLICT(workstream_id, resource_id) DO UPDATE SET
    watch_type = excluded.watch_type,
    enabled = 1,
    next_poll_at = excluded.next_poll_at,
    updated_at = excluded.updated_at`;

const RESOURCE_WITH_WATCH_STATE_SQL = `SELECT r.*,
    COALESCE(MAX(CASE WHEN rw.enabled = 1 THEN 1 ELSE 0 END), 0) AS watch_enabled
  FROM resources r
  LEFT JOIN workstream_resources wr ON wr.resource_id = r.id
  LEFT JOIN resource_watches rw
    ON rw.workstream_id = wr.workstream_id
   AND rw.resource_id = wr.resource_id
  LEFT JOIN connector_connections c ON c.id = r.connection_id
  WHERE r.id = ? AND r.workspace_id = ?
    AND (c.id IS NULL OR c.scope = 'workspace' OR c.owner_user_id = ?)
  GROUP BY r.id`;

export class ResourceService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async list(input: ListResourcesInput) {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const cursor = input.cursor ? decodeResourceCursor(input.cursor) : null;
    const query = input.query?.trim().toLowerCase();
    const filters = [
      "r.workspace_id = ?",
      "(c.id IS NULL OR c.scope = 'workspace' OR c.owner_user_id = ?)",
    ];
    const bindings: unknown[] = [this.auth.workspaceId, this.auth.userId];

    if (query) {
      const pattern = `%${escapeLikePattern(query)}%`;
      filters.push(`(
        LOWER(r.title) LIKE ? ESCAPE '\\'
        OR LOWER(r.provider) LIKE ? ESCAPE '\\'
        OR LOWER(r.resource_type) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(r.provider_resource_id, '')) LIKE ? ESCAPE '\\'
      )`);
      bindings.push(pattern, pattern, pattern, pattern);
    }
    if (cursor) {
      filters.push("(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))");
      bindings.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }

    const result = await this.env.DB.prepare(
      `SELECT r.*,
        CASE WHEN EXISTS (
          SELECT 1 FROM resource_watches rw
          WHERE rw.resource_id = r.id
            AND rw.workspace_id = r.workspace_id
            AND rw.enabled = 1
        ) THEN 1 ELSE 0 END AS watch_enabled
       FROM resources r
       LEFT JOIN connector_connections c ON c.id = r.connection_id
       WHERE ${filters.join(" AND ")}
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT ?`,
    ).bind(...bindings, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    const hasMore = result.results.length > limit;
    const items = rows.map(toResource);
    const last = rows.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        ? encodeResourceCursor({ updatedAt: String(last.updated_at), id: String(last.id) })
        : null,
    };
  }

  async upload(file: File, title?: string) {
    const maxBytes = numericEnv(this.env, "MAX_ATTACHMENT_BYTES", 25_000_000);
    if (file.size > maxBytes) throw new ApiError(413, "attachment_too_large", `Attachments may not exceed ${maxBytes} bytes`);
    const id = newId();
    const key = `${this.env.AVALON_REGION}/${this.auth.workspaceId}/resources/${id}`;
    await this.env.PAYLOADS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream", contentDisposition: `attachment; filename="${safeFilename(file.name)}"` },
      customMetadata: { originalName: file.name, uploadedBy: this.auth.userId },
    });
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
        metadata_json, last_hydrated_at, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, this.auth.workspaceId, title ?? file.name, file.type || "application/octet-stream", key, JSON.stringify({ originalName: file.name, size: file.size }), at, at, at).run();
    return this.get(id);
  }

  async resolve(input: ResolveResourceInput) {
    const connection = await this.loadConnection(input.connectionId);
    if (connection.connector_type !== input.provider && !(connection.connector_type === "google" && input.provider.startsWith("google"))) {
      throw new ApiError(422, "provider_mismatch", "The resource does not belong to the selected connection");
    }
    const existing = await this.env.DB.prepare(
      `SELECT id FROM resources
       WHERE workspace_id = ? AND connection_id = ? AND provider = ? AND provider_resource_id = ?`,
    ).bind(this.auth.workspaceId, input.connectionId, input.provider, input.providerResourceId).first<{ id: string }>();
    if (existing) return this.get(existing.id);
    const id = newId();
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO resources
       (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
        title, canonical_url, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(id, this.auth.workspaceId, input.connectionId, input.resourceType, input.provider, input.providerResourceId, input.title, input.canonicalUrl ?? null, at, at).run();
    const canonical = await this.env.DB.prepare(
      `SELECT id FROM resources
       WHERE workspace_id = ? AND connection_id = ? AND provider = ? AND provider_resource_id = ?`,
    ).bind(this.auth.workspaceId, input.connectionId, input.provider, input.providerResourceId).first<{ id: string }>();
    if (!canonical) throw new ApiError(500, "resource_write_failed", "The resource could not be stored");
    return this.get(canonical.id);
  }

  async get(id: string) {
    const row = await this.loadResource(id);
    return toResource(row);
  }

  async content(id: string): Promise<Response> {
    const resource = await this.loadResource(id);
    if (typeof resource.content_ref !== "string") throw new ApiError(404, "resource_content_unavailable", "Resource content has not been hydrated");
    const object = await this.env.PAYLOADS.get(resource.content_ref);
    if (!object) throw new ApiError(404, "resource_content_unavailable", "Stored resource content was not found");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=0, no-store");
    return new Response(object.body, { headers });
  }

  async hydrate(id: string) {
    const resource = await this.loadResource(id);
    if (resource.connection_id == null) return toResource(resource);
    const connection = await this.loadConnection(String(resource.connection_id));
    const context = await this.connectionContext(connection);
    const adapter = this.registry().get(String(connection.connector_type));
    if (!adapter.hydrateResource) throw new ApiError(422, "hydration_not_supported", "This connector cannot hydrate resources");
    const before = JSON.stringify(context.credentials);
    let hydrated: unknown;
    try {
      hydrated = await adapter.hydrateResource(
        context,
        resource,
        AbortSignal.timeout(numericEnv(this.env, "TOOL_DEFAULT_TIMEOUT_MS", 30_000)),
      );
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "unauthorized") throw error;
      await this.env.DB.prepare(
        `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(
        JSON.stringify({ message: error.message, reconnectRequired: true }),
        nowIso(),
        connection.id,
        this.auth.workspaceId,
      ).run();
      throw new ApiError(409, "connection_needs_reconnect", "Reconnect the connector account before hydrating this resource");
    }
    if (JSON.stringify(context.credentials) !== before) {
      await this.persistConnectionCredentials(connection, context.credentials);
    }
    const idKey = `${this.env.AVALON_REGION}/${this.auth.workspaceId}/resources/${id}/hydrated.json`;
    await this.env.PAYLOADS.put(idKey, JSON.stringify(hydrated), { httpMetadata: { contentType: "application/json" } });
    const at = nowIso();
    await this.env.DB.prepare(
      `UPDATE resources SET content_ref = ?, last_hydrated_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(idKey, at, at, id, this.auth.workspaceId).run();
    return this.get(id);
  }

  async watch(id: string, workstreamId: string) {
    const resource = await this.loadResource(id);
    if (resource.connection_id == null) throw new ApiError(422, "watch_not_supported", "Uploaded files cannot be watched for changes");
    const connection = await this.loadConnection(String(resource.connection_id));
    const adapter = this.registry().get(String(connection.connector_type));
    const at = nowIso();
    const mode = resourceWatchMode(adapter.manifest, at);
    const attached = await this.env.DB.prepare(
      `SELECT 1 AS attached FROM workstream_resources wr JOIN workstreams w ON w.id = wr.workstream_id
       WHERE wr.resource_id = ? AND wr.workstream_id = ? AND w.workspace_id = ?`,
    ).bind(id, workstreamId, this.auth.workspaceId).first();
    if (!attached) throw new ApiError(404, "resource_attachment_not_found", "Attach the resource before enabling a watch");
    await this.env.DB.batch([
      this.env.DB.prepare(
        ENABLE_RESOURCE_WATCH_SQL,
      ).bind(
        newId(),
        this.auth.workspaceId,
        workstreamId,
        id,
        resource.connection_id,
        mode.watchType,
        mode.nextPollAt,
        at,
        at,
      ),
      this.env.DB.prepare(
        "UPDATE workstream_resources SET watch_enabled = 1 WHERE workstream_id = ? AND resource_id = ?",
      ).bind(workstreamId, id),
    ]);
    await this.refreshScheduler();
    return { watchEnabled: true };
  }

  async unwatch(id: string, workstreamId: string): Promise<void> {
    await this.loadResource(id);
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE resource_watches SET enabled = 0, updated_at = ? WHERE workstream_id = ? AND resource_id = ?",
      ).bind(nowIso(), workstreamId, id),
      this.env.DB.prepare(
        "UPDATE workstream_resources SET watch_enabled = 0 WHERE workstream_id = ? AND resource_id = ?",
      ).bind(workstreamId, id),
    ]);
    await this.refreshScheduler();
  }

  private async loadResource(id: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      RESOURCE_WITH_WATCH_STATE_SQL,
    ).bind(id, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "resource_not_found", "Resource not found");
    return row;
  }

  private async loadConnection(id: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      `SELECT * FROM connector_connections WHERE id = ? AND workspace_id = ?
       AND status != 'disabled' AND (scope = 'workspace' OR owner_user_id = ?)`,
    ).bind(id, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "connection_not_found", "Connection not found");
    return row;
  }

  private async connectionContext(row: Record<string, unknown>): Promise<ConnectorConnectionContext> {
    let credentials: Record<string, unknown> = {};
    if (typeof row.encrypted_credentials === "string" && typeof row.credential_iv === "string") {
      credentials = JSON.parse(await decryptString(
        row.encrypted_credentials,
        row.credential_iv,
        this.env.CONNECTOR_CREDENTIALS_KEY,
        String(row.id),
      )) as Record<string, unknown>;
    }
    return {
      id: String(row.id), workspaceId: String(row.workspace_id), scope: row.scope === "workspace" ? "workspace" : "personal",
      ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id), grantedScopes: parseJson(row.granted_scopes_json, []),
      credentials, cursor: parseJson(row.cursor_json, {}), config: parseJson(row.config_json, {}),
    };
  }

  private async persistConnectionCredentials(
    row: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ): Promise<void> {
    const id = String(row.id);
    const encrypted = await encryptString(
      JSON.stringify(credentials),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      id,
    );
    await this.env.DB.prepare(
      `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?,
       credential_key_version = ?, status = 'healthy', error_json = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      nowIso(),
      id,
      this.auth.workspaceId,
    ).run();
  }

  private registry() {
    return connectorRegistryForEnv(this.env);
  }

  private async refreshScheduler(): Promise<void> {
    const schedulers = durableObjectNamespaceForRegion(this.env.WORKSPACE_SCHEDULERS, this.env.AVALON_REGION, this.env.APP_ENV);
    const id = schedulers.idFromName(`${this.env.AVALON_REGION}:${this.auth.workspaceId}`);
    await schedulers.get(id).fetch("https://scheduler.internal/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: this.auth.workspaceId, region: this.env.AVALON_REGION }),
    });
  }
}

function toResource(row: Record<string, unknown>) {
  const watchEnabled = Number(row.watch_enabled ?? 0) === 1;
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), connectionId: row.connection_id == null ? null : String(row.connection_id),
    resourceType: String(row.resource_type), provider: String(row.provider), providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
    title: String(row.title), mimeType: row.mime_type == null ? null : String(row.mime_type), canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
    watchEnabled, watchStatus: row.connection_id == null ? "unsupported" : watchEnabled ? "watching" : "paused",
    lastHydratedAt: row.last_hydrated_at == null ? null : String(row.last_hydrated_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    contentAvailable: row.content_ref != null,
  };
}

function resourceWatchMode(
  manifest: Pick<ConnectorManifest, "supportsWatches" | "supportsPolling">,
  now: string,
): { watchType: "incremental" | "webhook"; nextPollAt: string | null } {
  if (!manifest.supportsWatches) {
    throw new ApiError(422, "watch_not_supported", "This connector does not support resource watches");
  }
  return manifest.supportsPolling
    ? { watchType: "incremental", nextPollAt: now }
    : { watchType: "webhook", nextPollAt: null };
}

function encodeResourceCursor(cursor: ResourceCursor): string {
  return btoa(JSON.stringify([cursor.updatedAt, cursor.id]))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function decodeResourceCursor(value: string): ResourceCursor {
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(base64));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("invalid cursor shape");
    const [updatedAt, id] = parsed;
    if (
      typeof updatedAt !== "string"
      || !Number.isFinite(Date.parse(updatedAt))
      || typeof id !== "string"
      || id.length === 0
      || id.length > 100
    ) throw new Error("invalid cursor values");
    return { updatedAt, id };
  } catch {
    throw new ApiError(422, "invalid_resource_cursor", "The resource cursor is invalid or expired");
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function safeFilename(value: string): string {
  return value.replace(/[\r\n"\\]/gu, "_").slice(0, 180) || "attachment";
}

export const __resourceServiceTesting = {
  enableResourceWatchSql: ENABLE_RESOURCE_WATCH_SQL,
  resourceWithWatchStateSql: RESOURCE_WITH_WATCH_STATE_SQL,
  encodeResourceCursor,
  decodeResourceCursor,
  escapeLikePattern,
  resourceWatchMode,
};
