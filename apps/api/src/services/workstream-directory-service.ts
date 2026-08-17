import { WorkstreamSchema, type Workstream } from "@avalon/contracts";
import { truncateUtf16Safe } from "@avalon/contracts/text";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";

interface DirectoryRow extends Record<string, unknown> {
  workstream_id: string;
  workspace_id: string;
  title: string;
  description: string;
  scope: "personal" | "workspace";
  state: string;
  system_kind: "digest" | null;
  last_activity_at: string;
  completed_at: string | null;
  archived_at: string | null;
  email_address: string | null;
  origin_type: "ad_hoc" | "automation";
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  planned_for: string | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: string | null;
  next_wakeup_prompt: string | null;
  created_at: string;
  updated_at: string;
  seen_attention_ordinal: number | null;
  manual_unread_from_ordinal: number | null;
  manual_unread_generation: number | null;
  latest_mention_attention_ordinal: number | null;
  is_participant: number | null;
  pin_position: number | null;
  origin_label: string | null;
}

function harnessStatus(state: string): Workstream["harnessStatus"] {
  if (state === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(state)) {
    return "running";
  }
  if (state === "needs_input") return "needs_input";
  if (state === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(state)) return "failed";
  return "idle";
}

function fromRow(row: DirectoryRow): Workstream {
  const latest = Number(row.latest_attention_ordinal);
  const seen = row.seen_attention_ordinal === null
    ? Number(row.unread_tracking_start_ordinal)
    : Number(row.seen_attention_ordinal);
  const manual = row.manual_unread_from_ordinal === null
    ? null
    : Number(row.manual_unread_from_ordinal);
  const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
  const titleStatus = row.title_status === "naming"
    && Date.now() - Date.parse(row.created_at) > 60_000
    ? "automatic"
    : row.title_status;
  return WorkstreamSchema.parse({
    id: row.workstream_id,
    workspaceId: row.workspace_id,
    title: truncateUtf16Safe(row.title, 180),
    titleStatus,
    objective: truncateUtf16Safe(row.description, 4_000),
    emailAddress: row.email_address,
    originType: row.origin_type,
    originLabel: row.origin_label,
    createdByUserId: row.created_by_user_id,
    automationSubscriptionId: row.automation_subscription_id,
    automationRunId: row.automation_run_id,
    plannedFor: row.planned_for,
    harnessStatus: harnessStatus(row.state),
    latestAttentionSequenceNumber: latest,
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: Number(row.manual_unread_generation ?? 0),
    hasUnread: firstUnread !== null,
    youAreMentioned: Number(row.latest_mention_attention_ordinal ?? 0) > seen,
    firstUnreadSequenceNumber: firstUnread,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    scope: row.scope,
    systemKind: row.system_kind,
    nextPendingWakeup: row.next_wakeup_due_at && row.next_wakeup_prompt
      ? {
          dueAt: row.next_wakeup_due_at,
          promptPreview: truncateUtf16Safe(row.next_wakeup_prompt.replace(/\s+/gu, " ").trim(), 40),
        }
      : null,
    pinPosition: row.pin_position,
  });
}

const SELECT_DIRECTORY = `SELECT projection.workstream_id, projection.workspace_id,
    projection.title, projection.description, projection.scope, projection.state,
    projection.system_kind, projection.last_activity_at, projection.completed_at,
    projection.archived_at, projection.email_address, projection.origin_type,
    projection.created_by_user_id, projection.automation_subscription_id,
    projection.automation_run_id, projection.planned_for, projection.title_status,
    projection.latest_attention_ordinal, projection.unread_tracking_start_ordinal,
    projection.next_wakeup_due_at, projection.next_wakeup_prompt,
    projection.created_at, projection.updated_at,
    viewer.seen_attention_ordinal, viewer.manual_unread_from_ordinal,
    viewer.manual_unread_generation, viewer.latest_mention_attention_ordinal,
    viewer.is_participant, pin.position AS pin_position,
    template.name AS origin_label
  FROM workstream_directory_projections projection
  LEFT JOIN workstream_directory_user_projections viewer
    ON viewer.workstream_id = projection.workstream_id AND viewer.user_id = ?1
  LEFT JOIN workstream_pins pin
    ON pin.workstream_id = projection.workstream_id AND pin.user_id = ?1
  LEFT JOIN automation_subscriptions subscription
    ON subscription.id = projection.automation_subscription_id
  LEFT JOIN automation_templates template ON template.id = subscription.template_id`;

