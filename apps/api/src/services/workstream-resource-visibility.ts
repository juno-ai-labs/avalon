import type { ExecutionPrincipal } from "@avalon/contracts";
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

/**
 * The one resource-visibility boundary shared by the sidebar, tools, and later
 * compaction inventory. Results are newest attachment first by default; callers
 * may explicitly request oldest attachment first, but may not add another
 * visibility interpretation.
 */
export async function loadVisibleWorkstreamResources(
  database: D1Database,
  input: {
    workspaceId: string;
    workstreamId: string;
    principal: ExecutionPrincipal;
    order?: "ascending" | "descending";
  },
): Promise<VisibleWorkstreamResourceSet> {
  const principalUserId = input.principal.type === "user" ? input.principal.userId : null;
  const result = await database.prepare(
    `SELECT r.*, wr.relationship_type, wr.attached_at,
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
        ))
      ORDER BY wr.attached_at ${input.order === "ascending" ? "ASC" : "DESC"}, r.id ASC`,
  ).bind(input.workspaceId, input.workstreamId, principalUserId).all<VisibleWorkstreamResourceRow>();
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

export function executionPrincipalKey(principal: ExecutionPrincipal): string {
  return principal.type === "user" ? `user:${principal.userId}` : `workspace:${principal.workspaceId}`;
}
