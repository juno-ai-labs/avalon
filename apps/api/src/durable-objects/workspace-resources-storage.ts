import { isUnlistedResourceMetadata } from "../services/resource-listing";
import { boundParameterChunks } from "./bound-parameters";
import {
  WorkspaceConnectorResourceResolveResultSchema,
  WorkspaceExpiredDraftReapResultSchema,
  WorkspaceInboundEmailResourceResultSchema,
  WorkspaceReapableResourceObjectListSchema,
  WorkspaceResourceDescriptorListSchema,
  WorkspaceResourceExistsResultSchema,
  WorkspaceResourceHydrationResultSchema,
  WorkspaceResourceObjectRemovalResultSchema,
  WorkspaceResourceObjectRetireResultSchema,
  WorkspaceResourceRenameResultSchema,
  WorkspaceResourceSlugBacklogSchema,
  WorkspaceResourceSlugClaimResultSchema,
  WorkspaceResourceVersionListSchema,
  WorkspaceUploadDraftCreateResultSchema,
  WorkspaceUploadDraftDeleteResultSchema,
  type WorkspaceConnectorResourceResolveRequest,
  type WorkspaceConnectorResourceResolveResult,
  type WorkspaceDiscoveredResourcesRequest,
  type WorkspaceExpiredDraftReapResult,
  type WorkspaceInboundEmailResourceRequest,
  type WorkspaceInboundEmailResourceResult,
  type WorkspaceReapableResourceObjectList,
  type WorkspaceResourceDescriptorList,
  type WorkspaceResourceDescriptorsRequest,
  type WorkspaceResourceExistsResult,
  type WorkspaceResourceHydrationPublishRequest,
  type WorkspaceResourceHydrationRefreshRequest,
  type WorkspaceResourceHydrationResult,
  type WorkspaceResourceRenameRequest,
  type WorkspaceResourceRenameResult,
  type WorkspaceResourceObjectFailureRequest,
  type WorkspaceResourceObjectRemovalResult,
  type WorkspaceResourceObjectRetireResult,
  type WorkspaceResourceSlugBacklog,
  type WorkspaceResourceSlugClaimRequest,
  type WorkspaceResourceSlugClaimResult,
  type WorkspaceResourceVersionList,
  type WorkspaceResourceVersionListRequest,
  type WorkspaceResourceWatchDisableRequest,
  type WorkspaceResourceWatchEnableRequest,
  type WorkspaceUploadDraftCreateResult,
  type WorkspaceUploadDraftDeleteRequest,
  type WorkspaceUploadDraftCreateRequest,
  type WorkspaceUploadDraftDeleteResult,
} from "./workspace-resources-protocol";

/**
 * How many rows one workspace maintenance pass over resources takes.
 *
 * Unchanged from the service-side constant it replaces; it lives beside the
 * reads and deletes it bounds so a caller cannot widen a pass by sending a
 * larger number. The slug backfill deliberately shares it — the same alarm
 * doing the same kind of bounded work over the same table; two literals would
 * be two decisions nobody had made.
 */
export const MAXIMUM_RESOURCE_CLEANUP_BATCH = 100;

/**
 * How long an unsent upload draft is kept before the reaper may take it.
 *
 * Unchanged from the service-side constant it replaces, moved beside the
 * delete that enforces it for the same reason as the batch bound above.
 * The workspace alarm's due-time query in
 * `services/workspace-schedule-execution.ts` spells the same 24 hours as
 * `'+24 hours'` in SQL on the other side of the authority boundary — the two
 * must move together, or the alarm fires for drafts the reap will not take.
 */
const DRAFT_ATTACHMENT_TTL_HOURS = 24;

const DESCRIPTOR_COLUMNS = `id, connection_id, resource_type, provider, provider_resource_id,
  title, mime_type, content_ref, content_sha256, canonical_url, metadata_json,
  model_content_ref, model_mime_type, model_content_sha256, model_metadata_json,
  model_content_status, model_content_extractor_version, model_content_error_code,
  created_at, updated_at`;

