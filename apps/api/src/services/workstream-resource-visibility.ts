import { classifyAttachmentKind, type AttachmentKind, type ExecutionPrincipal } from "@rally/contracts";
import type { ResourceObjectPort } from "../durable-objects/workstream-resource-protocol";
import { BOUND_PARAMETER_ID_CHUNK } from "../durable-objects/bound-parameters";

export interface VisibleWorkstreamResourceRow extends Record<string, unknown> {
  id: string;
  /** Null for a resource the alias backfill has not reached yet. */
  slug: string | null;
  workspace_id: string;
  resource_type: string;
  provider: string;
  title: string;
  mime_type: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  metadata_json: string;
  updated_at: string;
  model_content_ref: string | null;
  model_mime_type: string | null;
  model_content_sha256: string | null;
  model_metadata_json: string | null;
  model_content_status: "pending" | "processing" | "ready" | "failed" | "unsupported" | null;
  model_content_extractor_version: string | null;
  model_content_character_count: number | null;
  model_content_claimed_at: string | null;
  model_content_claim_id: string | null;
  model_content_error_code: string | null;
  relationship_type: string;
  attached_at: string;
  message_attachment: number;
  attached_watch_enabled: number;
  visibility_version: string;
}

export interface VisibleWorkstreamResourceSet {
  rows: VisibleWorkstreamResourceRow[];
  fingerprint: string;
}

export interface VisibleWorkstreamResourceInventory {
  fingerprint: string;
  totalVisibleResources: number;
  totalVisibleMessageAttachments: number;
  groups: Array<{ kind: AttachmentKind; count: number }>;
}

export interface VisibleWorkstreamResourcePage {
  fingerprint: string;
  totalVisibleResources: number;
  totalMatchingResources: number;
  rows: VisibleWorkstreamResourceRow[];
  hasMore: boolean;
}

export class WorkstreamResourceInventoryChangedError extends Error {
  constructor() {
    super("The resource inventory changed while it was being read");
    this.name = "WorkstreamResourceInventoryChangedError";
  }
}

/**
 * Resource ids resolved against the workspace in one statement.
 *
 * Bounds: entries in the `IN (…)` list of the resource lookup below, and so the
 *   bound parameters of that statement — this many ids plus two.
 * Without it: a work stream with more attachments than this builds a statement
 *   past the engine's 100-parameter ceiling, which is refused outright: the
 *   member's rail fails to load rather than loading slowly.
 * Direction: upper bound, imposed by the engine rather than chosen.
 * Trips: nothing. The loop runs more times, the batches are concatenated, and
 *   no caller sees a partial answer.
 * Derive from: the engine's 100-parameter limit, less the two scalars this
 *   statement binds beside its ids. **This was 100 and had been since before
 *   the authority split, which is 102 parameters — one statement over the
 *   ceiling at a full batch.** It is 90 now, matching
 *   `BOUND_PARAMETER_ID_CHUNK`, so the margin is the same one the object side
 *   uses rather than a second guess about the same limit.
 */
const RESOURCE_LOOKUP_BATCH = BOUND_PARAMETER_ID_CHUNK;

/**
 * Resolve the cross-authority resource projection without a cross-database
 * join. Work-stream membership/watch state comes from the WorkstreamDO; the
 * workspace-owned resource and note authorization come from WorkspaceDO.
 */
async function loadVisibleRows(
  database: D1Database,
  attachments: ResourceObjectPort,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    resourceIds?: readonly string[];
  },
): Promise<VisibleWorkstreamResourceRow[]> {
  // The link half, from the object that owns it. The retired statement asked
  // whether each resource also rides on a transcript message as a correlated
  // `EXISTS` per row, across two compatibility views over two tables in this
  // *same* object — so it is one more read of the object's own rows rather than
  // a subquery repeated per attachment.
  const local = await attachments.attachedLinks(
    input.resourceIds ? { resourceIds: input.resourceIds } : {},
  );
  if (local.length === 0) return [];
  const onMessages = new Set(await attachments.resourceIdsOnMessages({
    resourceIds: local.map((link) => link.resource_id),
  }));
  const resources: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < local.length; offset += RESOURCE_LOOKUP_BATCH) {
    const ids = local.slice(offset, offset + RESOURCE_LOOKUP_BATCH).map((link) => link.resource_id);
    const placeholders = ids.map(() => "?").join(", ");
    const result = await database.prepare(
      `SELECT resource.*,
              COALESCE((SELECT MAX(note.updated_at) FROM notes note
                         WHERE note.resource_id = resource.id), resource.updated_at) AS visibility_version
         FROM resources resource
        WHERE resource.workspace_id = ? AND resource.id IN (${placeholders})
          AND (resource.provider != 'avalon_note' OR EXISTS (
            SELECT 1 FROM notes note
             WHERE note.resource_id = resource.id AND note.workspace_id = resource.workspace_id
               AND note.archived_at IS NULL
               AND (note.scope = 'workspace' OR note.owner_user_id = ?)
          ))`,
    ).bind(input.workspaceId, ...ids, principalUserId(input.principal))
      .all<Record<string, unknown>>();
    resources.push(...(result.results ?? []));
  }
  const byId = new Map(resources.map((resource) => [String(resource.id), resource]));
  return local.flatMap((link) => {
    const resource = byId.get(link.resource_id);
    return resource ? [{
      ...resource,
      relationship_type: link.relationship_type,
      // ISO-8601 because that is what this row publishes and what the sort
      // below compares. The retired view converted it in SQL; the object stores
      // the instant, so the conversion moves here.
      attached_at: new Date(link.attached_at).toISOString(),
      message_attachment: onMessages.has(link.resource_id) ? 1 : 0,
      attached_watch_enabled: Number(link.watch_enabled),
      visibility_version: String(resource.visibility_version ?? resource.updated_at),
    } as VisibleWorkstreamResourceRow] : [];
  }).sort((left, right) => (
    right.attached_at.localeCompare(left.attached_at) || left.id.localeCompare(right.id)
  ));
}

