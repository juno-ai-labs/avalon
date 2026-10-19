import { ArtifactManifestSchema, artifactAssetKey } from "@rally/contracts";
import { resolveAssetPath } from "../artifacts/serving-policy";
import { protectCanvaReference, readCanvaReference } from "./canva-resource-access";
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
import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import {
  connectorRegistryForEnv,
  connectorSupportsResourceHydration,
} from "../lib/connector-registry";
import { encryptString, sha256Hex } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { truncateUtf16Safe } from "../lib/text";
import { createResourceObjectPort } from "../runtime/resource-port";
import { emitProductUsageTelemetry } from "../telemetry/product-usage";
import {
  materializeAttachmentDerivative,
  ocrPdfWithWorkersAi,
  type AuthorizedDerivativeResource,
} from "./attachment-derivative-service";
import { verifyAttachmentMimeType } from "./attachment-mime-verification";
import { type ModelAttachmentSource, loadBrowserCompatibleImage } from "./attachment-model-content";
import type { AccessContext } from './authorization-policy';
import { createAccessContext, requireAuthorizedRead } from './authorization-service';
import { withAuthorizedConnection } from "./connector-connection-access";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { listedResourceVisibilitySql } from './resource-listing';
import { putStagedResourceObject, releaseStagedResourceObject } from "./resource-object-cleanup";
import { preparePastedText } from "./pasted-text-service";
import { allocateResourceSlugBesideCreation } from "./resource-slug";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { refreshWorkspaceSchedule } from "./workstream-wakeup-service";

function resourceTelemetryConnector(value: unknown):
  'canva' | 'google' | 'generic_webhook' | 'github' | 'granola' | 'linear' | 'notion' | 'slack' | 'x' | 'avalon' {
  if (value === 'canva' || value === 'google' || value === 'generic_webhook' || value === 'github' || value === 'granola'
    || value === 'linear' || value === 'notion' || value === 'slack' || value === 'x') return value;
  return 'avalon';
}

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
  /**
   * Restrict the page to these resource types.
   *
   * Absent means every type, which is what the product's own list wants. An
   * empty array is deliberately not the same thing: it is a caller whose set
   * of admissible types came out empty, and handing it the workspace's
   * resources would be offering precisely what it cannot use. The caller that
   * needs this is the Sidekick drafting search, `resources_search`, whose
   * admissible set is `automationBindableResourceTypes`.
   *
   * The rows live in WorkspaceDO's SQLite, reached through
   * `withWorkspaceRuntimeDatabase`, so each type here is one more bound
   * parameter on that statement. Eleven types are declared across every
   * shipped connector today and the list is authored in code rather than by a
   * caller, so no bound is set on it; a future source of types that a person
   * or a model can lengthen is the point at which that stops being true.
   */
  resourceTypes?: readonly string[] | undefined;
}

interface ResourceCursor {
  updatedAt: string;
  id: string;
}

const UPLOAD_RESOURCE_VISIBILITY_SQL = `(r.provider != 'avalon_upload'
  OR r.attachment_status = 'attached'
  OR r.uploaded_by_user_id = ?)`;

const NOTE_RESOURCE_VISIBILITY_SQL = `(r.provider != 'avalon_note')`;

