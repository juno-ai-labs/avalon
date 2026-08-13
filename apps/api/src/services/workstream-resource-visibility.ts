import type { AttachmentKind, ExecutionPrincipal } from "@avalon/contracts";
import { sha256 } from "../lib/crypto";

export interface VisibleWorkstreamResourceRow extends Record<string, unknown> {
  id: string;
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
  model_index_ref: string | null;
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

const VISIBLE_RESOURCE_SELECT = `SELECT r.*, wr.relationship_type, wr.attached_at,
       CASE WHEN EXISTS (
         SELECT 1
           FROM message_attachments ma
           JOIN messages attachment_message
             ON attachment_message.id = ma.message_id
            AND attachment_message.workspace_id = ?1
            AND attachment_message.workstream_id = ?2
          WHERE ma.resource_id = r.id
       ) THEN 1 ELSE 0 END AS message_attachment,
       CASE WHEN rw.id IS NOT NULL THEN 1 ELSE 0 END AS attached_watch_enabled,
       COALESCE((
         SELECT MAX(visible_note.updated_at) FROM notes visible_note
          WHERE visible_note.resource_id = r.id
       ), r.updated_at) AS visibility_version
  FROM workstream_resources wr
  JOIN workstreams ws ON ws.id = wr.workstream_id AND ws.workspace_id = ?1
  JOIN resources r ON r.id = wr.resource_id AND r.workspace_id = ws.workspace_id
  LEFT JOIN resource_watches rw
    ON rw.workstream_id = wr.workstream_id
   AND rw.resource_id = wr.resource_id
   AND rw.enabled = 1
 WHERE wr.workstream_id = ?2
   AND (r.provider != 'avalon_note' OR EXISTS (
     SELECT 1 FROM notes visible_note
      WHERE visible_note.resource_id = r.id
        AND visible_note.workspace_id = ?1
        AND visible_note.workspace_id = r.workspace_id
        AND visible_note.archived_at IS NULL
        AND (visible_note.scope = 'workspace' OR visible_note.owner_user_id = ?3)
   ))`;

// This CASE mirrors classifyAttachmentKind. Supported upload MIME is
// server-verified; the extension branch is only for generic legacy/connector
// resources. Keeping classification in SQL makes list filtering and inventory
// aggregation bounded by the requested page rather than the work-stream size.
const ATTACHMENT_KIND_SQL = `CASE
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

async function inventoryRevision(
  database: D1Database,
  workspaceId: string,
  workstreamId: string,
): Promise<string> {
  const row = await database.prepare(
    `SELECT COALESCE(revision.revision, 0) AS revision
       FROM workstreams workstream
       LEFT JOIN workstream_resource_inventory_revisions revision
         ON revision.workstream_id = workstream.id
        AND revision.workspace_id = workstream.workspace_id
      WHERE workstream.workspace_id = ? AND workstream.id = ?`,
  ).bind(workspaceId, workstreamId).first<{ revision: number }>();
  return `inventory:${row?.revision ?? 0}`;
}

/** Sidebar compatibility path. Model tools and compaction use bounded queries below. */
export async function loadVisibleWorkstreamResources(
  database: D1Database,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    order?: "ascending" | "descending";
  },
): Promise<VisibleWorkstreamResourceSet> {
  const result = await database.prepare(
    `${VISIBLE_RESOURCE_SELECT}
     ORDER BY wr.attached_at ${input.order === "ascending" ? "ASC" : "DESC"}, r.id ASC`,
  ).bind(input.workspaceId, input.workstreamId, principalUserId(input.principal))
    .all<VisibleWorkstreamResourceRow>();
  const rows = result.results ?? [];
  const fingerprint = await sha256(JSON.stringify(rows.map((row) => [
    row.id,
    row.attached_at,
    row.updated_at,
    row.visibility_version,
    row.relationship_type,
    row.message_attachment,
  ])));
  return { rows, fingerprint };
}

export async function loadVisibleWorkstreamResourcesByIds(
  database: D1Database,
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
  const placeholders = ids.map((_id, index) => `?${index + 4}`).join(", ");
  const result = await database.prepare(
    `${VISIBLE_RESOURCE_SELECT}
       AND r.id IN (${placeholders})
     ORDER BY wr.attached_at DESC, r.id ASC`,
  ).bind(input.workspaceId, input.workstreamId, principalUserId(input.principal), ...ids)
    .all<VisibleWorkstreamResourceRow>();
  return result.results ?? [];
}

export async function loadVisibleWorkstreamResourcePage(
  database: D1Database,
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
  const before = await inventoryRevision(database, input.workspaceId, input.workstreamId);
  if (input.expectedFingerprint && input.expectedFingerprint !== before) {
    throw new WorkstreamResourceInventoryChangedError();
  }
  const kindFilter = input.attachmentKind ? `WHERE attachment_kind = '${input.attachmentKind}'` : "";
  const countResult = await database.prepare(
    `WITH visible AS (${VISIBLE_RESOURCE_SELECT}),
          classified AS (SELECT *, ${ATTACHMENT_KIND_SQL} AS attachment_kind FROM visible)
     SELECT COUNT(*) AS total_visible,
            SUM(CASE WHEN ${input.attachmentKind ? `attachment_kind = '${input.attachmentKind}'` : "1 = 1"} THEN 1 ELSE 0 END) AS total_matching
       FROM classified`,
  ).bind(input.workspaceId, input.workstreamId, principalUserId(input.principal)).first<{
    total_visible: number;
    total_matching: number;
  }>();
  const pageResult = await database.prepare(
    `WITH visible AS (${VISIBLE_RESOURCE_SELECT}),
          classified AS (SELECT *, ${ATTACHMENT_KIND_SQL} AS attachment_kind FROM visible)
     SELECT * FROM classified
     ${kindFilter}
     ${kindFilter ? "AND" : "WHERE"} (?4 IS NULL OR attached_at < ?4 OR (attached_at = ?4 AND id > ?5))
     ORDER BY attached_at DESC, id ASC
     LIMIT ?6`,
  ).bind(
    input.workspaceId,
    input.workstreamId,
    principalUserId(input.principal),
    input.after?.attachedAt ?? null,
    input.after?.resourceId ?? null,
    input.limit + 1,
  ).all<VisibleWorkstreamResourceRow>();
  const after = await inventoryRevision(database, input.workspaceId, input.workstreamId);
  if (after !== before) throw new WorkstreamResourceInventoryChangedError();
  const fetched = pageResult.results ?? [];
  return {
    fingerprint: before,
    totalVisibleResources: countResult?.total_visible ?? 0,
    totalMatchingResources: countResult?.total_matching ?? 0,
    rows: fetched.slice(0, input.limit),
    hasMore: fetched.length > input.limit,
  };
}

export async function loadVisibleWorkstreamResourceInventory(
  database: D1Database,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    expectedFingerprint?: string;
  },
): Promise<VisibleWorkstreamResourceInventory> {
  const before = await inventoryRevision(database, input.workspaceId, input.workstreamId);
  if (input.expectedFingerprint && input.expectedFingerprint !== before) {
    throw new WorkstreamResourceInventoryChangedError();
  }
  const result = await database.prepare(
    `WITH visible AS (${VISIBLE_RESOURCE_SELECT}),
          classified AS (SELECT *, ${ATTACHMENT_KIND_SQL} AS attachment_kind FROM visible)
     SELECT attachment_kind, COUNT(*) AS count, SUM(message_attachment) AS message_attachments
       FROM classified
      GROUP BY attachment_kind`,
  ).bind(input.workspaceId, input.workstreamId, principalUserId(input.principal)).all<{
    attachment_kind: AttachmentKind;
    count: number;
    message_attachments: number;
  }>();
  const after = await inventoryRevision(database, input.workspaceId, input.workstreamId);
  if (after !== before) throw new WorkstreamResourceInventoryChangedError();
  const rows = result.results ?? [];
  return {
    fingerprint: before,
    totalVisibleResources: rows.reduce((total, row) => total + row.count, 0),
    totalVisibleMessageAttachments: rows.reduce((total, row) => total + row.message_attachments, 0),
    groups: rows.map((row) => ({ kind: row.attachment_kind, count: row.count })),
  };
}

export function executionPrincipalKey(principal: ExecutionPrincipal): string {
  return principal.type === "user" ? `user:${principal.userId}` : `workspace:${principal.workspaceId}`;
}
