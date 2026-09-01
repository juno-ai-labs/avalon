import {
  IdSchema,
  WorkspaceAttentionSchema,
  WorkspaceWorkstreamCursorSchema,
  WorkspaceWorkstreamStateVersionSchema,
  WorkstreamBatchFilterSchema,
  WorkstreamSchema,
} from "@rally/contracts";
import { z } from "zod";

import { WorkstreamRegionalEffectEnvelopeSchema } from "./workstream-regional-effect";

const TimestampSchema = z.string().datetime({ offset: true });
const UuidV7Schema = IdSchema.refine((value) => value[14] === "7", "must be UUIDv7");

export const WorkspaceAttentionRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
});

export const WorkspaceAttentionResultSchema = WorkspaceAttentionSchema.strict();

export const WorkspaceDirectoryListRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  limit: z.number().int().min(1).max(250),
  before: WorkspaceWorkstreamCursorSchema.optional(),
  includeSystem: z.boolean(),
});

export const WorkspaceDirectoryPageSchema = z.strictObject({
  // Pins and running connection targets are returned in addition to the
  // requested recent-work page. They remain available without consuming its
  // infinite-scroll cursor budget. Pins have their own product limit, while
  // running rows are intentionally complete rather than hidden behind an
  // invented transport cap, so the combined response has no independent max.
  items: z.array(WorkstreamSchema),
  stateVersions: z.array(WorkspaceWorkstreamStateVersionSchema),
  nextCursor: WorkspaceWorkstreamCursorSchema.nullable(),
  directoryWaterline: z.number().int().nonnegative(),
}).superRefine((page, context) => {
  const itemIds = new Set(page.items.map((item) => item.id));
  const versionIds = new Set(page.stateVersions.map((version) => version.workstreamId));
  if (itemIds.size !== page.items.length
    || versionIds.size !== page.stateVersions.length
    || itemIds.size !== versionIds.size
    || [...itemIds].some((id) => !versionIds.has(id))) {
    context.addIssue({
      code: "custom",
      path: ["stateVersions"],
      message: "must contain exactly one state version for every work stream item",
    });
  }
});

export const WorkspaceDirectoryVisibilityRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamId: IdSchema,
});

export const WorkspaceDirectoryReadableIdsRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamIds: z.array(IdSchema).min(1).max(100),
});

export const WorkspaceDirectoryReadableIdsResultSchema = z.strictObject({
  items: z.array(IdSchema).max(100),
});

export const WorkspaceDirectoryBatchTargetsRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  filter: WorkstreamBatchFilterSchema,
});

export const WorkspaceDirectoryBatchTargetsResultSchema = z.strictObject({
  // Intentionally uncapped: the public filter may legitimately select the
  // whole sidebar. The regional Worker chunks these ids into 50-message Queue
  // calls, below the platform's 100-message sendBatch maximum, instead of
  // truncating them.
  items: z.array(IdSchema),
});

const WorkstreamBatchRequestHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);

/** Freeze one generic filtered batch so transport retries cannot widen its target set. */
export const WorkspaceBatchDispatchBeginRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  operationId: IdSchema,
  requestHash: WorkstreamBatchRequestHashSchema,
  filter: WorkstreamBatchFilterSchema,
});

export const WorkspaceBatchDispatchBeginResultSchema = z.strictObject({
  items: z.array(IdSchema),
  targetCount: z.number().int().nonnegative(),
});

/** Record one successfully published Queue chunk for a frozen generic batch. */
export const WorkspaceBatchDispatchAdvanceRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  operationId: IdSchema,
  requestHash: WorkstreamBatchRequestHashSchema,
  workstreamIds: z.array(IdSchema).min(1).max(100),
});

export const WorkspaceBatchDispatchAdvanceResultSchema = z.strictObject({
  remainingCount: z.number().int().nonnegative(),
});

export const WorkspaceDirectoryVisibleIdsRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  includeSystem: z.boolean(),
  participantsOnly: z.boolean(),
  after: IdSchema.optional(),
  limit: z.number().int().min(1).max(250),
});