const RESOURCE_WITH_WATCH_STATE_SQL = `SELECT r.*,
    c.connector_type AS connector_type,
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
  private readonly access: AccessContext;

  constructor(
    env: Env,
    auth: AuthContext,
    connectorRegistry?: ReturnType<typeof connectorRegistryForEnv>,
    access?: AccessContext,
  ) {
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
    this.connectorRegistry = connectorRegistry;
    this.access = access ?? createAccessContext(env, auth);
  }

  private async authorizeRead(id: string): Promise<void> {
    requireAuthorizedRead(await this.access.check({
      kind: 'resource', workspaceId: this.auth.workspaceId, resourceId: IdSchema.parse(id),
    }));
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
      // Enumeration only. `RESOURCE_WITH_WATCH_STATE_SQL` deliberately omits
      // this: an unlisted resource is still fetched, opened and downloaded by
      // whoever holds its id.
      listedResourceVisibilitySql('r'),
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
    if (input.resourceTypes) {
      if (input.resourceTypes.length === 0) return { items: [], complete: true, nextCursor: null };
      filters.push(`r.resource_type IN (${input.resourceTypes.map(() => "?").join(", ")})`);
      bindings.push(...input.resourceTypes);
    }
    if (cursor) {
      filters.push("(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))");
      bindings.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }

    const result = await this.env.DB.prepare(
      `SELECT r.*,
        c.connector_type AS connector_type,
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
    const decisions = await this.access.checkMany(consumed.map((row) => ({
      kind: 'resource', workspaceId: this.auth.workspaceId, resourceId: IdSchema.parse(row.id),
    })));
    decisions.forEach((decision, index) => {
      const row = consumed[index];
      if (decision.status === 'allowed' && row) rows.push(row);
    });
    const hasMore = result.results.length > limit;
    const items = rows.map((row) => this.toResource(row));
    const last = consumed.at(-1);
    return {
      items,
      complete: decisions.every((decision) => decision.status !== 'unavailable'),
      nextCursor: hasMore && last
        ? encodeResourceCursor({ updatedAt: String(last.updated_at), id: String(last.id) })
        : null,
    };
  }

  async upload(file: File, title: string | undefined, draftId: string,
    importIdentity?: { operationId: string; sourceRole: "user" | "assistant"; sourceKind: "attachment" | "artifact"; fileIndex: string },
    pastedText = false) {
    const maxBytes = numericEnv(this.env, "MAX_ATTACHMENT_BYTES", 25_000_000);
    if (file.size === 0) throw new ApiError(422, "attachment_empty", "Empty files cannot be attached");
    if (file.size > maxBytes) throw new ApiError(413, "attachment_too_large", `Attachments may not exceed ${maxBytes} bytes`);
    const id = draftId;
    const workspace = await this.workspaceDirectory();
    const { exists } = await workspace.resourceExists({
      workspaceId: this.auth.workspaceId,
      resourceId: id,
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentSha256 = await sha256Hex(bytes);
    if (exists) {
      const existing = importIdentity ? await this.loadResource(id) : null;
      const metadata = existing ? JSON.parse(String(existing['metadata_json'] ?? "{}")) as Record<string, unknown> : {};
      if (existing && existing['uploaded_by_user_id'] === this.auth.userId
        && existing['content_sha256'] === contentSha256
        && existing['title'] === truncateUtf16Safe(title ?? file.name, 300)
        && metadata['originalName'] === file.name
        && metadata['declaredMimeType'] === truncateUtf16Safe(file.type || 'application/octet-stream', 160)
        && JSON.stringify(metadata['importIdentity']) === JSON.stringify(importIdentity)) return this.get(id);
      throw new ApiError(409, "attachment_draft_exists", "This attachment draft already exists");
    }
    // Typed and named only once the upload is known to be new and in bounds,
    // so an empty, oversized or repeated paste never pays for a model call.
    // The text is unchanged, so the bytes and hash above still describe it.
    if (pastedText) {
      file = await preparePastedText(this.env, { workspaceId: this.auth.workspaceId, userId: this.auth.userId, file });
    }
    const declaredMimeType = truncateUtf16Safe(file.type || "application/octet-stream", 160);
    const verifiedMimeType = verifyAttachmentMimeType(bytes, file.name, declaredMimeType);
    // A draft UUID may be reused after deletion. Make each original object key
    // generation-specific so an older image/conversion claim cannot publish
    // against a newly uploaded resource with the same UUID.
    const key = `${this.env.AVALON_REGION}/${this.auth.workspaceId}/resources/${id}/${contentSha256}/${crypto.randomUUID()}`;
    const at = nowIso();
    await putStagedResourceObject({
      database: this.env.DB,
      payloads: this.env.PAYLOADS,
      objectRef: key,
      workspaceId: this.auth.workspaceId,
      resourceId: id,
      objectKind: "original",
      value: bytes,
      options: {
        httpMetadata: { contentType: verifiedMimeType, contentDisposition: contentDisposition("attachment", file.name) },
        customMetadata: { originalName: file.name, uploadedBy: this.auth.userId },
      },
      at,
    });
    // A failed WorkspaceDO response is ambiguous: the resource row may have
    // committed. Keep the object staged in that case so cleanup can observe a
    // committed pointer instead of deleting bytes it names. A typed
    // `draft_exists` is not ambiguous — the object wrote nothing — so the
    // staged object is handed back to the reaper before the 409.
    const created = await workspace.createUploadDraftResource({
      workspaceId: this.auth.workspaceId,
      resourceId: id,
      // Bounded at the write as well as the read. `title` arrives from a
      // multipart field and the declared MIME from a client-supplied header;
      // neither column constrains length — an unbounded value here becomes a
      // row that fails `ResourceSchema` and `MessageAttachmentSchema` on every
      // later read.
      title: truncateUtf16Safe(title ?? file.name, 300),
      mimeType: verifiedMimeType,
      contentRef: key,
      contentSha256,
      metadataJson: JSON.stringify({ originalName: file.name, size: file.size, declaredMimeType,
        ...(importIdentity ? { importIdentity } : {}) }),
      uploadedByUserId: this.auth.userId,
      at,
    });
    if (created.outcome === "draft_exists") {
      await releaseStagedResourceObject(this.env.DB, this.auth.workspaceId, key)
        .catch(() => undefined);
      throw new ApiError(409, "attachment_draft_exists", "This attachment draft already exists");
    }
    await allocateResourceSlugBesideCreation(this.env, this.auth.workspaceId, id);
    return this.get(id);
  }

  async deleteDraft(id: string): Promise<void> {
    const deleted = await (await this.workspaceDirectory()).deleteUploadDraftResource({
      workspaceId: this.auth.workspaceId,
      resourceId: id,
      userId: this.auth.userId,
    });
    if (deleted.outcome === "not_found") {
      throw new ApiError(404, "attachment_draft_not_found", "The draft attachment is unavailable or already sent");
    }
    // The resource-deletion trigger has durably queued every object. Cleanup is
    // intentionally asynchronous so an R2 outage cannot turn a committed row
    // deletion into an unrecoverable orphan.
  }

  async resolve(input: ResolveResourceInput) {
    const connection = await this.loadConnection(input.connectionId);
    if (connection.connector_type !== input.provider && !(connection.connector_type === "google" && input.provider.startsWith("google"))) {
      throw new ApiError(422, "provider_mismatch", "The resource does not belong to the selected connection");
    }
    if (input.provider === "canva" && input.resourceType !== "canva_design") {
      throw new ApiError(422, "resource_type_mismatch", "Canva resources must be designs");
    }
    const canvaReference = input.provider === "canva"
      ? await protectCanvaReference(this.env, this.auth.workspaceId, input.connectionId, input.canonicalUrl ?? input.providerResourceId)
      : null;
    if (canvaReference && canvaReference.designId !== input.providerResourceId) {
      throw new ApiError(422, "provider_resource_mismatch", "The Canva link does not match the design ID");
    }
    // One critical section in the object: the read, the conditional insert
    // and the canonical answer used to be three round trips through the
    // runtime facade, held together by `ON CONFLICT DO NOTHING` and a re-read.
    const canonical = await (await this.workspaceDirectory()).resolveConnectorResource({
      workspaceId: this.auth.workspaceId,
      candidateResourceId: newId(),
      connectionId: input.connectionId,
      provider: input.provider,
      providerResourceId: input.providerResourceId,
      resourceType: input.resourceType,
      title: input.title,
      canonicalUrl: canvaReference?.canonicalUrl ?? input.canonicalUrl ?? null,
      ...(canvaReference ? { protectedAccessJson: canvaReference.protectedAccessJson } : {}),
      at: nowIso(),
    });
    if (canonical.outcome === "created") {
      await allocateResourceSlugBesideCreation(this.env, this.auth.workspaceId, canonical.resourceId);
    }
    return this.get(canonical.resourceId);
  }

  async get(id: string) {
    await this.authorizeRead(id);
    const row = await this.loadResource(id);
    await this.authorizeRead(id);
    return this.toResource(row);
  }

  /**
   * `get` for a resource about to be handed to a container: refused while it
   * is an upload nobody has sent with a message yet, the same refusal a
   * Channel's own attach gives, because a draft is reaped when it expires.
   */
  async getAttachable(id: string) {
    await this.authorizeRead(id);
    const row = await this.loadResource(id);
    await this.authorizeRead(id);
    if (row.provider === "avalon_upload" && row.attachment_status !== "attached") {
      throw new ApiError(409, "attachment_draft_requires_message",
        "Send this upload with a message before attaching it as an existing resource");
    }
    return this.toResource(row);
  }

  /** Annotation targets are existing readable resources, never attachment reservations. */
  async annotationTarget(id: string, version: number): Promise<{ title: string; mimeType: string | null; image: ModelAttachmentSource | null }> {
    await this.authorizeRead(id);
    const resource = await this.loadResource(id);
    if (resource.provider === 'avalon_upload' && resource.attachment_status !== 'attached') {
      throw new ApiError(409, 'annotation_target_draft', 'Send this upload before annotating it');
    }
    const revision = await this.loadVersion(id, version);
    if (!revision) throw new ApiError(404, 'resource_version_not_found', 'The annotated version does not exist');
    await this.authorizeRead(id);
    const image = classifyAttachmentKind({ fileName: revision.title, mimeType: revision.mime_type }) === 'image'
      ? { id, workspaceId: this.auth.workspaceId, fileName: revision.title, mimeType: revision.mime_type ?? 'application/octet-stream', sizeBytes: 0,
          contentRef: revision.content_ref, modelContentRef: revision.model_content_ref,
          modelContentStatus: revision.model_content_ref ? 'ready' as const : null } : null;
    return { title: revision.title, mimeType: revision.mime_type, image };
  }

  /** Opening a search result repeats the same attachment authority checks. */
  async searchPreview(id: string, signal: AbortSignal): Promise<Response> {
    const before = await this.loadSearchResource(id);
    const response = await this.preview(id, signal);
    try {
      const after = await this.loadSearchResource(id);
      if (before.content_ref !== after.content_ref || before.content_sha256 !== after.content_sha256
        || before.mime_type !== after.mime_type) {
        throw new ApiError(409, "search_source_changed", "This file changed. Search again to open its current contents.");
      }
      return response;
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
  }

  private async loadSearchResource(id: string): Promise<Record<string, unknown>> {
    await this.authorizeRead(id);
    const row = await this.loadResource(id);
    await this.authorizeRead(id);
    return row;
  }

  async content(id: string): Promise<Response> {
    await this.authorizeRead(id);
    const resource = await this.loadResource(id);
    if (typeof resource.content_ref !== "string") throw new ApiError(404, "resource_content_unavailable", "Resource content has not been hydrated");
    const object = await this.env.PAYLOADS.get(resource.content_ref);
    if (!object) throw new ApiError(404, "resource_content_unavailable", "Stored resource content was not found");
    await this.authorizeRead(id);
    return resourceObjectResponse(object);
  }

  async versions(id: string): Promise<ResourceRevision[]> {
    await this.authorizeRead(id);
    await this.loadResource(id);
    const history = await (await this.workspaceDirectory()).listResourceVersions({
      workspaceId: this.auth.workspaceId,
      resourceId: id,
      version: null,
    });
    await this.authorizeRead(id);
    return history.items.map(toResourceRevision);
  }

  async version(id: string, version: number): Promise<ResourceRevision> {
    await this.authorizeRead(id);
    await this.loadResource(id);
    const row = await this.loadVersion(id, version);
    if (!row) throw new ApiError(404, "resource_version_not_found", "Resource version not found");
    await this.authorizeRead(id);
    return toResourceRevision(row);
  }

  async versionContent(
    id: string,
    version: number,
    representation: "original" | "model",
  ): Promise<Response> {
    await this.authorizeRead(id);
    await this.loadResource(id);
    const row = await this.loadVersion(id, version);
    if (!row) throw new ApiError(404, "resource_version_not_found", "Resource version not found");
    const objectRef = representation === "model" ? row.model_content_ref : row.content_ref;
    if (!objectRef) {
      throw new ApiError(404, "resource_version_content_unavailable", "This representation is unavailable for the resource version");
    }
    const object = await this.env.PAYLOADS.get(objectRef);
    if (!object) throw new ApiError(404, "resource_version_content_unavailable", "Stored resource version content was not found");
    await this.authorizeRead(id);
    return resourceObjectResponse(object);
  }

  /** Frozen HTML assets only: historical server modules are never executed. */
  async annotationSitePreview(id: string, version: number, pagePath: string): Promise<Response> {
    const original = await this.versionContent(id, version, 'original');
    const manifest = ArtifactManifestSchema.parse(await original.json());
    const registry = await this.env.DB.prepare('SELECT artifact_id FROM artifact_registry WHERE workspace_id = ? AND resource_id = ?')
      .bind(this.auth.workspaceId,id).first<{artifact_id:string}>();
    if (!registry || registry.artifact_id !== manifest.artifactId) throw new ApiError(404,'artifact_not_found','The artifact is unavailable');
    const path = resolveAssetPath(new URL(pagePath,'https://artifact.invalid').pathname,new Set(manifest.assets.filter((asset) => asset.contentType.startsWith('text/html')).map((asset) => asset.path)));
    if (!path) throw new ApiError(404,'annotation_original_page_unavailable','The original page cannot be shown again');
    const object = await this.env.PAYLOADS.get(artifactAssetKey(manifest.artifactId,manifest.artifactVersion,path));
    if (!object) throw new ApiError(404,'annotation_original_page_unavailable','The original page cannot be shown again');
    await this.authorizeRead(id);
    return new Response(object.body,{headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'",'cache-control':'private, no-store'}});
  }

  private async loadVersion(id: string, version: number) {
    const history = await (await this.workspaceDirectory()).listResourceVersions({
      workspaceId: this.auth.workspaceId,
      resourceId: id,
      version,
    });
    return history.items[0] ?? null;
  }

  async preview(id: string, signal: AbortSignal): Promise<Response> {
    await this.authorizeRead(id);
    const response = await this.loadPreview(id, signal);
    try {
      await this.authorizeRead(id);
      return response;
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
  }

  private async loadPreview(id: string, signal: AbortSignal): Promise<Response> {
    const resource = await this.loadResource(id);
    if (typeof resource.content_ref !== "string") throw new ApiError(404, "resource_content_unavailable", "Resource content has not been hydrated");
    const fileName = String(resource.title);
    const mimeType = resource.mime_type == null ? null : String(resource.mime_type);
    const kind = classifyAttachmentKind({ fileName, mimeType });
    const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

    if (kind === "image") {
      if (requiresBrowserImageNormalization(normalizedMimeType, fileName)) {
        const normalized = await loadBrowserCompatibleImage(
          this.env.PAYLOADS,
          {
            id: String(resource.id),
            workspaceId: String(resource.workspace_id),
            fileName,
            mimeType: mimeType ?? "application/octet-stream",
            contentRef: String(resource.content_ref),
            contentSha256: nullableString(resource.content_sha256),
            modelContentRef: nullableString(resource.model_content_ref),
            modelMimeType: nullableString(resource.model_mime_type),
            modelContentSha256: nullableString(resource.model_content_sha256),
            modelMetadataJson: nullableString(resource.model_metadata_json),
          },
          { images: this.env.IMAGES, documentProcessor: this.env.DOCUMENT_PROCESSOR },
        );
        if (!normalized) {
          throw new ApiError(422, "resource_preview_unsupported", "This image format cannot be previewed");
        }
        return resourceBytesResponse(normalized.bytes, normalized.mimeType, fileName);
      }
      const object = await this.env.PAYLOADS.get(resource.content_ref);
      if (!object) throw new ApiError(404, "resource_content_unavailable", "Stored resource content was not found");
      return resourceObjectResponse(object, fileName);
    }
    if (kind === "audio" || kind === "markdown" || kind === "text" || normalizedMimeType.startsWith("text/")) {
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
        pdfExtractor: (bytes) => this.env.DOCUMENT_PROCESSOR.extractText(bytes),
        ocr: (bytes, pageCount) => ocrPdfWithWorkersAi(this.env.AI, fileName, bytes, pageCount, signal,
          { env: this.env, workspaceId: String(resource.workspace_id), sourceId: String(resource.id) }),
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
    await this.authorizeRead(id);
    const resource = await this.loadResource(id);
    if (resource.connection_id == null) return this.toResource(resource);
    const connection = await this.loadConnection(String(resource.connection_id));
    const context = await this.connectionContext(connection);
    const adapter = this.registry().get(String(connection.connector_type));
    if (!adapter.hydrateResource) throw new ApiError(422, "hydration_not_supported", "This connector cannot hydrate resources");
    if (connection.connector_type === "canva") {
      resource.canvaAccessReference = await readCanvaReference(this.env, this.auth.workspaceId,
        String(connection.id), String(resource.provider_resource_id), resource.protected_access_json);
    }
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
      await (await this.workspaceDirectory()).refreshResourceHydration({
        workspaceId: this.auth.workspaceId,
        resourceId: id,
        connectionId: String(connection.id),
        expectedContentRef: nullableString(resource.content_ref),
        expectedContentSha256: nullableString(resource.content_sha256),
        at,
      });
    } else {
      // Register the unique generation before writing it. If R2 publication,
      // compare-and-swap, or best-effort deletion fails, the regional reaper
      // still owns a durable cleanup record. A winning CAS makes the active
      // pointer check cancel this pending deletion.
      await putStagedResourceObject({
        database: this.env.DB,
        payloads: this.env.PAYLOADS,
        objectRef: idKey,
        workspaceId: this.auth.workspaceId,
        resourceId: id,
        objectKind: "original",
        value: serialized,
        options: { httpMetadata: { contentType: "application/json" } },
        at,
      });
      // An RPC failure keeps the object staged because WorkspaceDO may have
      // committed the pointer before its response was lost. A typed
      // `updated: false` is not ambiguous — the fence refused the write — so
      // the staged object goes back to the reaper.
      const update = await (await this.workspaceDirectory()).publishResourceHydration({
        workspaceId: this.auth.workspaceId,
        resourceId: id,
        connectionId: String(connection.id),
        contentRef: idKey,
        contentSha256,
        expectedContentRef: nullableString(resource.content_ref),
        expectedContentSha256: nullableString(resource.content_sha256),
        at,
      });
      if (!update.updated) {
        await releaseStagedResourceObject(this.env.DB, this.auth.workspaceId, idKey)
          .catch(() => undefined);
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
    const workspace = await this.workspaceDirectory();
    const enableWatch = () => workspace.enableResourceWatch({
      workspaceId: this.auth.workspaceId,
      watchId: newId(),
      workstreamId,
      resourceId: id,
      connectionId: String(resource.connection_id),
      watchType: mode.watchType,
      nextPollAt: mode.nextPollAt,
      at,
    });
    // Two authorities, so no single transaction spans them: the attachment is
    // the work stream object's and the watch row is the workspace object's.
    // The attachment is written first and compensated back if the watch write
    // fails, because an attachment claiming a watch nothing polls is the
    // recoverable half.
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
      await enableWatch();
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
    emitProductUsageTelemetry(this.env, {
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
    });
    return { watchEnabled: true };
  }

  async unwatch(id: string, workstreamId: string): Promise<void> {
    const resource = await this.loadResource(id);
    const connection = resource.connection_id == null
      ? null
      : await this.loadConnection(String(resource.connection_id));
    const attachments = createResourceObjectPort(this.env, this.auth.workspaceId, workstreamId);
    const workspace = await this.workspaceDirectory();
    const disableWatch = () => workspace.disableResourceWatch({
      workspaceId: this.auth.workspaceId,
      workstreamId,
      resourceId: id,
      at: nowIso(),
    });
    // The mirror of `watch` above, and the same two authorities in the same
    // order for the same reason.
    const claimed = await attachments.setWatchEnabled({ resourceId: id, watchEnabled: 0 });
    if (claimed.outcome === "not_attached") {
      throw new ApiError(404, "resource_attachment_not_found", "The resource is no longer attached");
    }
    try {
      await disableWatch();
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
    emitProductUsageTelemetry(this.env, {
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
    });
  }

  private async loadResource(id: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      RESOURCE_WITH_WATCH_STATE_SQL,
    ).bind(
      id,
      this.auth.workspaceId,
      this.auth.userId,
      this.auth.userId,
    ).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "resource_not_found", "Resource not found");
    if (row.provider === 'resend' && row.resource_type === 'email') await this.authorizeRead(id);
    return row;
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

  private toResource(row: Record<string, unknown>) {
    const refreshSupported = row.connector_type == null
      ? false
      : connectorSupportsResourceHydration(this.registry(), row.connector_type);
    return toResource(row, refreshSupported);
  }

  private async refreshScheduler(): Promise<void> {
    await refreshWorkspaceSchedule(this.env, this.auth.workspaceId);
  }
}

function toResource(row: Record<string, unknown>, refreshSupported: boolean) {
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
    refreshSupported,
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
    // `renamed` crosses as none: a desktop build from before it parses the
    // whole history with a closed enum and would list none of it, and no
    // client shows a cause yet. Send it once those builds are gone; the
    // contract already reads an unknown cause as none.
    cause: cause.success && cause.data !== "renamed" ? cause.data : null,
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

function resourceBytesResponse(bytes: Uint8Array, mimeType: string, inlineFileName: string): Response {
  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: {
      "cache-control": "private, max-age=0, no-store",
      "content-disposition": contentDisposition("inline", inlineFileName),
      "content-type": mimeType,
    },
  });
}

/** Chromium has no native TIFF or HEIF decoder, even though Rally accepts both. */
function requiresBrowserImageNormalization(mimeType: string, fileName: string): boolean {
  if (/^image\/(?:heic|heif|heic-sequence|heif-sequence|tif|tiff)$/u.test(mimeType)) return true;
  // Verified uploads have a sniffed MIME. The extension fallback also covers
  // connector resources whose provider supplied only generic binary metadata.
  return (!mimeType || mimeType === "application/octet-stream")
    && /\.(?:heic|heif|tif|tiff)$/iu.test(fileName);
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
  resourceWithWatchStateSql: RESOURCE_WITH_WATCH_STATE_SQL,
  encodeResourceCursor,
  decodeResourceCursor,
  escapeLikePattern,
  resourceWatchMode,
};