/** The named resources, in the columns the cross-authority readers consume. */
export function workspaceResourceDescriptors(
  storage: DurableObjectStorage,
  request: WorkspaceResourceDescriptorsRequest,
): WorkspaceResourceDescriptorList {
  const items: Record<string, unknown>[] = [];
  const draftFilter = request.draftUploadedByUserId === null
    ? ""
    : ` AND attachment_status = 'draft' AND uploaded_by_user_id = ?`;
  for (const chunk of boundParameterChunks(request.resourceIds)) {
    items.push(...storage.sql.exec<Record<string, string | number | null>>(
      `SELECT ${DESCRIPTOR_COLUMNS}
         FROM resources
        WHERE workspace_id = ? AND id IN (${chunk.map(() => "?").join(",")})${draftFilter}`,
      request.workspaceId,
      ...chunk,
      ...(request.draftUploadedByUserId === null ? [] : [request.draftUploadedByUserId]),
    ).toArray());
  }
  return WorkspaceResourceDescriptorListSchema.parse({ items });
}

export function workspaceResourceExists(
  storage: DurableObjectStorage,
  workspaceId: string,
  resourceId: string,
): WorkspaceResourceExistsResult {
  const row = storage.sql.exec(
    `SELECT 1 AS present FROM resources WHERE id = ? AND workspace_id = ?`,
    resourceId,
    workspaceId,
  ).toArray()[0];
  return WorkspaceResourceExistsResultSchema.parse({ exists: row !== undefined });
}

/**
 * Commit an upload draft and adopt its staged object, or write neither.
 *
 * The row and the staging retirement are one transaction: once the pointer is
 * committed, the pre-registered `resource_object_deletion_outbox` row exists
 * only to protect bytes that are now referenced, so it goes in the same
 * commit. A duplicate id is an outcome rather than a primary-key throw — the
 * separate existence check the service ran first could lose a race to a
 * concurrent upload of the same draft id, and the loser surfaced as a 500.
 */
export function createWorkspaceUploadDraft(
  storage: DurableObjectStorage,
  request: WorkspaceUploadDraftCreateRequest,
): WorkspaceUploadDraftCreateResult {
  return storage.transactionSync(() => {
    const existing = storage.sql.exec(
      `SELECT 1 AS present FROM resources WHERE id = ? AND workspace_id = ?`,
      request.resourceId,
      request.workspaceId,
    ).toArray()[0];
    if (existing) {
      return WorkspaceUploadDraftCreateResultSchema.parse({ outcome: "draft_exists" });
    }
    storage.sql.exec(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          content_sha256, model_content_status, metadata_json, last_hydrated_at,
          uploaded_by_user_id, attachment_status, created_at, updated_at,
          revision_author_kind, revision_author_user_id, revision_cause)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', ?, ?, ?, ?, 'pending', ?, ?, ?, 'draft',
               ?, ?, 'member', ?, 'created')`,
      request.resourceId,
      request.workspaceId,
      request.title,
      request.mimeType,
      request.contentRef,
      request.contentSha256,
      request.metadataJson,
      request.at,
      request.uploadedByUserId,
      request.at,
      request.at,
      request.uploadedByUserId,
    );
    storage.sql.exec(
      `DELETE FROM resource_object_deletion_outbox
        WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
      request.workspaceId,
      request.contentRef,
    );
    return WorkspaceUploadDraftCreateResultSchema.parse({ outcome: "created" });
  });
}

/**
 * Delete an unsent draft the caller uploaded; the schema's deletion triggers
 * durably queue its R2 objects for the asynchronous reaper.
 */
export function deleteWorkspaceUploadDraft(
  storage: DurableObjectStorage,
  request: WorkspaceUploadDraftDeleteRequest,
): WorkspaceUploadDraftDeleteResult {
  const deleted = storage.sql.exec<{ id: string }>(
    `DELETE FROM resources
      WHERE id = ? AND workspace_id = ? AND provider = 'avalon_upload'
        AND uploaded_by_user_id = ? AND attachment_status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM canvas_artifacts
                         WHERE resource_id = resources.id)
        AND NOT EXISTS (SELECT 1 FROM pending_attachment_reservations
                         WHERE resource_id = resources.id)
      RETURNING id`,
    request.resourceId,
    request.workspaceId,
    request.userId,
  ).toArray()[0];
  return WorkspaceUploadDraftDeleteResultSchema.parse({
    outcome: deleted?.id === request.resourceId ? "deleted" : "not_found",
  });
}

