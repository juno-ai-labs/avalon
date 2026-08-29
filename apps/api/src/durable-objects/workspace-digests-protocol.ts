import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The workspace's scheduled digests, as questions rather than SQL.
 *
 * WorkspaceDO owns `digest_schedules`, `digest_schedule_times`,
 * `digest_delivery_targets`, `digest_deliveries`, and the digest-owned rows of
 * the shared `schedules` table. The digest services reached all of them
 * through the workspace runtime facade, which routes by table name and sends
 * anything it does not recognise to the regional database — the routing that
 * answered `no such table` from D1 when `automation_directory` was missing
 * from its list. A typed method cannot be routed to the wrong database,
 * because its tables are named inside the object that has them.
 *
 * A refusal travels as an outcome, never a throw: a thrown RPC error arrives
 * at the caller as a bare message with the HTTP status lost, so the object
 * names what happened and the service maps it to its own `ApiError`.
 */

const TimestampSchema = z.string().datetime({ offset: true });
const MinuteOfDaySchema = z.number().int().min(0).max(1439);
const DayMaskSchema = z.number().int().min(0).max(127);

/** One configured digest, without its frozen destinations. */
export const WorkspaceDigestScheduleSchema = z.object({
  id: IdSchema,
  dayMask: DayMaskSchema,
  enabled: z.boolean(),
}).strict();

export const WorkspaceDigestSettingsRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
}).strict();

/**
 * Everything the settings surface reads except the delivery targets, whose
 * connector display names are a join the facade still carries.
 */
export const WorkspaceDigestSettingsSchema = z.object({
  schedule: WorkspaceDigestScheduleSchema.nullable(),
  times: z.array(MinuteOfDaySchema),
  nextRunAt: z.string().nullable(),
  lastDeliveredAt: z.string().nullable(),
}).strict();

/** One derived `schedules` row, fully computed by the caller: the recurrence policy stays in the service. */
export const WorkspaceDigestScheduleRowInputSchema = z.object({
  id: IdSchema,
  rrule: z.string().min(1),
  nextRunAt: TimestampSchema,
}).strict();

export const WorkspaceDigestTargetInputSchema = z.object({
  id: IdSchema,
  targetType: z.string().min(1),
  connectionId: IdSchema.nullable(),
  providerTenantId: z.string().nullable(),
  providerUserId: z.string().nullable(),
  emailAddress: z.string().nullable(),
}).strict();

export const WorkspaceDigestReplaceRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  /** Used only when no digest exists yet; an existing one keeps its id. */
  scheduleId: IdSchema,
  dayMask: DayMaskSchema,
  enabled: z.boolean(),
  executionPrincipalJson: z.string().min(2),
  times: z.array(MinuteOfDaySchema),
  targets: z.array(WorkspaceDigestTargetInputSchema),
  scheduleRows: z.array(WorkspaceDigestScheduleRowInputSchema),
  timezone: z.string().min(1),
  at: TimestampSchema,
}).strict();

/**
 * The id the digest actually has, which is not always the one the caller
 * proposed: the existence check and the write are one critical section, so two
 * first saves racing each other converge on one row instead of the loser
 * hitting `UNIQUE (workspace_id, user_id)` as a 500.
 */
export const WorkspaceDigestReplaceResultSchema = z.object({
  scheduleId: IdSchema,
  outcome: z.enum(["created", "updated"]),
}).strict();

export const WorkspaceDigestDefaultRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  scheduleId: IdSchema,
  targetId: IdSchema,
  dayMask: DayMaskSchema,
  minuteOfDay: MinuteOfDaySchema,
  emailAddress: z.string().min(1),
  executionPrincipalJson: z.string().min(2),
  at: TimestampSchema,
}).strict();

/**
 * What exists after the call, created or found. Absence is the only thing that
 * creates: a digest switched off keeps its row with `enabled = 0`, so the
 * default can never resurrect one somebody turned off.
 */
export const WorkspaceDigestDefaultResultSchema = z.object({
  created: z.boolean(),
  schedule: WorkspaceDigestScheduleSchema,
  times: z.array(MinuteOfDaySchema),
}).strict();

export const WorkspaceDigestRowStateRequestSchema = z.object({
  workspaceId: IdSchema,
  digestScheduleId: IdSchema,
  /** The account timezone the derived rows are expected to carry. */
  timezone: z.string().min(1),
}).strict();

export const WorkspaceDigestRowStateSchema = z.object({
  rowCount: z.number().int().nonnegative(),
  timezoneMismatches: z.number().int().nonnegative(),
}).strict();