/** Workspace/sidebar query model over rebuildable WorkstreamDO projections. */
export class WorkstreamDirectoryService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async list(limit: number, before?: string, includeSystem = false) {
    const result = await this.env.DB.prepare(
      `${SELECT_DIRECTORY}
       WHERE projection.workspace_id = ?2 AND projection.archived_at IS NULL
         AND pin.user_id IS NULL
         AND (?3 = 1 OR projection.system_kind IS NULL)
         AND (projection.scope = 'workspace' OR viewer.is_participant = 1)
         AND (?4 IS NULL OR projection.last_activity_at < ?4)
       ORDER BY projection.last_activity_at DESC, projection.workstream_id
       LIMIT ?5`,
    ).bind(
      this.auth.userId,
      this.auth.workspaceId,
      includeSystem ? 1 : 0,
      before ?? null,
      limit + 1,
    ).all<DirectoryRow>();
    const rows = result.results ?? [];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const nextCursor = hasMore ? rows.at(-1)?.last_activity_at ?? null : null;
    if (!before) rows.push(...await this.pinnedRows(includeSystem));
    return { items: rows.map(fromRow), nextCursor };
  }

  async visible(workstreamId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT 1 AS one FROM workstream_directory_projections projection
       LEFT JOIN workstream_directory_user_projections viewer
         ON viewer.workstream_id = projection.workstream_id AND viewer.user_id = ?
       WHERE projection.workspace_id = ? AND projection.workstream_id = ?
         AND projection.archived_at IS NULL
         AND (projection.scope = 'workspace' OR viewer.is_participant = 1)`,
    ).bind(this.auth.userId, this.auth.workspaceId, workstreamId).first<{ one: number }>();
    return row !== null;
  }

  async plannedForAutomation(
    automationSubscriptionId: string,
    plannedFor: string,
  ): Promise<Workstream | null> {
    const row = await this.env.DB.prepare(
      `${SELECT_DIRECTORY}
       WHERE projection.workspace_id = ?2
         AND projection.automation_subscription_id = ?3
         AND projection.planned_for = ?4
         AND projection.archived_at IS NULL
         AND (projection.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY projection.updated_at DESC, projection.workstream_id
       LIMIT 1`,
    ).bind(
      this.auth.userId,
      this.auth.workspaceId,
      automationSubscriptionId,
      plannedFor,
    ).first<DirectoryRow>();
    return row ? fromRow(row) : null;
  }

  async pinned(): Promise<{ items: Workstream[] }> {
    return { items: (await this.pinnedRows(true)).map(fromRow) };
  }

  async pin(workstreamId: string): Promise<{ items: Workstream[] }> {
    if (!await this.visible(workstreamId)) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT INTO workstream_pins
         (workspace_id, workstream_id, user_id, position, created_at, updated_at)
       SELECT ?, ?, ?, COALESCE((
         SELECT MAX(existing.position) + 1 FROM workstream_pins existing
          WHERE existing.workspace_id = ? AND existing.user_id = ?
       ), 0), ?, ?
       ON CONFLICT(workstream_id, user_id) DO NOTHING`,
    ).bind(
      this.auth.workspaceId,
      workstreamId,
      this.auth.userId,
      this.auth.workspaceId,
      this.auth.userId,
      now,
      now,
    ).run();
    return this.pinned();
  }

  async unpin(workstreamId: string): Promise<{ items: Workstream[] }> {
    const removed = await this.env.DB.prepare(
      `DELETE FROM workstream_pins
        WHERE workspace_id = ? AND workstream_id = ? AND user_id = ?`,
    ).bind(this.auth.workspaceId, workstreamId, this.auth.userId).run();
    if ((removed.meta.changes ?? 0) > 0) await this.reorderPins([]);
    return this.pinned();
  }

  async reorderPins(requestedIds: string[]): Promise<{ items: Workstream[] }> {
    const result = await this.env.DB.prepare(
      `SELECT workstream_id FROM workstream_pins
        WHERE workspace_id = ? AND user_id = ? ORDER BY position, workstream_id`,
    ).bind(this.auth.workspaceId, this.auth.userId).all<{ workstream_id: string }>();
    const current = (result.results ?? []).map((row) => row.workstream_id);
    const pinned = new Set(current);
    const requested = [...new Set(requestedIds)].filter((id) => pinned.has(id));
    const requestedSet = new Set(requested);
    const ids = [...requested, ...current.filter((id) => !requestedSet.has(id))];
    if (ids.length > 0) {
      const now = new Date().toISOString();
      await this.env.DB.batch(ids.map((id, position) => this.env.DB.prepare(
        `UPDATE workstream_pins SET position = ?, updated_at = ?
          WHERE workspace_id = ? AND workstream_id = ? AND user_id = ?`,
      ).bind(position, now, this.auth.workspaceId, id, this.auth.userId)));
    }
    return this.pinned();
  }

  private async pinnedRows(includeSystem: boolean): Promise<DirectoryRow[]> {
    const result = await this.env.DB.prepare(
      `${SELECT_DIRECTORY}
       WHERE projection.workspace_id = ?2 AND projection.archived_at IS NULL
         AND pin.user_id IS NOT NULL
         AND (?3 = 1 OR projection.system_kind IS NULL)
         AND (projection.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY pin.position, projection.workstream_id`,
    ).bind(this.auth.userId, this.auth.workspaceId, includeSystem ? 1 : 0).all<DirectoryRow>();
    return result.results ?? [];
  }
}
