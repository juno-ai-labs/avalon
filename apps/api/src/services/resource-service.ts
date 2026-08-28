import { ConnectorError, type ConnectorConnectionContext } from "@rally/connectors";
import {
  classifyAttachmentKind,
  IdSchema,
  ResourceVersionCauseSchema,
  type ConnectorManifest,
  type ResourceRevision,
  type ResourceVersionAuthor,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import type { AuthContext, Env } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { createResourceObjectPort } from "../runtime/resource-port";
import { allocateResourceSlugBesideCreation } from "./resource-slug";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { truncateUtf16Safe } from "../lib/text";
import { withAuthorizedConnection } from "./connector-connection-access";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { encryptString, sha256Hex } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { verifyAttachmentMimeType } from "./attachment-mime-verification";
import {
  materializeAttachmentDerivative,
  ocrPdfWithWorkersAi,
  type AuthorizedDerivativeResource,
} from "./attachment-derivative-service";
import { emitProductUsageTelemetry } from "../telemetry/product-usage";

function resourceTelemetryConnector(value: unknown):
  'google' | 'generic_webhook' | 'github' | 'granola' | 'linear' | 'notion' | 'slack' | 'x' | 'avalon' {
  if (value === 'google' || value === 'generic_webhook' || value === 'github' || value === 'granola'
    || value === 'linear' || value === 'notion' || value === 'slack' || value === 'x') return value;
  return 'avalon';
}
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { refreshWorkspaceSchedule } from "./workstream-wakeup-service";

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

const UPLOAD_RESOURCE_VISIBILITY_SQL = `(r.provider != 'avalon_upload'
  OR r.attachment_status = 'attached'
  OR r.uploaded_by_user_id = ?)`;

const NOTE_RESOURCE_VISIBILITY_SQL = `(r.provider != 'avalon_note' OR EXISTS (
  SELECT 1 FROM notes note_visibility
  WHERE note_visibility.resource_id = r.id
    AND note_visibility.workspace_id = r.workspace_id
    AND note_visibility.archived_at IS NULL
    AND (note_visibility.scope = 'workspace' OR note_visibility.owner_user_id = ?)
))`;

const RESOURCE_WITH_WATCH_STATE_SQL = `SELECT r.*,
    CASE WHEN EXISTS (
      SELECT 1 FROM resource_watches rw
       WHERE rw.resource_id = r.id AND rw.workspace_id = r.workspace_id AND rw.enabled = 1
    ) THEN 1 ELSE 0 END AS watch_enabled
  FROM resources r
  LEFT JOIN connector_connections c ON c.id = r.connection_id
  WHERE r.id = ? AND r.workspace_id = ?
    AND (c.id IS NULL OR c.scope = 'workspace' OR c.owner_user_id = ?)
    AND ${UPLOAD_RESOURCE_VISIBILITY_SQL}
    AND ${NOTE_RESOURCE_VISIBILITY_SQL}`;

export class ResourceService {
  private connectorRegistry: ReturnType<typeof connectorRegistryForEnv> | undefined;
  private readonly env: Env;
  private readonly auth: AuthContext;

  constructor(
    env: Env,
    auth: AuthContext,
    connectorRegistry?: ReturnType<typeof connectorRegistryForEnv>,
  ) {
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
    this.connectorRegistry = connectorRegistry;
  }

  async list(input: ListResourcesInput) {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const cursor = input.cursor ? decodeResourceCursor(input.cursor) : null;
    const query = input.query?.trim().toLowerCase();
    const filters = [
      "r.workspace_id = ?",
      "(c.id IS NULL OR c.scope = 'workspace' OR c.owner_user_id = ?)",
      "(r.provider != 'avalon_upload' OR r.attachment_status = 'attached')",
      NOTE_RESOURCE_VISIBILITY_SQL,
    ];
    const bindings: unknown[] = [this.auth.workspaceId, this.auth.userId];
    bindings.push(this.auth.userId);

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
    const consumed = result.results.slice(0, limit);
    const rows: Record<string, unknown>[] = [];
    // A page can contain one hundred resources. Keep cross-DO authorization
    // reads serial so one REST request cannot exceed the Worker's concurrent
    // outbound-connection allowance.
    for (const row of consumed) {
      if (await this.canReadInboundEmailResource(row)) rows.push(row);
    }
    const hasMore = result.results.length > limit;
    const items = rows.map(toResource);
    const last = consumed.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        ? encodeResourceCursor({ updatedAt: String(last.updated_at), id: String(last.id) })
        : null,
    };
  }

  async upload(file: File, title: string | undefined, draftId: string) {
    const maxBytes = numericEnv(this.env, "MAX_ATTACHMENT_BYTES", 25_000_000);
    if (file.size === 0) throw new ApiError(422, "attachment_empty", "Empty files cannot be attached");
    if (file.size > maxBytes) throw new ApiError(413, "attachment_too_large", `Attachments may not exceed ${maxBytes} bytes`);
    const id = draftId;
    const existing = await this.env.DB.prepare(
      `SELECT 1 FROM resources WHERE id = ?`,
    ).bind(id).first();
    if (existing) throw new ApiError(409, "attachment_draft_exists", "This attachment draft already exists");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentSha256 = await sha256Hex(bytes);
    const declaredMimeType = truncateUtf16Safe(file.type || "application/octet-stream", 160);
    const verifiedMimeType = verifyAttachmentMimeType(bytes, file.name, declaredMimeType);
    // A draft UUID may be reused after deletion. Make each original object key
    // generation-specific so an older image/conversion claim cannot publish
    // against a newly uploaded resource with the same UUID.
    const key = `${this.env.AVALON_REGION}/${this.auth.workspaceId}/resources/${id}/${contentSha256}/${crypto.randomUUID()}`;
    await this.env.PAYLOADS.put(key, bytes, {
      httpMetadata: { contentType: verifiedMimeType, contentDisposition: contentDisposition("attachment", file.name) },
      customMetadata: { originalName: file.name, uploadedBy: this.auth.userId },
    });
    const at = nowIso();
    try {
      await this.env.DB.prepare(
        `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          content_sha256, model_content_status, metadata_json, last_hydrated_at,
          uploaded_by_user_id, attachment_status, created_at, updated_at,
          revision_author_kind, revision_author_user_id, revision_cause)
         VALUES (?, ?, 'uploaded_file', 'avalon_upload', ?, ?, ?, ?, 'pending', ?, ?, ?, 'draft', ?, ?,
                 'member', ?, 'created')`,
      ).bind(
        id,
        this.auth.workspaceId,
        // Bounded at the write as well as the read. `title` arrives from a
        // multipart field and the declared MIME from a client-supplied header;
        // neither column constrains length — an unbounded value here becomes a
        // row that fails `ResourceSchema` and `MessageAttachmentSchema` on every
        // later read.
        truncateUtf16Safe(title ?? file.name, 300),
        verifiedMimeType,
        key,
        contentSha256,
        JSON.stringify({ originalName: file.name, size: file.size, declaredMimeType }),
        at,
        this.auth.userId,
        at,
        at,
        this.auth.userId,
      ).run();
    } catch (error) {
      await this.env.PAYLOADS.delete(key).catch(() => undefined);
      throw error;
    }
    await allocateResourceSlugBesideCreation(this.env, this.auth.workspaceId, id);
    return this.get(id);
  }

  async deleteDraft(id: string): Promise<void> {
    const resource = await this.env.DB.prepare(
      `DELETE FROM resources
       WHERE id = ? AND workspace_id = ? AND provider = 'avalon_upload'
         AND uploaded_by_user_id = ? AND attachment_status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM workspace_workstream_resource_links WHERE resource_id = resources.id)
       RETURNING content_ref, model_content_ref`,
    ).bind(id, this.auth.workspaceId, this.auth.userId).first<{
      content_ref: string | null;
      model_content_ref: string | null;
    }>();
    if (!resource) throw new ApiError(404, "attachment_draft_not_found", "The draft attachment is unavailable or already sent");
    // The resource-deletion trigger has durably queued every object. Cleanup is
    // intentionally asynchronous so an R2 outage cannot turn a committed row
    // deletion into an unrecoverable orphan.
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
        title, canonical_url, metadata_json, created_at, updated_at,
        revision_author_kind, revision_author_connection_id, revision_cause)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 'connector', ?, 'created')
       ON CONFLICT DO NOTHING`,
    ).bind(id, this.auth.workspaceId, input.connectionId, input.resourceType, input.provider, input.providerResourceId, input.title, input.canonicalUrl ?? null, at, at, input.connectionId).run();
    const canonical = await this.env.DB.prepare(
      `SELECT id FROM resources
       WHERE workspace_id = ? AND connection_id = ? AND provider = ? AND provider_resource_id = ?`,
    ).bind(this.auth.workspaceId, input.connectionId, input.provider, input.providerResourceId).first<{ id: string }>();
    if (!canonical) throw new ApiError(500, "resource_write_failed", "The resource could not be stored");
    await allocateResourceSlugBesideCreation(this.env, this.auth.workspaceId, canonical.id);
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
    return resourceObjectResponse(object);
  }

  async versions(id: string): Promise<ResourceRevision[]> {
    await this.loadResource(id);
    const result = await this.env.DB.prepare(
      `SELECT * FROM resource_versions
        WHERE resource_id = ? AND workspace_id = ?
        ORDER BY version DESC`,
    ).bind(id, this.auth.workspaceId).all<Record<string, unknown>>();
    return result.results.map(toResourceRevision);
  }

  async version(id: string, version: number): Promise<ResourceRevision> {
    await this.loadResource(id);
    const row = await this.env.DB.prepare(
      `SELECT * FROM resource_versions
        WHERE resource_id = ? AND workspace_id = ? AND version = ?`,
    ).bind(id, this.auth.workspaceId, version).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "resource_version_not_found", "Resource version not found");
    return toResourceRevision(row);
  }

  async versionContent(
    id: string,
    version: number,
    representation: "original" | "model",
  ): Promise<Response> {
    await this.loadResource(id);
    const column = representation === "model" ? "model_content_ref" : "content_ref";
    const row = await this.env.DB.prepare(
      `SELECT ${column} AS object_ref FROM resource_versions
        WHERE resource_id = ? AND workspace_id = ? AND version = ?`,
    ).bind(id, this.auth.workspaceId, version).first<{ object_ref: string | null }>();
    if (!row) throw new ApiError(404, "resource_version_not_found", "Resource version not found");
    if (!row.object_ref) {
      throw new ApiError(404, "resource_version_content_unavailable", "This representation is unavailable for the resource version");
    }
    const object = await this.env.PAYLOADS.get(row.object_ref);
    if (!object) throw new ApiError(404, "resource_version_content_unavailable", "Stored resource version content was not found");
    return resourceObjectResponse(object);
  }

  async preview(id: string, signal: AbortSignal): Promise<Response> {
    const resource = await this.loadResource(id);
    if (typeof resource.content_ref !== "string") throw new ApiError(404, "resource_content_unavailable", "Resource content has not been hydrated");
    const fileName = String(resource.title);
    const mimeType = resource.mime_type == null ? null : String(resource.mime_type);
    const kind = classifyAttachmentKind({ fileName, mimeType });
    const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

    if (kind === "image" || kind === "markdown" || kind === "text" || normalizedMimeType.startsWith("text/")) {
      const object = await this.env.PAYLOADS.get(resource.content_ref);
      if (!object) throw new ApiError(404, "resource_content_unavailable", "Stored resource content was not found");
      return resourceObjectResponse(object, fileName);
    }

    const derivative = await materializeAttachmentDerivative(
      this.env.DB,
      this.env.PAYLOADS,
      authorizedDerivativeResource(resource),
      {
        signal,
        ocr: (bytes, pageCount) => ocrPdfWithWorkersAi(this.env.AI, fileName, bytes, pageCount, signal),
      },
    );
    if (derivative.status === "processing") {
      throw new ApiError(409, "resource_processing", "The attachment preview is still being prepared", {
        retryAfterMs: derivative.retryAfterMs,
      });
    }
    if (derivative.status !== "ready") {
      if (derivative.status === "unsupported") {
        throw new ApiError(422, "resource_preview_unsupported", "This attachment format cannot be previewed");
      }
      throw new ApiError(422, "resource_preview_failed", "Avalon could not prepare this attachment preview", {
        reason: derivative.errorCode,
      });
    }
    const object = await this.env.PAYLOADS.get(derivative.contentRef);
    if (!object) throw new ApiError(404, "resource_preview_unavailable", "The prepared attachment preview was not found");
    return resourceObjectResponse(object, fileName);
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
      const signal = AbortSignal.timeout(numericEnv(this.env, "TOOL_DEFAULT_TIMEOUT_MS", 30_000));
      hydrated = await withAuthorizedConnection(
        this.env,
        { connection: context, adapter, signal },
        (authorized) => adapter.hydrateResource!(authorized, resource, signal),
      );
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "unauthorized") throw error;
      await this.env.DB.prepare(
        // Only from `healthy`: this write carries a diagnosis and must not
        // replace an earlier, more specific one on a row already marked.
        `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'healthy'`,
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
    const serialized = JSON.stringify(hydrated);
    const contentSha256 = await sha256Hex(serialized);
    const idKey = `${this.env.AVALON_REGION}/${this.auth.workspaceId}/resources/${id}/hydrated/${contentSha256}/${crypto.randomUUID()}.json`;
    const at = nowIso();
    if (resource.content_sha256 === contentSha256) {
      await this.env.DB.prepare(
        `UPDATE resources
         SET last_hydrated_at = ?, updated_at = ?,
             revision_author_kind = 'connector', revision_author_run_id = NULL,
             revision_author_user_id = NULL, revision_author_connection_id = ?,
             revision_cause = 'refetched'
         WHERE id = ? AND workspace_id = ? AND content_ref IS ? AND content_sha256 IS ?`,
      ).bind(
        at,
        at,
        connection.id,
        id,
        this.auth.workspaceId,
        resource.content_ref,
        resource.content_sha256,
      ).run();
    } else {
      // Register the unique generation before writing it. If R2 publication,
      // compare-and-swap, or best-effort deletion fails, the regional reaper
      // still owns a durable cleanup record. A winning CAS makes the active
      // pointer check cancel this pending deletion.
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO resource_object_deletion_outbox
          (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
         VALUES (?, ?, ?, 'original', ?, ?)`,
      ).bind(idKey, this.auth.workspaceId, id, at, at).run();
      await this.env.PAYLOADS.put(idKey, serialized, { httpMetadata: { contentType: "application/json" } });
      try {
        const update = await this.env.DB.prepare(
          `UPDATE resources
           SET content_ref = ?, content_sha256 = ?, last_hydrated_at = ?, updated_at = ?,
               model_content_ref = NULL, model_mime_type = NULL, model_content_sha256 = NULL,
               model_metadata_json = NULL,
               model_content_status = 'pending', model_content_extractor_version = NULL,
               model_content_character_count = NULL, model_content_extracted_at = NULL,
               model_content_claimed_at = NULL, model_content_claim_id = NULL,
               model_content_error_code = NULL,
               revision_author_kind = 'connector', revision_author_run_id = NULL,
               revision_author_user_id = NULL, revision_author_connection_id = ?,
               revision_cause = 'refetched'
           WHERE id = ? AND workspace_id = ? AND content_ref IS ? AND content_sha256 IS ?`,
        ).bind(
          idKey,
          contentSha256,
          at,
          at,
          connection.id,
          id,
          this.auth.workspaceId,
          resource.content_ref,
          resource.content_sha256,
        ).run();
        if ((update.meta.changes ?? 0) === 0) {
          await this.env.PAYLOADS.delete(idKey).catch(() => undefined);
        }
      } catch (error) {
        await this.env.PAYLOADS.delete(idKey).catch(() => undefined);
        throw error;
      }
    }
    return this.get(id);
  }

  async watch(id: string, workstreamId: string) {
    const resource = await this.loadResource(id);
    if (resource.connection_id == null) throw new ApiError(422, "watch_not_supported", "Uploaded files cannot be watched for changes");
    const connection = await this.loadConnection(String(resource.connection_id));
    const adapter = this.registry().get(String(connection.connector_type));
    const at = nowIso();
    const mode = resourceWatchMode(adapter.manifest, at);
    const attachments = createResourceObjectPort(this.env, this.auth.workspaceId, workstreamId);
    const watchStatement = this.env.DB.prepare(ENABLE_RESOURCE_WATCH_SQL).bind(
      newId(),
      this.auth.workspaceId,
      workstreamId,
      id,
      resource.connection_id,
      mode.watchType,
      mode.nextPollAt,
      at,
      at,
    );
    // Two authorities, so no single batch spans them: the attachment is the
    // work stream object's and the watch row is regional. The attachment is
    // written first and compensated back if the regional write fails, because
    // an attachment claiming a watch nothing polls is the recoverable half.
    //
    // The read and the write are one operation now. The routed version asked
    // whether the resource was attached, wrote the new flag, and — on failure —
    // wrote back the value it had read three statements earlier, which a
    // concurrent toggle could have replaced in between. `setWatchEnabled`
    // answers with what it replaced, so the compensation restores that.
    const claimed = await attachments.setWatchEnabled({ resourceId: id, watchEnabled: 1 });
    if (claimed.outcome === "not_attached") {
      throw new ApiError(404, "resource_attachment_not_found", "Attach the resource before enabling a watch");
    }
    try {
      await watchStatement.run();
    } catch (error) {
      try {
        await attachments.setWatchEnabled({
          resourceId: id,
          watchEnabled: claimed.previousWatchEnabled,
        });
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          "resource_watch_compensation_failed",
          { cause: compensationError },
        );
      }
      throw error;
    }
    await this.refreshScheduler();
    void emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: 'workstream_resource_action_completed',
      properties: {
        workstreamId,
        resourceId: id,
        resourceType: String(resource.resource_type),
        connectorType: resourceTelemetryConnector(connection.connector_type),
        relationshipType: 'context',
        action: 'watch',
        result: 'success',
        surface: 'workstream',
      },
      operationId: id,
      eventId: newId(),
    }).catch(() => undefined);
    return { watchEnabled: true };
  }

  async unwatch(id: string, workstreamId: string): Promise<void> {
    const resource = await this.loadResource(id);
    const connection = resource.connection_id == null
      ? null
      : await this.loadConnection(String(resource.connection_id));
    const attachments = createResourceObjectPort(this.env, this.auth.workspaceId, workstreamId);
    const watchStatement = this.env.DB.prepare(
      "UPDATE resource_watches SET enabled = 0, updated_at = ? WHERE workstream_id = ? AND resource_id = ?",
    ).bind(nowIso(), workstreamId, id);
    // The mirror of `watch` above, and the same two authorities in the same
    // order for the same reason.
    const claimed = await attachments.setWatchEnabled({ resourceId: id, watchEnabled: 0 });
    if (claimed.outcome === "not_attached") {
      throw new ApiError(404, "resource_attachment_not_found", "The resource is no longer attached");
    }
    try {
      await watchStatement.run();
    } catch (error) {
      try {
        await attachments.setWatchEnabled({
          resourceId: id,
          watchEnabled: claimed.previousWatchEnabled,
        });
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          "resource_unwatch_compensation_failed",
          { cause: compensationError },
        );
      }
      throw error;
    }
    await this.refreshScheduler();
    void emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: 'workstream_resource_action_completed',
      properties: {
        workstreamId,
        resourceId: id,
        resourceType: String(resource.resource_type),
        connectorType: resourceTelemetryConnector(connection?.connector_type),
        relationshipType: 'context',
        action: 'unwatch',
        result: 'success',
        surface: 'workstream',
      },
      operationId: id,
      eventId: newId(),
    }).catch(() => undefined);
  }

  private async loadResource(id: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      RESOURCE_WITH_WATCH_STATE_SQL,
    ).bind(
      id,
      this.auth.workspaceId,
      this.auth.userId,
      this.auth.userId,
      this.auth.userId,
    ).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "resource_not_found", "Resource not found");
    if (!await this.canReadInboundEmailResource(row)) {
      throw new ApiError(404, "resource_not_found", "Resource not found");
    }
    return row;
  }

  private async canReadInboundEmailResource(resource: Record<string, unknown>): Promise<boolean> {
    if (resource.provider !== "resend" || resource.resource_type !== "email") return true;
    const workspace = await this.workspaceDirectory();
    const access = await workspace.resourceAccess({
      workspaceId: this.auth.workspaceId,
      resourceId: String(resource.id),
      userId: this.auth.userId,
    });
    if (access.items.length === 0) return false;
    return access.items.some((item) => item.scope === "workspace" || item.isParticipant);
  }

  private workspaceDirectory() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
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
      credentials = JSON.parse(await decryptVersionedConnectorCredentials(this.env, {
        id: String(row.id),
        encrypted_credentials: row.encrypted_credentials,
        credential_iv: row.credential_iv,
        credential_key_version: Number(row.credential_key_version || 1),
      })) as Record<string, unknown>;
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
    this.connectorRegistry ??= connectorRegistryForEnv(this.env);
    return this.connectorRegistry;
  }

  private async refreshScheduler(): Promise<void> {
    await refreshWorkspaceSchedule(this.env, this.auth.workspaceId);
  }
}

