import { IdSchema, WorkspaceAttentionSchema } from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";

const TimestampSchema = z.string().datetime({ offset: true });

export const WorkspaceAttentionRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  /** Decides which conversations `readerAttentionCount` may count, as the sidebar's listing does. */
  accessClass: z.enum(["member", "guest"]).optional(),
}));

export const WorkspaceAttentionResultSchema = deferredZodSchema(() => WorkspaceAttentionSchema.strict());

export const WorkspaceDirectoryNotificationRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  userId: IdSchema,
}));

export const WorkspaceDirectoryNotificationStateSchema = deferredZodSchema(() => z.strictObject({
  authorityGeneration: z.number().int().positive(),
  listable: z.boolean(),
  title: z.string().min(1).max(500),
  emailAddress: z.string().email().max(254).nullable(),
}));

/**
 * The one resource a shared link names, for the public handoff page's heading.
 * A Breakout names its Channel too, because breakouts are keyed by both.
 */
export const WorkspaceLinkTitleRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("canvas"), canvasId: IdSchema }),
    z.strictObject({ kind: z.literal("sidekick"), sidekickId: IdSchema }),
  ]),
}));
export type WorkspaceLinkTitleRequest = z.infer<typeof WorkspaceLinkTitleRequestSchema>;

export const WorkspaceDirectoryScheduleTargetsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
}));

export const WorkspaceDirectoryScheduleTargetsResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({
    kind: z.enum(["wakeup", "terminal"]),
    workstreamId: IdSchema,
    dueAt: TimestampSchema,
  })).max(20_000),
}));

/**
 * One Channel or Space parent's activity/mention effect, applied with its receipt in a
 * single WorkspaceDO transaction. Current member/user identity crosses the
 * boundary as data: the regional caller resolves it from D1 and the object
 * commits only what it was handed, so the effect and its idempotency receipt
 * can never land in different authorities.
 */
export const WorkspaceRegionalEffectApplyRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  envelope: ParentEffectEnvelopeSchema,
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
}));

export const WorkspaceRegionalEffectApplyResultSchema = deferredZodSchema(() => z.strictObject({
  replayed: z.boolean(),
  notificationIntentId: z.string().min(1).max(300).nullable(),
}));

export type WorkspaceAttentionRequest = z.infer<typeof WorkspaceAttentionRequestSchema>;
export type WorkspaceAttentionResult = z.infer<typeof WorkspaceAttentionResultSchema>;
export type WorkspaceDirectoryNotificationRequest = z.infer<typeof WorkspaceDirectoryNotificationRequestSchema>;
export type WorkspaceDirectoryNotificationState = z.infer<typeof WorkspaceDirectoryNotificationStateSchema>;
export type WorkspaceDirectoryScheduleTargetsRequest = z.infer<typeof WorkspaceDirectoryScheduleTargetsRequestSchema>;
export type WorkspaceDirectoryScheduleTargetsResult = z.infer<typeof WorkspaceDirectoryScheduleTargetsResultSchema>;
export type WorkspaceRegionalEffectApplyRequest = z.infer<typeof WorkspaceRegionalEffectApplyRequestSchema>;
export type WorkspaceRegionalEffectApplyResult = z.infer<typeof WorkspaceRegionalEffectApplyResultSchema>;