export const WorkspaceDirectoryVisibleIdsPageSchema = z.strictObject({
  items: z.array(IdSchema).max(250),
  nextCursor: IdSchema.nullable(),
});

export const WorkspaceDirectoryExistsRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
});

export const WorkspaceDirectoryPlannedRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  automationSubscriptionId: IdSchema,
  plannedFor: TimestampSchema,
});

/** Internal scheduler lookup; unlike the member-facing lookup it is not visibility-filtered. */
export const WorkspaceDirectoryPlannedAutomationRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  automationSubscriptionId: IdSchema,
  plannedFor: TimestampSchema,
});

/**
 * An automation's current title, for the origin label on a work stream it made.
 *
 * The work stream lives in its own object and the automation's directory row
 * lives in the workspace's, so this crosses. It used to cross as SQL through
 * the workspace runtime facade, which routes a statement by the table names in
 * it and sends anything it does not recognise to the regional database:
 * `automation_directory` was missing from that allowlist, so the read was
 * answered by D1 with `no such table` and every attempt to open an
 * automation's run work stream returned 500. A method names its tables in the
 * object that has them, and cannot be routed anywhere else.
 */
export const WorkspaceAutomationOriginLabelRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  automationId: IdSchema,
});

export const WorkspaceAutomationOriginLabelSchema = z.strictObject({
  /**
   * The automation's title, or null when the workspace has no live directory
   * row for it. The caller truncates for display; this carries what the
   * directory holds.
   */
  title: z.string().nullable(),
});

export const WorkspaceDirectoryPinRequestSchema = WorkspaceDirectoryVisibilityRequestSchema;

export const WorkspaceDirectoryReorderPinsRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamIds: z.array(IdSchema).max(1_000),
});

export const WorkspaceDirectoryNotificationRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  userId: IdSchema,
});

export const WorkspaceDirectoryNotificationStateSchema = z.strictObject({
  authorityGeneration: z.number().int().positive(),
  viewerVersion: z.number().int().positive(),
  listable: z.boolean(),
  title: z.string().min(1).max(500),
  emailAddress: z.string().email().max(254).nullable(),
});

export const WorkspaceDirectoryResourceRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  watchedOnly: z.boolean(),
});

export const WorkspaceDirectoryResourceResultSchema = z.strictObject({
  workstreamIds: z.array(IdSchema).max(10_000),
});

export const WorkspaceDirectoryInternalItemSchema = z.strictObject({
  workstreamId: IdSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(10_000),
  scope: z.enum(["personal", "workspace"]),
  state: z.string().min(1).max(80),
  systemKind: z.enum(["digest"]).nullable(),
  lastActivityAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  originType: z.enum(["ad_hoc", "automation"]),
  originLabel: z.string().max(120).nullable(),
  createdByUserId: IdSchema.nullable(),
  automationSubscriptionId: IdSchema.nullable(),
  automationRunId: IdSchema.nullable(),
  plannedFor: TimestampSchema.nullable(),
});

export const WorkspaceDirectoryLookupRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  workstreamIds: z.array(IdSchema).min(1).max(250),
});

export const WorkspaceDirectoryLookupResultSchema = z.strictObject({
  items: z.array(WorkspaceDirectoryInternalItemSchema).max(250),
});

export const WorkspaceDirectoryAudienceSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("workspace") }),
  z.strictObject({ scope: z.literal("user"), userId: IdSchema }),
]);

export const WorkspaceDirectoryRecentRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  audience: WorkspaceDirectoryAudienceSchema,
  includeSystem: z.boolean(),
  participantsOnly: z.boolean(),
  limit: z.number().int().min(1).max(250),
});

export const WorkspaceDirectoryDueRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  kind: z.enum(["terminal", "wakeup"]),
  through: TimestampSchema,
  limit: z.number().int().min(1).max(250),
});

export const WorkspaceDirectoryScheduleTargetsRequestSchema = z.strictObject({
  workspaceId: IdSchema,
});