function toResource(row: Record<string, unknown>) {
  const watchEnabled = Number(row.watch_enabled ?? 0) === 1;
  return {
    id: String(row.id),
    // Bounded like `title` below and for the same reason: the column carries no
    // length constraint, and one long row would fail `GET /resources` for the
    // whole workspace rather than for itself.
    slug: row.slug == null ? null : truncateUtf16Safe(String(row.slug), 80),
    workspaceId: String(row.workspace_id), connectionId: row.connection_id == null ? null : String(row.connection_id),
    resourceType: String(row.resource_type), provider: String(row.provider), providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
    // Truncated to `ResourceSchema`'s bounds rather than passed through: the
    // columns have no length constraint, and a row past the bound would fail
    // `GET /resources` for the whole workspace rather than one row.
    title: truncateUtf16Safe(String(row.title), 300),
    mimeType: row.mime_type == null ? null : truncateUtf16Safe(String(row.mime_type), 160),
    canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
    watchEnabled, watchStatus: row.connection_id == null ? "unsupported" : watchEnabled ? "watching" : "paused",
    lastHydratedAt: row.last_hydrated_at == null ? null : String(row.last_hydrated_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    contentAvailable: row.content_ref != null,
    sizeBytes: Math.max(0, Number(parseJson<Record<string, unknown>>(row.metadata_json, {}).size ?? 0)),
    currentVersion: Math.max(1, Number(row.current_version ?? 1)),
  };
}

/**
 * The author a version row names, or null when it names none.
 *
 * A row whose identity does not parse as an id is reported unattributed
 * rather than thrown: the route parses this list against the contract, so one
 * malformed identity would otherwise fail the whole version history for the
 * resource, which is a worse answer than "we do not know who".
 */
function toVersionAuthor(row: Record<string, unknown>): ResourceVersionAuthor | null {
  const identity = (column: string): string | null => {
    const value = nullableString(row[column]);
    return value !== null && IdSchema.safeParse(value).success ? value : null;
  };
  switch (row.author_kind) {
    case "agent": {
      const runId = identity("author_run_id");
      return runId === null ? null : { kind: "agent", runId };
    }
    case "member": {
      const userId = identity("author_user_id");
      return userId === null ? null : { kind: "member", userId };
    }
    case "connector": {
      const connectionId = identity("author_connection_id");
      return connectionId === null ? null : { kind: "connector", connectionId };
    }
    case "system": return { kind: "system" };
    default: return null;
  }
}

function toResourceRevision(row: Record<string, unknown>): ResourceRevision {
  const cause = ResourceVersionCauseSchema.safeParse(row.cause);
  return {
    resourceId: String(row.resource_id),
    version: Math.max(1, Number(row.version)),
    author: toVersionAuthor(row),
    cause: cause.success ? cause.data : null,
    // Every row written so far is an ordinary bucket object, and a row that
    // predates the column was backfilled as one. Bounded because the column
    // deliberately has no CHECK, so its value is a writer's choice.
    storageKind: truncateUtf16Safe(nullableString(row.storage_kind) ?? "object", 40),
    title: truncateUtf16Safe(String(row.title), 300),
    resourceType: String(row.resource_type),
    provider: String(row.provider),
    providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
    mimeType: row.mime_type == null ? null : truncateUtf16Safe(String(row.mime_type), 160),
    canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
    lastHydratedAt: row.last_hydrated_at == null ? null : String(row.last_hydrated_at),
    createdAt: String(row.captured_at),
    contentAvailable: row.content_ref != null,
    modelContentAvailable: row.model_content_ref != null,
    sizeBytes: Math.max(0, Number(parseJson<Record<string, unknown>>(row.metadata_json, {}).size ?? 0)),
  };
}

function authorizedDerivativeResource(row: Record<string, unknown>): AuthorizedDerivativeResource {
  const status = row.model_content_status;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    fileName: String(row.title),
    mimeType: nullableString(row.mime_type),
    contentRef: nullableString(row.content_ref),
    contentSha256: nullableString(row.content_sha256),
    modelContentRef: nullableString(row.model_content_ref),
    modelMimeType: nullableString(row.model_mime_type),
    modelContentSha256: nullableString(row.model_content_sha256),
    modelContentStatus: status === "pending" || status === "processing" || status === "ready"
      || status === "failed" || status === "unsupported" ? status : null,
    modelContentExtractorVersion: nullableString(row.model_content_extractor_version),
    modelContentCharacterCount: typeof row.model_content_character_count === "number"
      ? row.model_content_character_count : null,
    modelContentClaimedAt: nullableString(row.model_content_claimed_at),
    modelContentClaimId: nullableString(row.model_content_claim_id),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function resourceObjectResponse(object: R2ObjectBody, inlineFileName?: string): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=0, no-store");
  if (inlineFileName) headers.set("content-disposition", contentDisposition("inline", inlineFileName));
  return new Response(object.body, { headers });
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

function contentDisposition(disposition: "attachment" | "inline", fileName: string): string {
  const safe = safeFilename(fileName);
  const asciiFallback = safe.replace(/[^\x20-\x7e]/gu, "_");
  const encoded = encodeURIComponent(safe)
    .replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export const __resourceServiceTesting = {
  enableResourceWatchSql: ENABLE_RESOURCE_WATCH_SQL,
  resourceWithWatchStateSql: RESOURCE_WITH_WATCH_STATE_SQL,
  encodeResourceCursor,
  decodeResourceCursor,
  escapeLikePattern,
  resourceWatchMode,
};