/**
 * The canonical row for a connector resource, created if absent — the read
 * and the conditional insert in one critical section instead of the three
 * round trips (read, insert-or-ignore, re-read) the service used to make.
 */
export function resolveWorkspaceConnectorResource(
  storage: DurableObjectStorage,
  request: WorkspaceConnectorResourceResolveRequest,
): WorkspaceConnectorResourceResolveResult {
  return storage.transactionSync(() => {
    const authority = request.connectionAuthority;
    if (authority) {
      const connection = storage.sql.exec<{ connector_type: string; scope: string; owner_user_id: string | null;
        model_plugin_id: string | null; granted_scopes_json: string }>(
        `SELECT connector_type, scope, owner_user_id, model_plugin_id, granted_scopes_json
           FROM connector_connections WHERE id = ? AND workspace_id = ? AND status <> 'disabled'`,
        request.connectionId, request.workspaceId,
      ).toArray()[0];
      const grants: unknown = connection ? JSON.parse(connection.granted_scopes_json) : null;
      if (!connection || connection.connector_type !== authority.connectorType
        || connection.scope !== authority.scope || connection.owner_user_id !== authority.ownerUserId
        || connection.model_plugin_id !== authority.modelPluginId
        || !Array.isArray(grants) || !authority.requiredCapabilities.every((capability) => grants.includes(capability))) {
        return WorkspaceConnectorResourceResolveResultSchema.parse({ outcome: "connection_unavailable" });
      }
    }
    const existing = storage.sql.exec<{ id: string }>(
      `SELECT id FROM resources
        WHERE workspace_id = ? AND connection_id = ? AND provider = ? AND provider_resource_id = ?`,
      request.workspaceId,
      request.connectionId,
      request.provider,
      request.providerResourceId,
    ).toArray()[0];
    if (existing) {
      if (request.protectedAccessJson) {
        storage.sql.exec("UPDATE resources SET protected_access_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
          request.protectedAccessJson, request.at, existing.id, request.workspaceId);
      }
      return WorkspaceConnectorResourceResolveResultSchema.parse({
        resourceId: existing.id,
        outcome: "existing",
      });
    }
    storage.sql.exec(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, canonical_url, protected_access_json, metadata_json, created_at, updated_at,
          revision_author_kind, revision_author_connection_id, revision_cause)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 'connector', ?, 'created')`,
      request.candidateResourceId,
      request.workspaceId,
      request.connectionId,
      request.resourceType,
      request.provider,
      request.providerResourceId,
      request.title,
      request.canonicalUrl,
      request.protectedAccessJson ?? null,
      request.at,
      request.at,
      request.connectionId,
    );
    return WorkspaceConnectorResourceResolveResultSchema.parse({
      resourceId: request.candidateResourceId,
      outcome: "created",
    });
  });
}

/** The resource's version history, newest first — or one version of it. */
export function listWorkspaceResourceVersions(
  storage: DurableObjectStorage,
  request: WorkspaceResourceVersionListRequest,
): WorkspaceResourceVersionList {
  const versionFilter = request.version === null ? "" : ` AND version = ?`;
  const items = storage.sql.exec<Record<string, string | number | null>>(
    `SELECT resource_id, version, author_kind, author_run_id, author_user_id,
            author_connection_id, cause, storage_kind, title, resource_type, provider,
            provider_resource_id, mime_type, canonical_url, last_hydrated_at, captured_at,
            content_ref, model_content_ref, model_mime_type, model_content_sha256, content_sha256, model_metadata_json, metadata_json
       FROM resource_versions
      WHERE resource_id = ? AND workspace_id = ?${versionFilter}
      ORDER BY version DESC`,
    request.resourceId,
    request.workspaceId,
    ...(request.version === null ? [] : [request.version]),
  ).toArray();
  return WorkspaceResourceVersionListSchema.parse({ items });
}

/**
 * Rename a resource as a person, recording the version that rename makes as
 * theirs and `renamed`. The same title writes nothing: the semantic-version
 * trigger fires on `title` appearing in the SET list, not on it changing.
 */
export function renameWorkspaceResource(
  storage: DurableObjectStorage,
  request: WorkspaceResourceRenameRequest,
): WorkspaceResourceRenameResult {
  const current = storage.sql.exec<{ title: string; metadata_json: string }>(
    `SELECT title, metadata_json FROM resources WHERE id = ? AND workspace_id = ?`,
    request.resourceId,
    request.workspaceId,
  ).toArray()[0];
  if (!current) return WorkspaceResourceRenameResultSchema.parse({ outcome: "not_found" });
  const listed = !isUnlistedResourceMetadata(current.metadata_json);
  if (current.title === request.title) return WorkspaceResourceRenameResultSchema.parse({ outcome: "unchanged", listed });
  storage.sql.exec(
    `UPDATE resources
        SET title = ?, updated_at = ?,
            revision_author_kind = 'member', revision_author_run_id = NULL,
            revision_author_user_id = ?, revision_author_connection_id = NULL,
            revision_cause = 'renamed'
      WHERE id = ? AND workspace_id = ?`,
    request.title,
    request.at,
    request.renamedByUserId,
    request.resourceId,
    request.workspaceId,
  );
  return WorkspaceResourceRenameResultSchema.parse({ outcome: "renamed", listed });
}

/** Record a re-fetch that produced the content the row already holds. */
export function refreshWorkspaceResourceHydration(
  storage: DurableObjectStorage,
  request: WorkspaceResourceHydrationRefreshRequest,
): WorkspaceResourceHydrationResult {
  const updated = storage.sql.exec<{ id: string }>(
    `UPDATE resources
        SET last_hydrated_at = ?, updated_at = ?,
            revision_author_kind = 'connector', revision_author_run_id = NULL,
            revision_author_user_id = NULL, revision_author_connection_id = ?,
            revision_cause = 'refetched'
      WHERE id = ? AND workspace_id = ? AND content_ref IS ? AND content_sha256 IS ?
      RETURNING id`,
    request.at,
    request.at,
    request.connectionId,
    request.resourceId,
    request.workspaceId,
    request.expectedContentRef,
    request.expectedContentSha256,
  ).toArray()[0];
  return WorkspaceResourceHydrationResultSchema.parse({
    updated: updated?.id === request.resourceId,
  });
}

/** Swap in newly hydrated content, resetting the model derivative pipeline. */
export function publishWorkspaceResourceHydration(
  storage: DurableObjectStorage,
  request: WorkspaceResourceHydrationPublishRequest,
): WorkspaceResourceHydrationResult {
  const updated = storage.sql.exec<{ id: string }>(
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
      WHERE id = ? AND workspace_id = ? AND content_ref IS ? AND content_sha256 IS ?
      RETURNING id`,
    request.contentRef,
    request.contentSha256,
    request.at,
    request.at,
    request.connectionId,
    request.resourceId,
    request.workspaceId,
    request.expectedContentRef,
    request.expectedContentSha256,
  ).toArray()[0];
  return WorkspaceResourceHydrationResultSchema.parse({
    updated: updated?.id === request.resourceId,
  });
}