export const WorkspaceDirectoryScheduleTargetsResultSchema = z.strictObject({
  items: z.array(z.strictObject({
    kind: z.enum(["wakeup", "terminal"]),
    workstreamId: IdSchema,
    dueAt: TimestampSchema,
  })).max(20_000),
});

export const WorkspaceDirectoryResourceAccessRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  userId: IdSchema,
});

export const WorkspaceDirectoryResourceAccessResultSchema = z.strictObject({
  items: z.array(z.strictObject({
    workstreamId: IdSchema,
    scope: z.enum(["personal", "workspace"]),
    createdByUserId: IdSchema.nullable(),
    automationSubscriptionId: IdSchema.nullable(),
    isParticipant: z.boolean(),
  })).max(10_000),
});

export const WorkspaceDirectoryApplyRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  envelopes: z.array(WorkstreamRegionalEffectEnvelopeSchema).min(1).max(25),
}).superRefine((request, context) => {
  for (const [index, envelope] of request.envelopes.entries()) {
    if (envelope.workspaceId !== request.workspaceId) {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "workspaceId"],
        message: "Workspace directory effects must target their owning workspace",
      });
    }
    if (!["directory_common", "directory_user", "suggestion_feedback"].includes(envelope.effect.kind)) {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "effect", "kind"],
        message: "Only workspace-owned directory effects may use the WorkspaceDO handoff",
      });
    }
    if ((envelope.effect.kind === "directory_common"
      || envelope.effect.kind === "directory_user"
      || envelope.effect.kind === "suggestion_feedback")
      && !UuidV7Schema.safeParse(envelope.messageId).success) {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "messageId"],
        message: "Directory state source identities must be UUIDv7",
      });
    }
  }
});

export const WorkspaceDirectoryApplyResultSchema = z.strictObject({
  accepted: z.array(z.strictObject({
    messageId: z.string().min(1).max(500),
    payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  })).max(25),
  directoryChanged: z.boolean(),
});

/**
 * One WorkstreamDO activity/mention effect, applied with its receipt in a
 * single WorkspaceDO transaction. Current member/user identity crosses the
 * boundary as data: the regional caller resolves it from D1 and the object
 * commits only what it was handed, so the effect and its idempotency receipt
 * can never land in different authorities.
 */
export const WorkspaceRegionalEffectApplyRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  envelope: WorkstreamRegionalEffectEnvelopeSchema,
  actorUserId: IdSchema.nullable(),
  targetUserIds: z.array(IdSchema).max(100),
  recipientIsActiveMember: z.boolean(),
}).superRefine((request, context) => {
  if (request.envelope.workspaceId !== request.workspaceId) {
    context.addIssue({
      code: "custom",
      path: ["envelope", "workspaceId"],
      message: "Workstream regional effects must target their owning workspace",
    });
  }
  if (!["activity_event", "mention_notification", "participant_notification"]
    .includes(request.envelope.effect.kind)) {
    context.addIssue({
      code: "custom",
      path: ["envelope", "effect", "kind"],
      message: "Only activity and person-notification effects may use the regional apply handoff",
    });
  }
});

export const WorkspaceRegionalEffectApplyResultSchema = z.strictObject({
  replayed: z.boolean(),
  notificationIntentId: z.string().min(1).max(300).nullable(),
});