export const WorkspaceDigestReplaceRowsRequestSchema = z.object({
  workspaceId: IdSchema,
  digestScheduleId: IdSchema,
  timezone: z.string().min(1),
  /** Empty clears: a disabled digest keeps its configuration and derives nothing. */
  rows: z.array(WorkspaceDigestScheduleRowInputSchema),
  at: TimestampSchema,
}).strict();

export const WorkspaceDigestFireScheduleRequestSchema = z.object({
  workspaceId: IdSchema,
  scheduleId: IdSchema,
}).strict();

export const WorkspaceDigestFireScheduleSchema = z.object({
  schedule: z.object({
    id: IdSchema,
    userId: IdSchema,
    enabled: z.boolean(),
    executionPrincipalJson: z.string(),
  }).strict().nullable(),
}).strict();

export const WorkspaceDigestCursorRequestSchema = z.object({
  workspaceId: IdSchema,
  digestScheduleId: IdSchema,
}).strict();

export const WorkspaceDigestCursorSchema = z.object({
  cursorThrough: z.number().int().nonnegative().nullable(),
}).strict();

export const WorkspaceDigestClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
  digestScheduleId: IdSchema,
  userId: IdSchema,
  plannedFor: z.string().min(1),
  cursorFrom: z.number().int().nonnegative().nullable(),
  cursorThrough: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  highlightCount: z.number().int().nonnegative(),
  /** `empty` settles the occurrence at claim time: nothing runs, the cursor still moves. */
  status: z.enum(["empty", "planned"]),
  at: TimestampSchema,
}).strict();

/**
 * `already_planned` is `UNIQUE (digest_schedule_id, planned_for)` as an
 * answer: a retried alarm resolves to the attempt already in flight rather
 * than digesting the same window twice.
 */
export const WorkspaceDigestClaimResultSchema = z.object({
  outcome: z.enum(["claimed", "already_planned"]),
}).strict();

export const WorkspaceDigestDeliveryWorkstreamRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
  workstreamId: IdSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceDigestDeliveryRunningRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
  harnessRunId: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceDigestReleaseClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
}).strict();

/**
 * `kept` means the claim had already left `planned` — a launch that got as far
 * as recording its run must keep the occurrence, or a retry would digest the
 * same window twice.
 */
export const WorkspaceDigestReleaseClaimResultSchema = z.object({
  outcome: z.enum(["released", "kept"]),
}).strict();

export const WorkspaceDigestDeliveryContextRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
}).strict();

export const WorkspaceDigestDeliveryContextSchema = z.object({
  delivery: z.object({
    id: IdSchema,
    userId: IdSchema,
    plannedFor: z.string(),
    eventCount: z.number().int().nonnegative(),
    highlightCount: z.number().int().nonnegative(),
    status: z.enum(["planned", "running", "delivered", "empty", "failed"]),
    workstreamId: z.string().nullable(),
  }).strict().nullable(),
}).strict();

export const WorkspaceDigestSummaryRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
  summaryMarkdown: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceDigestSettleRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
  status: z.enum(["delivered", "failed"]),
  errorJson: z.string().nullable(),
  at: TimestampSchema,
}).strict();

/**
 * Which settlement attempt won. Settlement is a claim: two consumers — a
 * workflow step retried while its first attempt is still in flight — could
 * both read `running` and both settle, and each would then emit the terminal
 * telemetry and append the delivery note as though it were the only one. The
 * compare-and-set returns its witness so the loser can stand down.
 */
export const WorkspaceDigestSettleResultSchema = z.object({
  outcome: z.enum(["settled", "already_settled", "not_found"]),
}).strict();

export const WorkspaceDigestTerminalContextRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
}).strict();

export const WorkspaceDigestTerminalContextSchema = z.object({
  targetTypes: z.array(z.string()),
  priorDeliveredCount: z.number().int().nonnegative(),
}).strict();

export const WorkspaceDigestDeliveryTargetsRequestSchema = z.object({
  workspaceId: IdSchema,
  deliveryId: IdSchema,
  userId: IdSchema,
}).strict();

export const WorkspaceDigestDeliveryTargetSchema = z.object({
  id: IdSchema,
  targetType: z.string(),
  connectionId: z.string().nullable(),
  providerTenantId: z.string().nullable(),
  providerUserId: z.string().nullable(),
  emailAddress: z.string().nullable(),
  lastDeliveredDeliveryId: z.string().nullable(),
}).strict();

export const WorkspaceDigestDeliveryTargetsSchema = z.object({
  targets: z.array(WorkspaceDigestDeliveryTargetSchema),
}).strict();

