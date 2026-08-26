import {
  IdSchema,
  WorkspaceWorkstreamCursorSchema,
  WorkspaceWorkstreamStateVersionSchema,
  WorkstreamBatchFilterSchema,
  WorkstreamSchema,
} from "@rally/contracts";
import { z } from "zod";

import { WorkstreamRegionalEffectEnvelopeSchema } from "./workstream-regional-effect";
import { ContentAudienceSchema } from "../lib/audience-containment";

const TimestampSchema = z.string().datetime({ offset: true });
const UuidV7Schema = IdSchema.refine((value) => value[14] === "7", "must be UUIDv7");

export const WorkspaceDirectoryListRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  limit: z.number().int().min(1).max(250),
  before: WorkspaceWorkstreamCursorSchema.optional(),
  includeSystem: z.boolean(),
}).strict();

export const WorkspaceDirectoryPageSchema = z.object({
  // Pins are returned in addition to the requested recent-work page so they
  // remain stable above infinite scroll without consuming its cursor budget.
  items: z.array(WorkstreamSchema).max(1_250),
  stateVersions: z.array(WorkspaceWorkstreamStateVersionSchema).max(1_250),
  nextCursor: WorkspaceWorkstreamCursorSchema.nullable(),
  directoryWaterline: z.number().int().nonnegative(),
}).strict().superRefine((page, context) => {
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

export const WorkspaceDirectoryVisibilityRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamId: IdSchema,
}).strict();

export const WorkspaceDirectoryReadableIdsRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamIds: z.array(IdSchema).min(1).max(100),
}).strict();

export const WorkspaceDirectoryReadableIdsResultSchema = z.object({
  items: z.array(IdSchema).max(100),
}).strict();

export const WorkspaceDirectoryBatchTargetsRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  filter: WorkstreamBatchFilterSchema,
}).strict();

export const WorkspaceDirectoryBatchTargetsResultSchema = z.object({
  // Intentionally uncapped: the public filter may legitimately select the
  // whole sidebar. The regional Worker chunks these ids into Queue sendBatch
  // calls at the platform's transport boundary instead of truncating them.
  items: z.array(IdSchema),
}).strict();

export const WorkspaceDirectoryVisibleIdsRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  includeSystem: z.boolean(),
  participantsOnly: z.boolean(),
  after: IdSchema.optional(),
  limit: z.number().int().min(1).max(250),
}).strict();

export const WorkspaceDirectoryVisibleIdsPageSchema = z.object({
  items: z.array(IdSchema).max(250),
  nextCursor: IdSchema.nullable(),
}).strict();

export const WorkspaceDirectoryExistsRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
}).strict();

export const WorkspaceDirectoryPlannedRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  automationSubscriptionId: IdSchema,
  plannedFor: TimestampSchema,
}).strict();

/** Internal scheduler lookup; unlike the member-facing lookup it is not visibility-filtered. */
export const WorkspaceDirectoryPlannedAutomationRequestSchema = z.object({
  workspaceId: IdSchema,
  automationSubscriptionId: IdSchema,
  plannedFor: TimestampSchema,
}).strict();

export const WorkspaceDirectoryPinRequestSchema = WorkspaceDirectoryVisibilityRequestSchema;

export const WorkspaceDirectoryReorderPinsRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamIds: z.array(IdSchema).max(1_000),
}).strict();

export const WorkspaceDirectoryNotificationRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  userId: IdSchema,
}).strict();

export const WorkspaceDirectoryNotificationStateSchema = z.object({
  authorityGeneration: z.number().int().positive(),
  viewerVersion: z.number().int().positive(),
  listable: z.boolean(),
  title: z.string().min(1).max(500),
  emailAddress: z.string().email().max(254).nullable(),
}).strict();

export const WorkspaceDirectoryResourceRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  watchedOnly: z.boolean(),
}).strict();

export const WorkspaceDirectoryResourceResultSchema = z.object({
  workstreamIds: z.array(IdSchema).max(10_000),
}).strict();

export const WorkspaceDirectoryInternalItemSchema = z.object({
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
}).strict();

export const WorkspaceDirectoryLookupRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamIds: z.array(IdSchema).min(1).max(250),
}).strict();

export const WorkspaceDirectoryLookupResultSchema = z.object({
  items: z.array(WorkspaceDirectoryInternalItemSchema).max(250),
}).strict();

export const WorkspaceDirectoryAudienceSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }).strict(),
  z.object({ scope: z.literal("user"), userId: IdSchema }).strict(),
]);

export const WorkspaceDirectoryRecentRequestSchema = z.object({
  workspaceId: IdSchema,
  audience: WorkspaceDirectoryAudienceSchema,
  includeSystem: z.boolean(),
  participantsOnly: z.boolean(),
  limit: z.number().int().min(1).max(250),
}).strict();

export const WorkspaceDirectoryDueRequestSchema = z.object({
  workspaceId: IdSchema,
  kind: z.enum(["terminal", "wakeup"]),
  through: TimestampSchema,
  limit: z.number().int().min(1).max(250),
}).strict();

export const WorkspaceDirectoryScheduleTargetsRequestSchema = z.object({
  workspaceId: IdSchema,
}).strict();

export const WorkspaceDirectoryScheduleTargetsResultSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(["wakeup", "terminal"]),
    workstreamId: IdSchema,
    dueAt: TimestampSchema,
  }).strict()).max(20_000),
}).strict();

