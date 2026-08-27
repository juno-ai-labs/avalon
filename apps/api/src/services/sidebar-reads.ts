import { z } from "zod";

import type { AutomationSummary, NoteSummary } from "@rally/contracts";

/**
 * The two workspace-authority reads the sidebar opens with, in one place.
 *
 * Both lists live in WorkspaceDO SQLite, and both are now read two ways: by the
 * REST services through the workspace runtime router, and directly by the
 * object itself when it builds the sidebar a workspace socket subscribes to. The
 * statement and the row mapping are shared rather than written twice, because
 * two copies of a query whose results are written into the same client cache
 * drift into two different sidebars — and the socket copy has no response
 * schema of its own to catch it, only the summary contract both must satisfy.
 *
 * Bindings are positional in both callers: `D1PreparedStatement.bind` and
 * `SqlStorage.exec` take the same `?` parameters in the same order.
 */

/** The sidebar never shows more than this many of either list. */
export const SIDEBAR_LIST_LIMIT = 250;

/**
 * Parameters: workspace id, viewer id, limit.
 *
 * A draft is included: it is an automation someone is still setting up, and the
 * sidebar is where they get back to it.
 */
export const AUTOMATION_SIDEBAR_SQL = `SELECT s.id, s.email_address, t.name, t.description,
    s.scope, s.status, s.next_run_at, s.last_run_at, s.updated_at,
    CASE WHEN t.latest_version_number > v.version_number THEN 1 ELSE 0 END AS update_available
  FROM automation_subscriptions s
  JOIN automation_templates t ON t.id = s.template_id
  JOIN automation_template_versions v ON v.id = s.template_version_id
  WHERE s.workspace_id = ? AND t.archived_at IS NULL AND s.lifecycle_state = 'visible'
    AND (s.scope = 'workspace' OR s.owner_user_id = ?)
  ORDER BY t.name COLLATE NOCASE
  LIMIT ?`;

/** Parameters: workspace id, viewer id, limit. */
export const NOTE_SIDEBAR_SQL = `SELECT * FROM notes
  WHERE workspace_id = ? AND archived_at IS NULL
    AND (scope = 'workspace' OR owner_user_id = ?)
  ORDER BY last_activity_at DESC, id DESC
  LIMIT ?`;

/**
 * Columns `AUTOMATION_SIDEBAR_SQL` promises, checked rather than cast.
 *
 * `email_address` is nullable and is served exactly as stored, by both callers.
 * Detail reads verify that full address against the Global claim registry, but
 * a sidebar snapshot deliberately does not make one cross-region RPC per row.
 * A missing value still means no address was ever reserved.
 */
export const AutomationSidebarRowSchema = z.object({
  id: z.string().min(1),
  email_address: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  scope: z.enum(["personal", "workspace"]),
  status: z.enum(["draft", "active", "paused", "error"]),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  updated_at: z.string().min(1),
  update_available: z.number().int(),
});

export type AutomationSidebarRow = z.infer<typeof AutomationSidebarRowSchema>;

export function toAutomationSummary(
  row: AutomationSidebarRow,
  emailAddress: string | null = row.email_address,
): AutomationSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    emailAddress,
    scope: row.scope,
    status: row.status,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    updatedAt: row.updated_at,
    updateAvailable: row.update_available === 1,
  };
}

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
