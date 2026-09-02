
import {
  WorkspaceReserveDraftAttachmentsResultSchema,
  type WorkspaceReleaseDraftAttachmentsRequest,
  type WorkspaceReserveDraftAttachmentsRequest,
  type WorkspaceReserveDraftAttachmentsResult,
} from "./workspace-draft-attachment-protocol";

/**
 * Reservations that hold an uploaded resource against one composing input until
 * the work stream that will own it exists.
 *
 * Apart from the RPC class because reserve and release are two halves of one
 * fence: a reservation is keyed by the exact (workspace, work stream, input,
 * resource) identity, and the directory projection in
 * `workspace-directory-storage.ts` releases it on that same key when the resource
 * becomes canonical. All three sites have to agree on the identity, so the two
 * written here stay together.
 */


/** Hold the named draft resources against one composing input, idempotently. */
export function reserveWorkspaceDraftAttachments(
  storage: DurableObjectStorage,
  request: WorkspaceReserveDraftAttachmentsRequest,
): WorkspaceReserveDraftAttachmentsResult {
const result = storage.transactionSync(() => {
  const existing = storage.sql.exec<{
    workspace_id: string;
    workstream_id: string;
    input_id: string;
    resource_id: string;
    user_id: string;
  }>(
    `SELECT workspace_id, workstream_id, input_id, resource_id, user_id
       FROM pending_attachment_reservations
      WHERE input_id = ? ORDER BY resource_id`,
    request.inputId,
  ).toArray();
  const requestedIds = [...new Set(request.resourceIds)].sort();
  if (requestedIds.length !== request.resourceIds.length) {
    return WorkspaceReserveDraftAttachmentsResultSchema.parse({ outcome: "unavailable" });
  }
  if (existing.length > 0) {
    const existingIds = existing.map((row) => row.resource_id).sort();
    const identityMatches = existing.every((row) => (
      row.workspace_id === request.workspaceId
      && row.workstream_id === request.workstreamId
      && row.user_id === request.userId
    ));
    if (!identityMatches || JSON.stringify(existingIds) !== JSON.stringify(requestedIds)) {
      // This is an expected idempotency refusal, not an object failure. A
      // thrown Durable Object RPC error can break the input gate after the
      // caller has already handled the rejection, while the typed
      // unavailable outcome preserves the same fail-closed behavior.
      return WorkspaceReserveDraftAttachmentsResultSchema.parse({ outcome: "unavailable" });
    }
  }
  if (request.resourceIds.length === 0) {
    return WorkspaceReserveDraftAttachmentsResultSchema.parse({
      outcome: existing.length > 0 ? "replayed" : "reserved",
      resources: [],
    });
  }
  const rows = storage.sql.exec<{
    id: string;
    connection_id: string | null;
    resource_type: string;
    provider: string;
    provider_resource_id: string | null;
    title: string;
    mime_type: string | null;
    content_ref: string | null;
    content_sha256: string | null;
    canonical_url: string | null;
    metadata_json: string;
    model_content_ref: string | null;
    model_mime_type: string | null;
    model_content_sha256: string | null;
    model_metadata_json: string | null;
    model_content_status: "pending" | "processing" | "ready" | "failed" | "unsupported" | null;
    model_content_extractor_version: string | null;
    model_content_error_code: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, connection_id, resource_type, provider, provider_resource_id, title,
            mime_type, content_ref, content_sha256, canonical_url, metadata_json,
            model_content_ref, model_mime_type, model_content_sha256,
            model_metadata_json, model_content_status, model_content_extractor_version,
            model_content_error_code, created_at, updated_at
       FROM resources
      WHERE workspace_id = ? AND uploaded_by_user_id = ?
        AND attachment_status = 'draft'
        AND id IN (SELECT value FROM json_each(?))`,
    request.workspaceId,
    request.userId,
    JSON.stringify(request.resourceIds),
  ).toArray();
  if (rows.length !== request.resourceIds.length) {
    return WorkspaceReserveDraftAttachmentsResultSchema.parse({ outcome: "unavailable" });
  }
  if (existing.length === 0) {
    const now = Date.now();
    for (const resourceId of request.resourceIds) {
      storage.sql.exec(
        `INSERT INTO pending_attachment_reservations
           (workspace_id, workstream_id, input_id, resource_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        request.workspaceId,
        request.workstreamId,
        request.inputId,
        resourceId,
        request.userId,
        now,
      );
    }
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return WorkspaceReserveDraftAttachmentsResultSchema.parse({
    outcome: existing.length > 0 ? "replayed" : "reserved",
    resources: request.resourceIds.map((resourceId) => {
      const row = byId.get(resourceId)!;
      return {
        id: row.id,
        connectionId: row.connection_id,
        resourceType: row.resource_type,
        provider: row.provider,
        providerResourceId: row.provider_resource_id,
        title: row.title,
        mimeType: row.mime_type,
        contentRef: row.content_ref,
        contentSha256: row.content_sha256,
        canonicalUrl: row.canonical_url,
        metadataJson: row.metadata_json,
        modelContentRef: row.model_content_ref,
        modelMimeType: row.model_mime_type,
        modelContentSha256: row.model_content_sha256,
        modelMetadataJson: row.model_metadata_json,
        modelContentStatus: row.model_content_status,
        modelContentExtractorVersion: row.model_content_extractor_version,
        modelContentErrorCode: row.model_content_error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
  });
});
  return result;
}

/**
 * Drop every reservation for one input, returning how many were held.
 *
 * The caller reconciles the schedule whatever this returns: a preceding attempt
 * may have committed the delete and then lost its response.
 */
export function releaseWorkspaceDraftAttachments(
  storage: DurableObjectStorage,
  request: WorkspaceReleaseDraftAttachmentsRequest,
): number {
const released = storage.sql.exec<{ resource_id: string }>(
  `DELETE FROM pending_attachment_reservations
    WHERE workspace_id = ? AND workstream_id = ? AND input_id = ?
    RETURNING resource_id`,
  request.workspaceId,
  request.workstreamId,
  request.inputId,
).toArray().length;
  return released;
}