// This CASE mirrors classifyAttachmentKind. Supported upload MIME is
// server-verified; the extension branch is only for generic legacy/connector
// resources. Keeping classification in SQL makes list filtering and inventory
// aggregation bounded by the requested page rather than the work-stream size.
export const ATTACHMENT_KIND_SQL = `CASE
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) LIKE 'image/%' THEN 'image'
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) IN ('text/markdown', 'text/x-markdown') THEN 'markdown'
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) = 'application/pdf' THEN 'pdf'
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) IN ('application/msword', 'application/rtf', 'application/vnd.apple.pages', 'application/vnd.oasis.opendocument.text', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') THEN 'document'
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) IN ('application/vnd.apple.numbers', 'application/vnd.ms-excel', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv') THEN 'spreadsheet'
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) IN ('application/vnd.apple.keynote', 'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation') THEN 'presentation'
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) LIKE 'text/%'
    OR lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) IN ('application/graphql', 'application/javascript', 'application/json', 'application/sql', 'application/toml', 'application/x-httpd-php', 'application/x-javascript', 'application/x-ndjson', 'application/x-sh', 'application/xhtml+xml', 'application/xml', 'application/yaml')
    OR lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) LIKE '%+json'
    OR lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) LIKE '%+xml' THEN 'text'
  WHEN lower(trim(substr(COALESCE(mime_type, ''), 1, instr(COALESCE(mime_type, '') || ';', ';') - 1))) NOT IN ('', 'application/octet-stream', 'binary/octet-stream') THEN 'other'
  WHEN lower(title) GLOB '*.' || 'md' OR lower(title) GLOB '*.' || 'markdown' OR lower(title) GLOB '*.' || 'mdown' THEN 'markdown'
  WHEN lower(title) GLOB '*.' || 'pdf' THEN 'pdf'
  WHEN lower(title) GLOB '*.' || 'doc' OR lower(title) GLOB '*.' || 'docx' OR lower(title) GLOB '*.' || 'odt' OR lower(title) GLOB '*.' || 'pages' OR lower(title) GLOB '*.' || 'rtf' THEN 'document'
  WHEN lower(title) GLOB '*.' || 'csv' OR lower(title) GLOB '*.' || 'numbers' OR lower(title) GLOB '*.' || 'ods' OR lower(title) GLOB '*.' || 'xls' OR lower(title) GLOB '*.' || 'xlsm' OR lower(title) GLOB '*.' || 'xlsx' THEN 'spreadsheet'
  WHEN lower(title) GLOB '*.' || 'key' OR lower(title) GLOB '*.' || 'odp' OR lower(title) GLOB '*.' || 'ppt' OR lower(title) GLOB '*.' || 'pptx' THEN 'presentation'
  WHEN lower(title) GLOB '*.' || 'apng' OR lower(title) GLOB '*.' || 'avif' OR lower(title) GLOB '*.' || 'gif' OR lower(title) GLOB '*.' || 'heic' OR lower(title) GLOB '*.' || 'heif' OR lower(title) GLOB '*.' || 'jpeg' OR lower(title) GLOB '*.' || 'jpg' OR lower(title) GLOB '*.' || 'png' OR lower(title) GLOB '*.' || 'tif' OR lower(title) GLOB '*.' || 'tiff' OR lower(title) GLOB '*.' || 'webp' THEN 'image'
  WHEN lower(title) GLOB '*.' || 'c' OR lower(title) GLOB '*.' || 'cc' OR lower(title) GLOB '*.' || 'cpp' OR lower(title) GLOB '*.' || 'css' OR lower(title) GLOB '*.' || 'go' OR lower(title) GLOB '*.' || 'h' OR lower(title) GLOB '*.' || 'html' OR lower(title) GLOB '*.' || 'java' OR lower(title) GLOB '*.' || 'js' OR lower(title) GLOB '*.' || 'json' OR lower(title) GLOB '*.' || 'jsx' OR lower(title) GLOB '*.' || 'log' OR lower(title) GLOB '*.' || 'py' OR lower(title) GLOB '*.' || 'rb' OR lower(title) GLOB '*.' || 'rs' OR lower(title) GLOB '*.' || 'sh' OR lower(title) GLOB '*.' || 'sql' OR lower(title) GLOB '*.' || 'toml' OR lower(title) GLOB '*.' || 'ts' OR lower(title) GLOB '*.' || 'tsx' OR lower(title) GLOB '*.' || 'txt' OR lower(title) GLOB '*.' || 'xml' OR lower(title) GLOB '*.' || 'yaml' OR lower(title) GLOB '*.' || 'yml' THEN 'text'
  ELSE 'other'
END`;