export type WorkspaceDirectoryListRequest = z.infer<typeof WorkspaceDirectoryListRequestSchema>;
export type WorkspaceAttentionRequest = z.infer<typeof WorkspaceAttentionRequestSchema>;
export type WorkspaceAttentionResult = z.infer<typeof WorkspaceAttentionResultSchema>;
export type WorkspaceDirectoryPage = z.infer<typeof WorkspaceDirectoryPageSchema>;
export type WorkspaceDirectoryVisibilityRequest = z.infer<typeof WorkspaceDirectoryVisibilityRequestSchema>;
export type WorkspaceDirectoryReadableIdsRequest = z.infer<typeof WorkspaceDirectoryReadableIdsRequestSchema>;
export type WorkspaceDirectoryBatchTargetsRequest = z.infer<typeof WorkspaceDirectoryBatchTargetsRequestSchema>;
export type WorkspaceBatchDispatchBeginRequest = z.infer<typeof WorkspaceBatchDispatchBeginRequestSchema>;
export type WorkspaceBatchDispatchAdvanceRequest = z.infer<typeof WorkspaceBatchDispatchAdvanceRequestSchema>;
export type WorkspaceDirectoryReadableIdsResult = z.infer<typeof WorkspaceDirectoryReadableIdsResultSchema>;
export type WorkspaceDirectoryVisibleIdsRequest = z.infer<typeof WorkspaceDirectoryVisibleIdsRequestSchema>;
export type WorkspaceDirectoryVisibleIdsPage = z.infer<typeof WorkspaceDirectoryVisibleIdsPageSchema>;
export type WorkspaceDirectoryExistsRequest = z.infer<typeof WorkspaceDirectoryExistsRequestSchema>;
export type WorkspaceDirectoryPlannedRequest = z.infer<typeof WorkspaceDirectoryPlannedRequestSchema>;
export type WorkspaceDirectoryPlannedAutomationRequest = z.infer<
  typeof WorkspaceDirectoryPlannedAutomationRequestSchema
>;
export type WorkspaceAutomationOriginLabelRequest = z.infer<
  typeof WorkspaceAutomationOriginLabelRequestSchema
>;
export type WorkspaceAutomationOriginLabel = z.infer<typeof WorkspaceAutomationOriginLabelSchema>;
export type WorkspaceDirectoryPinRequest = z.infer<typeof WorkspaceDirectoryPinRequestSchema>;
export type WorkspaceDirectoryReorderPinsRequest = z.infer<typeof WorkspaceDirectoryReorderPinsRequestSchema>;
export type WorkspaceDirectoryNotificationRequest = z.infer<typeof WorkspaceDirectoryNotificationRequestSchema>;
export type WorkspaceDirectoryNotificationState = z.infer<typeof WorkspaceDirectoryNotificationStateSchema>;
export type WorkspaceDirectoryResourceRequest = z.infer<typeof WorkspaceDirectoryResourceRequestSchema>;
export type WorkspaceDirectoryResourceResult = z.infer<typeof WorkspaceDirectoryResourceResultSchema>;
export type WorkspaceDirectoryLookupRequest = z.infer<typeof WorkspaceDirectoryLookupRequestSchema>;
export type WorkspaceDirectoryLookupResult = z.infer<typeof WorkspaceDirectoryLookupResultSchema>;
export type WorkspaceDirectoryRecentRequest = z.infer<typeof WorkspaceDirectoryRecentRequestSchema>;
export type WorkspaceDirectoryDueRequest = z.infer<typeof WorkspaceDirectoryDueRequestSchema>;
export type WorkspaceDirectoryScheduleTargetsRequest = z.infer<typeof WorkspaceDirectoryScheduleTargetsRequestSchema>;
export type WorkspaceDirectoryScheduleTargetsResult = z.infer<typeof WorkspaceDirectoryScheduleTargetsResultSchema>;
export type WorkspaceDirectoryResourceAccessRequest = z.infer<typeof WorkspaceDirectoryResourceAccessRequestSchema>;
export type WorkspaceDirectoryResourceAccessResult = z.infer<typeof WorkspaceDirectoryResourceAccessResultSchema>;
export type WorkspaceDirectoryApplyRequest = z.infer<typeof WorkspaceDirectoryApplyRequestSchema>;
export type WorkspaceDirectoryApplyResult = z.infer<typeof WorkspaceDirectoryApplyResultSchema>;
export type WorkspaceRegionalEffectApplyRequest = z.infer<typeof WorkspaceRegionalEffectApplyRequestSchema>;
export type WorkspaceRegionalEffectApplyResult = z.infer<typeof WorkspaceRegionalEffectApplyResultSchema>;