export const WorkspaceDirectoryRoutingCandidatesRequestSchema = z.object({
  workspaceId: IdSchema,
  audience: ContentAudienceSchema,
  excludedWorkstreamIds: z.array(IdSchema).max(10_000),
  feedbackSince: TimestampSchema,
  dismissalLimit: z.number().int().positive(),
  limit: z.number().int().min(1).max(250),
}).strict();

export const WorkspaceDirectoryFeedbackRequestSchema = z.object({
  workspaceId: IdSchema,
  source: z.enum(["contextual_routing", "suggested_work"]),
  since: TimestampSchema,
  provider: z.string().min(1).max(120),
  eventType: z.string().min(1).max(160),
}).strict();

export const WorkspaceDirectoryFeedbackResultSchema = z.object({
  items: z.array(z.object({
    workstreamId: IdSchema,
    activityId: IdSchema,
    status: z.enum(["accepted", "dismissed"]),
    resolvedAt: TimestampSchema,
    resolvedByUserId: IdSchema.nullable(),
  }).strict()).max(10_000),
}).strict();

export const WorkspaceDirectoryResourceAccessRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  userId: IdSchema,
}).strict();

export const WorkspaceDirectoryResourceAccessResultSchema = z.object({
  items: z.array(z.object({
    workstreamId: IdSchema,
    scope: z.enum(["personal", "workspace"]),
    createdByUserId: IdSchema.nullable(),
    automationSubscriptionId: IdSchema.nullable(),
    isParticipant: z.boolean(),
  }).strict()).max(10_000),
}).strict();

export const WorkspaceDirectoryApplyRequestSchema = z.object({
  workspaceId: IdSchema,
  envelopes: z.array(WorkstreamRegionalEffectEnvelopeSchema).min(1).max(25),
}).strict().superRefine((request, context) => {
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

export const WorkspaceDirectoryApplyResultSchema = z.object({
  accepted: z.array(z.object({
    messageId: z.string().min(1).max(500),
    payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  }).strict()).max(25),
  directoryChanged: z.boolean(),
}).strict();

/**
 * One WorkstreamDO activity/mention effect, applied with its receipt in a
 * single WorkspaceDO transaction. Current member/user identity crosses the
 * boundary as data: the regional caller resolves it from D1 and the object
 * commits only what it was handed, so the effect and its idempotency receipt
 * can never land in different authorities.
 */
export const WorkspaceRegionalEffectApplyRequestSchema = z.object({
  workspaceId: IdSchema,
  envelope: WorkstreamRegionalEffectEnvelopeSchema,
  actorUserId: IdSchema.nullable(),
  targetUserIds: z.array(IdSchema).max(100),
  recipientIsActiveMember: z.boolean(),
}).strict().superRefine((request, context) => {
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

export const WorkspaceRegionalEffectApplyResultSchema = z.object({
  replayed: z.boolean(),
  notificationIntentId: z.string().min(1).max(300).nullable(),
}).strict();

export type WorkspaceDirectoryListRequest = z.infer<typeof WorkspaceDirectoryListRequestSchema>;
export type WorkspaceDirectoryPage = z.infer<typeof WorkspaceDirectoryPageSchema>;
export type WorkspaceDirectoryVisibilityRequest = z.infer<typeof WorkspaceDirectoryVisibilityRequestSchema>;
export type WorkspaceDirectoryReadableIdsRequest = z.infer<typeof WorkspaceDirectoryReadableIdsRequestSchema>;
export type WorkspaceDirectoryBatchTargetsRequest = z.infer<typeof WorkspaceDirectoryBatchTargetsRequestSchema>;
export type WorkspaceDirectoryReadableIdsResult = z.infer<typeof WorkspaceDirectoryReadableIdsResultSchema>;
export type WorkspaceDirectoryVisibleIdsRequest = z.infer<typeof WorkspaceDirectoryVisibleIdsRequestSchema>;
export type WorkspaceDirectoryVisibleIdsPage = z.infer<typeof WorkspaceDirectoryVisibleIdsPageSchema>;
export type WorkspaceDirectoryExistsRequest = z.infer<typeof WorkspaceDirectoryExistsRequestSchema>;
export type WorkspaceDirectoryPlannedRequest = z.infer<typeof WorkspaceDirectoryPlannedRequestSchema>;
export type WorkspaceDirectoryPlannedAutomationRequest = z.infer<
  typeof WorkspaceDirectoryPlannedAutomationRequestSchema
>;
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
export type WorkspaceDirectoryRoutingCandidatesRequest = z.infer<typeof WorkspaceDirectoryRoutingCandidatesRequestSchema>;
export type WorkspaceDirectoryFeedbackRequest = z.infer<typeof WorkspaceDirectoryFeedbackRequestSchema>;
export type WorkspaceDirectoryFeedbackResult = z.infer<typeof WorkspaceDirectoryFeedbackResultSchema>;
export type WorkspaceDirectoryResourceAccessRequest = z.infer<typeof WorkspaceDirectoryResourceAccessRequestSchema>;
export type WorkspaceDirectoryResourceAccessResult = z.infer<typeof WorkspaceDirectoryResourceAccessResultSchema>;
export type WorkspaceDirectoryApplyRequest = z.infer<typeof WorkspaceDirectoryApplyRequestSchema>;
export type WorkspaceDirectoryApplyResult = z.infer<typeof WorkspaceDirectoryApplyResultSchema>;
export type WorkspaceRegionalEffectApplyRequest = z.infer<typeof WorkspaceRegionalEffectApplyRequestSchema>;
export type WorkspaceRegionalEffectApplyResult = z.infer<typeof WorkspaceRegionalEffectApplyResultSchema>;