export const WorkspaceDigestTargetDeliveredRequestSchema = z.object({
  workspaceId: IdSchema,
  targetId: IdSchema,
  deliveryId: IdSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceDigestTargetFailedRequestSchema = z.object({
  workspaceId: IdSchema,
  targetId: IdSchema,
  /** Only a permanent rejection parks the target in `needs_input`. */
  permanent: z.boolean(),
  errorJson: z.string().min(2),
  at: TimestampSchema,
}).strict();

export const WorkspaceDigestTargetOutcomeResultSchema = z.object({
  outcome: z.enum(["recorded", "target_not_found"]),
}).strict();

export type WorkspaceDigestSettingsRequest = z.infer<typeof WorkspaceDigestSettingsRequestSchema>;
export type WorkspaceDigestSettings = z.infer<typeof WorkspaceDigestSettingsSchema>;
export type WorkspaceDigestReplaceRequest = z.infer<typeof WorkspaceDigestReplaceRequestSchema>;
export type WorkspaceDigestReplaceResult = z.infer<typeof WorkspaceDigestReplaceResultSchema>;
export type WorkspaceDigestDefaultRequest = z.infer<typeof WorkspaceDigestDefaultRequestSchema>;
export type WorkspaceDigestDefaultResult = z.infer<typeof WorkspaceDigestDefaultResultSchema>;
export type WorkspaceDigestRowStateRequest = z.infer<typeof WorkspaceDigestRowStateRequestSchema>;
export type WorkspaceDigestRowState = z.infer<typeof WorkspaceDigestRowStateSchema>;
export type WorkspaceDigestReplaceRowsRequest = z.infer<typeof WorkspaceDigestReplaceRowsRequestSchema>;
export type WorkspaceDigestFireScheduleRequest = z.infer<typeof WorkspaceDigestFireScheduleRequestSchema>;
export type WorkspaceDigestFireSchedule = z.infer<typeof WorkspaceDigestFireScheduleSchema>;
export type WorkspaceDigestCursorRequest = z.infer<typeof WorkspaceDigestCursorRequestSchema>;
export type WorkspaceDigestCursor = z.infer<typeof WorkspaceDigestCursorSchema>;
export type WorkspaceDigestClaimRequest = z.infer<typeof WorkspaceDigestClaimRequestSchema>;
export type WorkspaceDigestClaimResult = z.infer<typeof WorkspaceDigestClaimResultSchema>;
export type WorkspaceDigestDeliveryWorkstreamRequest =
  z.infer<typeof WorkspaceDigestDeliveryWorkstreamRequestSchema>;
export type WorkspaceDigestDeliveryRunningRequest =
  z.infer<typeof WorkspaceDigestDeliveryRunningRequestSchema>;
export type WorkspaceDigestReleaseClaimRequest =
  z.infer<typeof WorkspaceDigestReleaseClaimRequestSchema>;
export type WorkspaceDigestReleaseClaimResult =
  z.infer<typeof WorkspaceDigestReleaseClaimResultSchema>;
export type WorkspaceDigestDeliveryContextRequest =
  z.infer<typeof WorkspaceDigestDeliveryContextRequestSchema>;
export type WorkspaceDigestDeliveryContext =
  z.infer<typeof WorkspaceDigestDeliveryContextSchema>;
export type WorkspaceDigestSummaryRequest = z.infer<typeof WorkspaceDigestSummaryRequestSchema>;
export type WorkspaceDigestSettleRequest = z.infer<typeof WorkspaceDigestSettleRequestSchema>;
export type WorkspaceDigestSettleResult = z.infer<typeof WorkspaceDigestSettleResultSchema>;
export type WorkspaceDigestTerminalContextRequest =
  z.infer<typeof WorkspaceDigestTerminalContextRequestSchema>;
export type WorkspaceDigestTerminalContext =
  z.infer<typeof WorkspaceDigestTerminalContextSchema>;
export type WorkspaceDigestDeliveryTargetsRequest =
  z.infer<typeof WorkspaceDigestDeliveryTargetsRequestSchema>;
export type WorkspaceDigestDeliveryTarget = z.infer<typeof WorkspaceDigestDeliveryTargetSchema>;
export type WorkspaceDigestDeliveryTargets = z.infer<typeof WorkspaceDigestDeliveryTargetsSchema>;
export type WorkspaceDigestTargetDeliveredRequest =
  z.infer<typeof WorkspaceDigestTargetDeliveredRequestSchema>;
export type WorkspaceDigestTargetFailedRequest =
  z.infer<typeof WorkspaceDigestTargetFailedRequestSchema>;
export type WorkspaceDigestTargetOutcomeResult =
  z.infer<typeof WorkspaceDigestTargetOutcomeResultSchema>;
