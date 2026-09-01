import { z } from "zod";

import type { NoteSummary } from "@rally/contracts";

/**
 * The workspace-authority note read the sidebar opens with.
 *
 * The list lives in WorkspaceDO SQLite and is read two ways: by the REST
 * service through the workspace runtime router, and directly by the object
 * itself when it builds the sidebar a workspace socket subscribes to. The
 * statement and the row mapping are shared rather than written twice, because
 * two copies of a query whose results are written into the same client cache
 * drift into two different sidebars — and the socket copy has no response
 * schema of its own to catch it, only the summary contract both must satisfy.
 *
 * The automation half of this pair is gone: the sidebar's automation list is
 * `automation_directory` in WorkspaceDO, projected by AutomationAgent, and the
 * object serves it without a second statement for a REST caller to share.
 *
 * Bindings are positional in both callers: `D1PreparedStatement.bind` and
 * `SqlStorage.exec` take the same `?` parameters in the same order.
 */

/** The sidebar never shows more than this many of either list. */
export const SIDEBAR_LIST_LIMIT = 250;

/** Parameters: workspace id, viewer id, limit. */
export const NOTE_SIDEBAR_SQL = `SELECT * FROM notes
  WHERE workspace_id = ? AND archived_at IS NULL
    AND (scope = 'workspace' OR owner_user_id = ?)
  ORDER BY last_activity_at DESC, id DESC
  LIMIT ?`;

/**
 * The ids of exactly the notes the statement above can put on screen, for a
 * bulk action that must not reach past them.
 *
 * The work-stream list pages, so a mass action over it deliberately counts more
 * rows than the client is holding: the rest are one scroll away. Notes have no
 * cursor and no load-more anywhere in the product, so past `SIDEBAR_LIST_LIMIT`
 * they are not *unloaded*, they are unreachable — and archiving one cannot be
 * undone. A grouping's **Archive all** is therefore fenced to this window: a
 * workspace with more notes than the limit keeps the rest, and they become
 * archivable when they are visible, which is the only point at which somebody
 * could have decided about them.
 *
 * Its visibility fence and ordering are the sidebar's own and must stay that
 * way — a window that ordered differently would expose a different 250 than the
 * list it claims to mirror.
 *
 * Parameters: workspace id, viewer id, limit.
 */
export const NOTE_SIDEBAR_EXPOSABLE_IDS_SQL = `SELECT id FROM notes
  WHERE workspace_id = ? AND archived_at IS NULL
    AND (scope = 'workspace' OR owner_user_id = ?)
  ORDER BY last_activity_at DESC, id DESC
  LIMIT ?`;

/** The `notes` columns the summary is built from. Rows carry more; those are ignored. */
export const NoteSidebarRowSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  owner_user_id: z.string().min(1),
  resource_id: z.string().min(1),
  scope: z.enum(["personal", "workspace"]),
  title: z.string(),
  recording_status: z.enum(["idle", "recording", "complete"]),
  recorded_ms: z.number().int().nonnegative(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  generated_at: z.string().nullable(),
  last_activity_at: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  archived_at: z.string().nullable(),
});

export type NoteSidebarRow = z.infer<typeof NoteSidebarRowSchema>;

export function toNoteSummary(row: NoteSidebarRow): NoteSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    resourceId: row.resource_id,
    ownerUserId: row.owner_user_id,
    scope: row.scope,
    title: row.title,
    recordingStatus: row.recording_status,
    recordedMs: row.recorded_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    generatedAt: row.generated_at,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}
