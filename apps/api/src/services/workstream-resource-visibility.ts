import { classifyAttachmentKind, type AttachmentKind, type ExecutionPrincipal } from "@avalon/contracts";
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

interface LocalResourceLink extends Record<string, unknown> {
  resource_id: string;
  relationship_type: string;
  attached_at: string;
  attached_watch_enabled: number;
  message_attachment: number;
}

/**
 * Resolve the cross-authority resource projection without a cross-database
 * join. Work-stream membership/watch state comes from the WorkstreamDO; the
 * workspace-owned resource and note authorization come from regional D1.
 */
async function loadVisibleRows(
  database: D1Database,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    resourceIds?: readonly string[];
  },
): Promise<VisibleWorkstreamResourceRow[]> {
  const requested = input.resourceIds ? [...new Set(input.resourceIds)] : null;
  const localIds = requested && requested.length > 0
    ? `AND wr.resource_id IN (${requested.map(() => "?").join(", ")})`
    : "";
  const links = await database.prepare(
    `SELECT wr.resource_id, wr.relationship_type, wr.attached_at,
            wr.watch_enabled AS attached_watch_enabled,
            CASE WHEN EXISTS (
              SELECT 1 FROM message_attachments attachment
              JOIN messages message ON message.id = attachment.message_id
               WHERE attachment.resource_id = wr.resource_id
                 AND message.workstream_id = ?
            ) THEN 1 ELSE 0 END AS message_attachment
       FROM workstream_resources wr
      WHERE wr.workstream_id = ? ${localIds}`,
  ).bind(input.workstreamId, input.workstreamId, ...(requested ?? [])).all<LocalResourceLink>();
  const local = links.results ?? [];
  if (local.length === 0) return [];
  const resources: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < local.length; offset += 100) {
    const ids = local.slice(offset, offset + 100).map((link) => link.resource_id);
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
      attached_at: link.attached_at,
      message_attachment: Number(link.message_attachment),
      attached_watch_enabled: Number(link.attached_watch_enabled),
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
  const rows = await loadVisibleRows(database, input);
  if (input.order === "ascending") rows.reverse();
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
  return loadVisibleRows(database, { ...input, resourceIds: ids });
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
  const before = await loadWorkstreamResourceInventoryFingerprint(database, input.workspaceId, input.workstreamId);
  if (input.expectedFingerprint && input.expectedFingerprint !== before) {
    throw new WorkstreamResourceInventoryChangedError();
  }
  const visible = await loadVisibleRows(database, input);
  const matching = visible.filter((row) => !input.attachmentKind || classifyAttachmentKind({
    mimeType: row.mime_type,
    fileName: row.title,
  }) === input.attachmentKind);
  const afterFiltered = matching.filter((row) => !input.after
    || row.attached_at < input.after.attachedAt
    || (row.attached_at === input.after.attachedAt && row.id > input.after.resourceId));
  const fetched = afterFiltered.slice(0, input.limit + 1);
  const after = await loadWorkstreamResourceInventoryFingerprint(database, input.workspaceId, input.workstreamId);
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
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    expectedFingerprint?: string;
  },
): Promise<VisibleWorkstreamResourceInventory> {
  const before = await loadWorkstreamResourceInventoryFingerprint(database, input.workspaceId, input.workstreamId);
  if (input.expectedFingerprint && input.expectedFingerprint !== before) {
    throw new WorkstreamResourceInventoryChangedError();
  }
  const visible = await loadVisibleRows(database, input);
  const counts = new Map<AttachmentKind, { count: number; messageAttachments: number }>();
  for (const row of visible) {
    const kind = classifyAttachmentKind({ mimeType: row.mime_type, fileName: row.title });
    const entry = counts.get(kind) ?? { count: 0, messageAttachments: 0 };
    entry.count += 1;
    entry.messageAttachments += Number(row.message_attachment);
    counts.set(kind, entry);
  }
  const after = await loadWorkstreamResourceInventoryFingerprint(database, input.workspaceId, input.workstreamId);
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