/** Enable — or re-enable, keeping the row's identity — one attachment watch. */
export function enableWorkspaceResourceWatch(
  storage: DurableObjectStorage,
  request: WorkspaceResourceWatchEnableRequest,
): void {
  storage.sql.exec(
    `INSERT INTO resource_watches
       (id, workspace_id, workstream_id, resource_id, connection_id, watch_type,
        cursor_json, next_poll_at, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?)
     ON CONFLICT(workstream_id, resource_id) DO UPDATE SET
       watch_type = excluded.watch_type,
       enabled = 1,
       next_poll_at = excluded.next_poll_at,
       updated_at = excluded.updated_at`,
    request.watchId,
    request.workspaceId,
    request.workstreamId,
    request.resourceId,
    request.connectionId,
    request.watchType,
    request.nextPollAt,
    request.at,
    request.at,
  );
}

/** Pause a watch, keeping its cursor for a later re-enable. */
export function disableWorkspaceResourceWatch(
  storage: DurableObjectStorage,
  request: WorkspaceResourceWatchDisableRequest,
): void {
  storage.sql.exec(
    `UPDATE resource_watches SET enabled = 0, updated_at = ?
      WHERE workspace_id = ? AND workstream_id = ? AND resource_id = ?`,
    request.at,
    request.workspaceId,
    request.workstreamId,
    request.resourceId,
  );
}

