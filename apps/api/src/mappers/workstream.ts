import { WORKSTREAM_NAMING_GRACE_MS, type Workstream } from "@avalon/contracts";
import { truncateUtf16Safe } from "@avalon/contracts/text";
import { z } from "zod";

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

const rowText = z.string();
/**
 * A column whose length no `CHECK` constrains, read into a field a contract
 * bounds. Truncating here keeps one over-long value a shortened field rather
 * than a 500 for every row the same query returned.
 */
const displayText = (max: number): z.ZodType<string, string> =>
  z.string().transform((value) => truncateUtf16Safe(value, max));
const rowId = z.string().min(1);
const rowTimestamp = z.string().min(1);
const rowCount = z.number().int().nonnegative();

/**
 * The row this mapper reads, as a contract rather than an assumption.
 *
 * The comment above `WORKSTREAM_VIEWER_COLUMNS_SQL` already states the hazard:
 * a query that omits one of these silently produces a work stream that fails
 * contract validation. Hand-coercion could not enforce that — `String(row.x)`
 * turns an absent column into `"undefined"` and `Number(row.x ?? 0)` turns one
 * into `0`, so the omission became plausible output instead of an error, and
 * the failure surfaced several layers later as an anonymous 500 from the
 * response schema.
 *
 * The enums are the columns' own CHECK constraints, so nothing a correct row
 * contains can fail here.
 */
export const WorkstreamRowSchema = z.object({
  id: rowId,
  workspace_id: rowId,
  title: displayText(180),
  objective: displayText(4_000).nullish(),
  origin_type: z.enum(["ad_hoc", "automation"]),
  // `automation_templates.name` allows 140 characters; `originLabel` allows 120.
  // Without the bound, one automation named past 120 fails `GET /workstreams`
  // for the entire workspace — the sidebar — rather than shortening one label.
  origin_label: displayText(120).nullish(),
  created_by_user_id: rowId.nullish(),
  automation_subscription_id: rowId.nullish(),
  automation_run_id: rowId.nullish(),
  planned_for: rowText.nullish(),
  harness_status: z.enum(["scheduled", "running", "needs_input", "completed", "failed", "idle"]),
  title_status: z.enum(["naming", "automatic", "settled"]),
  email_address: rowText.nullish(),
  latest_attention_sequence_number: rowCount.nullish(),
  unread_tracking_start_sequence_number: rowCount.nullish(),
  scope: z.enum(["personal", "workspace"]),
  system_kind: z.literal("digest").nullish(),
  last_activity_at: rowTimestamp,
  created_at: rowTimestamp,
  updated_at: rowTimestamp,
  archived_at: rowText.nullish(),
  // Joined from `workstream_read_states` for the reader, so absent rather than
  // null when this viewer has never opened the work stream.
  viewer_read_state_user_id: rowId.nullish(),
  viewer_read_through_sequence_number: rowCount.nullish(),
  viewer_manual_unread_from_sequence_number: rowCount.nullish(),
  viewer_manual_unread_generation: rowCount.nullish(),
});

/**
 * The status a viewer is told, which is not always the one in the column.
 *
 * A row still marked `naming` well past the grace is one whose background pass
 * never finished, and its title — provisional as it is — is now the title.
 * Reporting that is what stops a skeleton pulsing in front of a work stream
 * nobody is going to name; the column keeps saying `naming`, so the stall stays
 * visible to whoever goes looking, and any later message or run settles it.
 */
function viewerTitleStatus(row: z.infer<typeof WorkstreamRowSchema>): "naming" | "automatic" | "settled" {
  if (row.title_status === "automatic") return "automatic";
  if (row.title_status !== "naming") return "settled";
  const createdAt = Date.parse(row.created_at);
  return Number.isFinite(createdAt) && Date.now() - createdAt > WORKSTREAM_NAMING_GRACE_MS
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
export function toWorkstream(input: Record<string, unknown>): Workstream {
  const row = WorkstreamRowSchema.parse(input);
  const latestAttentionSequenceNumber = row.latest_attention_sequence_number ?? 0;
  const hasPersistedReadState = row.viewer_read_state_user_id != null;
  const readThroughSequenceNumber = hasPersistedReadState
    ? row.viewer_read_through_sequence_number ?? 0
    : row.unread_tracking_start_sequence_number ?? 0;
  const manualUnreadFromSequenceNumber = row.viewer_manual_unread_from_sequence_number ?? null;
  const hasUnread = manualUnreadFromSequenceNumber != null
    || latestAttentionSequenceNumber > readThroughSequenceNumber;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    objective: row.objective ?? "",
    emailAddress: row.email_address ?? null,
    originType: row.origin_type,
    originLabel: row.origin_label ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    automationSubscriptionId: row.automation_subscription_id ?? null,
    automationRunId: row.automation_run_id ?? null,
    plannedFor: row.planned_for ?? null,
    harnessStatus: row.harness_status,
    titleStatus: viewerTitleStatus(row),
    latestAttentionSequenceNumber,
    readThroughSequenceNumber,
    manualUnreadFromSequenceNumber,
    manualUnreadGeneration: row.viewer_manual_unread_generation ?? 0,
    hasUnread,
    firstUnreadSequenceNumber: manualUnreadFromSequenceNumber
      ?? (hasUnread ? Math.min(latestAttentionSequenceNumber, readThroughSequenceNumber + 1) : null),
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    scope: row.scope,
    systemKind: row.system_kind ?? null,
  };
}
