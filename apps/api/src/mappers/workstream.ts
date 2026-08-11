import type { Workstream } from "@avalon/contracts";

/**
 * The columns beyond `workstreams.*` that `toWorkstream` reads, and the joins
 * that produce them. Every caller selects the same shape, because a query that
 * omits one silently produces a work stream that fails contract validation
 * rather than one missing a field.
 */
export const WORKSTREAM_VIEWER_COLUMNS_SQL = `t.name AS origin_label,
  rs.user_id AS viewer_read_state_user_id,
  rs.read_through_sequence_number AS viewer_read_through_sequence_number,
  rs.manual_unread_from_sequence_number AS viewer_manual_unread_from_sequence_number,
  rs.manual_unread_generation AS viewer_manual_unread_generation`;

/** The joins `WORKSTREAM_VIEWER_COLUMNS_SQL` reads from. Binds the viewer's id. */
export const WORKSTREAM_VIEWER_JOINS_SQL = `LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
  LEFT JOIN automation_templates t ON t.id = s.template_id
  LEFT JOIN workstream_read_states rs ON rs.workstream_id = w.id AND rs.user_id = ?`;

/**
 * How long a work stream may report that it is being named.
 *
 * Naming takes about a second. A row still marked `naming` well after that is
 * one whose background pass never finished — the isolate went away before it
 * could settle — and its title, provisional as it is, is now the title. Saying
 * so is what stops a skeleton pulsing forever in front of a work stream nobody
 * is going to name; the column still says `naming`, so the stall stays visible
 * to whoever goes looking, and any later message or run settles it for real.
 */
const NAMING_GRACE_MS = 60_000;

function viewerTitleStatus(row: Record<string, unknown>): "naming" | "automatic" | "settled" {
  if (row.title_status === "automatic") return "automatic";
  if (row.title_status !== "naming") return "settled";
  const createdAt = Date.parse(String(row.created_at));
  return Number.isFinite(createdAt) && Date.now() - createdAt > NAMING_GRACE_MS
    ? "automatic"
    : "naming";
}

/**
 * One `workstreams` row, as one viewer sees it.
 *
 * Read state is per person, so the same row produces a different work stream
 * for each viewer: a reader with no persisted read state starts from the row's
 * own unread-tracking boundary rather than from sequence zero, which is what
 * keeps a work stream someone was added to from arriving entirely unread.
 */
export function toWorkstream(row: Record<string, unknown>): Workstream {
  const latestAttentionSequenceNumber = Number(row.latest_attention_sequence_number ?? 0);
  const hasPersistedReadState = row.viewer_read_state_user_id != null;
  const readThroughSequenceNumber = hasPersistedReadState
    ? Number(row.viewer_read_through_sequence_number ?? 0)
    : Number(row.unread_tracking_start_sequence_number ?? 0);
  const manualUnreadFromSequenceNumber = row.viewer_manual_unread_from_sequence_number == null
    ? null
    : Number(row.viewer_manual_unread_from_sequence_number);
  const hasUnread = manualUnreadFromSequenceNumber != null
    || latestAttentionSequenceNumber > readThroughSequenceNumber;
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), title: String(row.title), objective: String(row.objective ?? ""),
    emailAddress: row.email_address == null ? null : String(row.email_address),
    originType: row.origin_type === "automation" ? "automation" as const : "ad_hoc" as const,
    originLabel: row.origin_label == null ? null : String(row.origin_label), createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    automationSubscriptionId: row.automation_subscription_id == null ? null : String(row.automation_subscription_id), automationRunId: row.automation_run_id == null ? null : String(row.automation_run_id),
    plannedFor: row.planned_for == null ? null : String(row.planned_for), harnessStatus: String(row.harness_status) as "scheduled" | "running" | "needs_input" | "completed" | "failed" | "idle",
    titleStatus: viewerTitleStatus(row),
    latestAttentionSequenceNumber,
    readThroughSequenceNumber,
    manualUnreadFromSequenceNumber,
    manualUnreadGeneration: Number(row.viewer_manual_unread_generation ?? 0),
    hasUnread,
    firstUnreadSequenceNumber: manualUnreadFromSequenceNumber
      ?? (hasUnread ? Math.min(latestAttentionSequenceNumber, readThroughSequenceNumber + 1) : null),
    lastActivityAt: String(row.last_activity_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at == null ? null : String(row.archived_at),
    scope: row.scope === "personal" ? "personal" as const : "workspace" as const,
    systemKind: row.system_kind == null ? null : (String(row.system_kind) as "digest"),
  };
}