function principalUserId(principal: ExecutionPrincipal): string | null {
  return principal.type === "user" ? principal.userId : null;
}

export async function loadWorkstreamResourceInventoryFingerprint(
  attachments: ResourceObjectPort,
): Promise<string> {
  // The retired statement's `LEFT JOIN … COALESCE(revision.revision, 0)` did
  // one thing the object does not need: it answered 0 for a work stream whose
  // revision row had never been written. `inventoryRevision` answers 0 for the
  // same case, and the join it replaces existed only because a routed reader
  // had to reach the row through the work stream it belongs to.
  return `inventory:${await attachments.inventoryRevision()}`;
}

export async function loadVisibleWorkstreamResourcesByIds(
  database: D1Database,
  attachments: ResourceObjectPort,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    resourceIds: readonly string[];
  },
): Promise<VisibleWorkstreamResourceRow[]> {
  if (input.resourceIds.length === 0) return [];
  const ids = [...new Set(input.resourceIds)];
  if (ids.length > 8) throw new Error("At most eight resource IDs may be resolved together");
  return loadVisibleRows(database, attachments, { ...input, resourceIds: ids });
}

export async function loadVisibleWorkstreamResourcePage(
  database: D1Database,
  attachments: ResourceObjectPort,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    attachmentKind: AttachmentKind | null;
    limit: number;
    expectedFingerprint?: string;
    after?: { attachedAt: string; resourceId: string } | null;
  },
): Promise<VisibleWorkstreamResourcePage> {
  const before = await loadWorkstreamResourceInventoryFingerprint(attachments);
  if (input.expectedFingerprint && input.expectedFingerprint !== before) {
    throw new WorkstreamResourceInventoryChangedError();
  }
  const visible = await loadVisibleRows(database, attachments, input);
  const matching = visible.filter((row) => !input.attachmentKind || classifyAttachmentKind({
    mimeType: row.mime_type,
    fileName: row.title,
  }) === input.attachmentKind);
  const afterFiltered = matching.filter((row) => !input.after
    || row.attached_at < input.after.attachedAt
    || (row.attached_at === input.after.attachedAt && row.id > input.after.resourceId));
  const fetched = afterFiltered.slice(0, input.limit + 1);
  const after = await loadWorkstreamResourceInventoryFingerprint(attachments);
  if (after !== before) throw new WorkstreamResourceInventoryChangedError();
  return {
    fingerprint: before,
    totalVisibleResources: visible.length,
    totalMatchingResources: matching.length,
    rows: fetched.slice(0, input.limit),
    hasMore: fetched.length > input.limit,
  };
}

export async function loadVisibleWorkstreamResourceInventory(
  database: D1Database,
  attachments: ResourceObjectPort,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    expectedFingerprint?: string;
  },
): Promise<VisibleWorkstreamResourceInventory> {
  const before = await loadWorkstreamResourceInventoryFingerprint(attachments);
  if (input.expectedFingerprint && input.expectedFingerprint !== before) {
    throw new WorkstreamResourceInventoryChangedError();
  }
  const visible = await loadVisibleRows(database, attachments, input);
  const counts = new Map<AttachmentKind, { count: number; messageAttachments: number }>();
  for (const row of visible) {
    const kind = classifyAttachmentKind({ mimeType: row.mime_type, fileName: row.title });
    const entry = counts.get(kind) ?? { count: 0, messageAttachments: 0 };
    entry.count += 1;
    entry.messageAttachments += Number(row.message_attachment);
    counts.set(kind, entry);
  }
  const after = await loadWorkstreamResourceInventoryFingerprint(attachments);
  if (after !== before) throw new WorkstreamResourceInventoryChangedError();
  return {
    fingerprint: before,
    totalVisibleResources: visible.length,
    totalVisibleMessageAttachments: visible.reduce((total, row) => total + Number(row.message_attachment), 0),
    groups: [...counts.entries()].map(([kind, count]) => ({ kind, count: count.count })),
  };
}

export function executionPrincipalKey(principal: ExecutionPrincipal): string {
  return principal.type === "user" ? `user:${principal.userId}` : `workspace:${principal.workspaceId}`;
}