/**
 * Outbox rows the reaper should look at: everything eligible for deletion,
 * plus staged rows an active pointer already cancels.
 */
export function listWorkspaceReapableResourceObjects(
  storage: DurableObjectStorage,
  workspaceId: string,
): WorkspaceReapableResourceObjectList {
  const items = storage.sql.exec<Record<string, string | number | null>>(
    `SELECT pending.object_ref, pending.resource_id, pending.object_kind
       FROM resource_object_deletion_outbox pending
      WHERE pending.workspace_id = ?
        -- One indexed lookup per column; see migration 78. Every row here
        -- is this workspace's, so the lookups do not name workspace_id.
        AND (pending.cleanup_eligible = 1
         OR EXISTS (SELECT 1 FROM resources WHERE content_ref = pending.object_ref)
         OR EXISTS (SELECT 1 FROM resources WHERE model_content_ref = pending.object_ref)
         OR EXISTS (SELECT 1 FROM resource_versions WHERE content_ref = pending.object_ref)
         OR EXISTS (SELECT 1 FROM resource_versions WHERE model_content_ref = pending.object_ref))
      ORDER BY pending.created_at ASC, pending.object_ref ASC
      LIMIT ?`,
    workspaceId,
    MAXIMUM_RESOURCE_CLEANUP_BATCH,
  ).toArray();
  return WorkspaceReapableResourceObjectListSchema.parse({ items });
}

/**
 * Decide what one outbox row wants from the reaper, in one critical section.
 *
 * The service used to read whether a pointer still named the object and then
 * retire the row with a delete that re-stated the check, because a deletion
 * could promote the row between the two round trips. One transaction has no
 * such window, and an unreferenced row that a publisher still owns
 * (`cleanup_eligible = 0`) is reported rather than skipped silently.
 */
export function claimWorkspaceResourceObjectRemoval(
  storage: DurableObjectStorage,
  workspaceId: string,
  objectRef: string,
): WorkspaceResourceObjectRemovalResult {
  return storage.transactionSync(() => {
    const row = storage.sql.exec<{ cleanup_eligible: number }>(
      `SELECT cleanup_eligible FROM resource_object_deletion_outbox
        WHERE workspace_id = ? AND object_ref = ?`,
      workspaceId,
      objectRef,
    ).toArray()[0];
    if (!row) {
      return WorkspaceResourceObjectRemovalResultSchema.parse({ outcome: "missing" });
    }
    const referenced = storage.sql.exec(
      `SELECT 1 AS active FROM resources
        WHERE workspace_id = ? AND (content_ref = ? OR model_content_ref = ?)
       UNION ALL
       SELECT 1 AS active FROM resource_versions
        WHERE workspace_id = ? AND (content_ref = ? OR model_content_ref = ?)
       LIMIT 1`,
      workspaceId,
      objectRef,
      objectRef,
      workspaceId,
      objectRef,
      objectRef,
    ).toArray()[0];
    if (referenced) {
      storage.sql.exec(
        `DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?`,
        workspaceId,
        objectRef,
      );
      return WorkspaceResourceObjectRemovalResultSchema.parse({ outcome: "retired" });
    }
    if (row.cleanup_eligible === 0) {
      return WorkspaceResourceObjectRemovalResultSchema.parse({ outcome: "awaiting_publisher" });
    }
    return WorkspaceResourceObjectRemovalResultSchema.parse({ outcome: "removable" });
  });
}

/** Retire one staging row after its bytes were deleted from R2. */
export function retireWorkspaceResourceObjectStaging(
  storage: DurableObjectStorage,
  workspaceId: string,
  objectRef: string,
): WorkspaceResourceObjectRetireResult {
  const retired = storage.sql.exec<{ object_ref: string }>(
    `DELETE FROM resource_object_deletion_outbox
      WHERE workspace_id = ? AND object_ref = ?
      RETURNING object_ref`,
    workspaceId,
    objectRef,
  ).toArray()[0];
  return WorkspaceResourceObjectRetireResultSchema.parse({
    retired: retired?.object_ref === objectRef,
  });
}

/** Count a failed R2 delete against the row so the backlog stays diagnosable. */
export function recordWorkspaceResourceObjectCleanupFailure(
  storage: DurableObjectStorage,
  request: WorkspaceResourceObjectFailureRequest,
): void {
  storage.sql.exec(
    `UPDATE resource_object_deletion_outbox
        SET attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ?
      WHERE workspace_id = ? AND object_ref = ?`,
    request.errorCode,
    request.at,
    request.workspaceId,
    request.objectRef,
  );
}

/**
 * Remove expired, unattached, unreserved upload drafts — the staleness check
 * and the delete as one statement, so a draft attached between a read and a
 * write cannot be lost. The deletion triggers queue every R2 object durably.
 */
export function reapWorkspaceExpiredDraftResources(
  storage: DurableObjectStorage,
  workspaceId: string,
): WorkspaceExpiredDraftReapResult {
  const cutoff = new Date(
    Date.now() - DRAFT_ATTACHMENT_TTL_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  const removed = storage.sql.exec<{ id: string }>(
    `DELETE FROM resources
      WHERE id IN (
        SELECT stale.id FROM resources stale
         WHERE stale.workspace_id = ?
           AND stale.provider = 'avalon_upload'
           AND stale.attachment_status = 'draft'
           AND stale.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM canvas_artifacts link
              WHERE link.resource_id = stale.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM pending_attachment_reservations reservation
              WHERE reservation.resource_id = stale.id
           )
         ORDER BY stale.created_at, stale.id
         LIMIT ?
      )
      RETURNING id`,
    workspaceId,
    cutoff,
    MAXIMUM_RESOURCE_CLEANUP_BATCH,
  ).toArray().length;
  return WorkspaceExpiredDraftReapResultSchema.parse({ removed });
}

/**
 * Give the resource the candidate alias, or say exactly why not.
 *
 * The conditional update and the read that explains a refusal used to be two
 * round trips; here a caller learns in one answer whether it allocated, the
 * row was already named (possibly by a concurrent allocator), the candidate
 * belongs to another row, or the resource is gone — which for a draft deleted
 * mid-creation is an ordinary answer, not an error.
 */
export function claimWorkspaceResourceSlug(
  storage: DurableObjectStorage,
  request: WorkspaceResourceSlugClaimRequest,
): WorkspaceResourceSlugClaimResult {
  return storage.transactionSync(() => {
    const allocated = storage.sql.exec<{ slug: string }>(
      `UPDATE OR IGNORE resources SET slug = ?
        WHERE id = ? AND workspace_id = ? AND slug IS NULL
        RETURNING slug`,
      request.candidate,
      request.resourceId,
      request.workspaceId,
    ).toArray()[0];
    if (allocated?.slug) {
      return WorkspaceResourceSlugClaimResultSchema.parse({
        outcome: "allocated",
        slug: allocated.slug,
      });
    }
    const current = storage.sql.exec<{ slug: string | null }>(
      `SELECT slug FROM resources WHERE id = ? AND workspace_id = ?`,
      request.resourceId,
      request.workspaceId,
    ).toArray()[0];
    if (!current) {
      return WorkspaceResourceSlugClaimResultSchema.parse({ outcome: "missing", slug: null });
    }
    if (current.slug) {
      return WorkspaceResourceSlugClaimResultSchema.parse({
        outcome: "already_named",
        slug: current.slug,
      });
    }
    return WorkspaceResourceSlugClaimResultSchema.parse({ outcome: "candidate_taken", slug: null });
  });
}

/** Resources still waiting for an alias, oldest first, one bounded batch. */
export function listWorkspaceResourcesAwaitingSlug(
  storage: DurableObjectStorage,
  workspaceId: string,
): WorkspaceResourceSlugBacklog {
  const items = storage.sql.exec<{ id: string }>(
    `SELECT id FROM resources
      WHERE workspace_id = ? AND slug IS NULL
      ORDER BY created_at, id
      LIMIT ?`,
    workspaceId,
    MAXIMUM_RESOURCE_CLEANUP_BATCH,
  ).toArray().map((row) => row.id);
  return WorkspaceResourceSlugBacklogSchema.parse({ items });
}

/**
 * The resource for one inbound email, created or refreshed — one critical
 * section instead of insert-or-ignore, re-read, and unconditional update.
 *
 * A write that changes nothing is skipped outright, not narrowed: SQLite's
 * `AFTER UPDATE OF` triggers fire on a column appearing in the SET list, not
 * on its value changing, so the old unconditional refresh recorded a phantom
 * second version of every email — on first ingestion (after its own insert)
 * and again on every lease-takeover replay, whose title, payload pointer and
 * metadata all re-derive byte-identical from the same retrieved message. Even
 * refreshing `last_hydrated_at` alone would fire the trigger, so an identical
 * replay writes nothing at all.
 */
export function upsertWorkspaceInboundEmailResource(
  storage: DurableObjectStorage,
  request: WorkspaceInboundEmailResourceRequest,
): WorkspaceInboundEmailResourceResult {
  return storage.transactionSync(() => {
    const existing = storage.sql.exec<{
      id: string;
      title: string;
      content_ref: string | null;
      metadata_json: string;
    }>(
      `SELECT id, title, content_ref, metadata_json FROM resources
        WHERE workspace_id = ? AND provider = 'resend' AND provider_resource_id = ?`,
      request.workspaceId,
      request.resendEmailId,
    ).toArray()[0];
    if (!existing) {
      storage.sql.exec(
        `INSERT INTO resources
           (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
            title, mime_type, content_ref, canonical_url, metadata_json, last_hydrated_at,
            created_at, updated_at)
         VALUES (?, ?, NULL, 'email', 'resend', ?, ?, 'application/json', ?, NULL, ?, ?, ?, ?)`,
        request.candidateResourceId,
        request.workspaceId,
        request.resendEmailId,
        request.title,
        request.contentRef,
        request.metadataJson,
        request.at,
        request.at,
        request.at,
      );
      return WorkspaceInboundEmailResourceResultSchema.parse({
        resourceId: request.candidateResourceId,
      });
    }
    if (
      existing.title === request.title
      && existing.content_ref === request.contentRef
      && existing.metadata_json === request.metadataJson
    ) {
      return WorkspaceInboundEmailResourceResultSchema.parse({ resourceId: existing.id });
    }
    storage.sql.exec(
      `UPDATE resources SET title = ?, mime_type = 'application/json', content_ref = ?,
         metadata_json = ?, last_hydrated_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
      request.title,
      request.contentRef,
      request.metadataJson,
      request.at,
      request.at,
      existing.id,
      request.workspaceId,
    );
    return WorkspaceInboundEmailResourceResultSchema.parse({ resourceId: existing.id });
  });
}

/**
 * Register the resources a provider webhook mentioned, refreshing the ones
 * this connection already knows — the same conflict target the schema's
 * partial unique index declares. Delivery provenance alone is not a resource
 * change: retain the timestamp and provenance of the last meaningful update.
 */
export function upsertWorkspaceDiscoveredResources(
  storage: DurableObjectStorage,
  request: WorkspaceDiscoveredResourcesRequest,
): void {
  storage.transactionSync(() => {
    for (const resource of request.resources) {
      storage.sql.exec(
        `INSERT INTO resources
           (id, workspace_id, connection_id, resource_type, provider,
            provider_resource_id, title, canonical_url, metadata_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, connection_id, provider, provider_resource_id)
         WHERE connection_id IS NOT NULL AND provider_resource_id IS NOT NULL
         DO UPDATE SET
           resource_type = excluded.resource_type,
           title = excluded.title,
           canonical_url = COALESCE(excluded.canonical_url, resources.canonical_url),
           metadata_json = json_patch(resources.metadata_json, excluded.metadata_json),
           updated_at = excluded.updated_at
         WHERE resources.resource_type IS NOT excluded.resource_type
            OR resources.title IS NOT excluded.title
            OR resources.canonical_url IS NOT COALESCE(excluded.canonical_url, resources.canonical_url)
            OR json_remove(resources.metadata_json, '$.discoveredEventType', '$.discoveredDeliveryId')
               IS NOT json_remove(json_patch(resources.metadata_json, excluded.metadata_json),
                 '$.discoveredEventType', '$.discoveredDeliveryId')`,
        resource.id,
        request.workspaceId,
        request.connectionId,
        resource.resourceType,
        request.provider,
        resource.providerResourceId,
        resource.title,
        resource.canonicalUrl,
        resource.metadataJson,
        request.at,
        request.at,
      );
    }
  });
}
