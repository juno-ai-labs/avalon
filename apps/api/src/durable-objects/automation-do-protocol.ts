import {
  AutomationDraftSchema,
  AutomationScopeSchema,
  AutomationSetEvaluatorRulesInputV1Schema,
  IdSchema,
  UserIdSchema,
  WorkspaceExternalEventSchema,
  WorkspaceIdSchema,
} from "@rally/contracts";
import { z } from "zod";

/**
 * What the Worker and the Queue consumer say to an `AutomationDO`.
 *
 * Every request names the automation and its workspace; the object asserts
 * them against its own row before anything else. Membership is the Worker's
 * to verify, so an actor here is a member already; what the object decides is
 * what that member may do to this automation.
 */

const Addressed = {
  workspaceId: WorkspaceIdSchema,
  automationId: IdSchema,
} as const;

/** Who is acting, resolved by the Worker: their role, and whether they are in the owning room. */
export const AutomationActorSchema = z.strictObject({
  userId: UserIdSchema,
  actorRole: z.enum(["owner", "admin", "member"]).optional(),
  participantOfOwningWorkstream: z.boolean().default(false),
});
export type AutomationActor = z.infer<typeof AutomationActorSchema>;

export const AutomationCreateRequestSchema = z.strictObject({
  ...Addressed,
  authorUserId: UserIdSchema,
  scope: AutomationScopeSchema,
  owningWorkstreamId: IdSchema.nullable(),
  authorityGeneration: z.number().int().positive(),
}).superRefine((value, context) => {
  if ((value.scope === "workstream") !== (value.owningWorkstreamId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["owningWorkstreamId"],
      message: "A room-scoped automation names its room, and no other scope may.",
    });
  }
});
export type AutomationCreateRequest = z.infer<typeof AutomationCreateRequestSchema>;

export const AutomationSubmitDefinitionRequestSchema = z.strictObject({
  ...Addressed,
  draft: AutomationDraftSchema,
  evaluatorRules: AutomationSetEvaluatorRulesInputV1Schema.nullable(),
  submittedByRunId: IdSchema.nullable(),
});
export type AutomationSubmitDefinitionRequest = z.infer<typeof AutomationSubmitDefinitionRequestSchema>;

export const AutomationActorRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
});
export type AutomationActorRequest = z.infer<typeof AutomationActorRequestSchema>;

export const AutomationRunNowRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
  idempotencyKey: z.string().min(8).max(120),
});
export type AutomationRunNowRequest = z.infer<typeof AutomationRunNowRequestSchema>;

export const AutomationOwningRoomArchivedRequestSchema = z.strictObject({
  ...Addressed,
  workstreamId: IdSchema,
  archived: z.boolean(),
});
export type AutomationOwningRoomArchivedRequest = z.infer<typeof AutomationOwningRoomArchivedRequestSchema>;

export const AutomationExternalEventAdmissionSchema = z.strictObject({
  ...Addressed,
  registrationId: IdSchema,
  event: WorkspaceExternalEventSchema,
  payloadHash: z.string().min(1),
});
export type AutomationExternalEventAdmission = z.infer<typeof AutomationExternalEventAdmissionSchema>;

export const AutomationInboundEmailAdmissionSchema = z.strictObject({
  ...Addressed,
  emailAddress: z.string().email(),
  resendEmailId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u),
  senderUserId: UserIdSchema.nullable(),
  receivedAt: z.number().int().nonnegative(),
  payloadRef: z.string().min(1),
  resourceId: IdSchema,
  textContent: z.string().min(1),
  structuredContent: z.record(z.string(), z.unknown()),
});
export type AutomationInboundEmailAdmission = z.infer<typeof AutomationInboundEmailAdmissionSchema>;

export const AutomationRunRequestSchema = z.strictObject({
  ...Addressed,
  runId: IdSchema,
});
export type AutomationRunRequest = z.infer<typeof AutomationRunRequestSchema>;

export const AUTOMATION_SCHEDULE_ALARM_KIND = "automation_schedule";
export const AUTOMATION_RUN_ALARM_KIND = "automation_run";

export const SidekickSkillReadRequestSchema = z.strictObject({
  ...Addressed,
  principalUserId: UserIdSchema.nullable(),
  conversationParentId: IdSchema,
  audienceScope: z.enum(["personal", "workspace"]),
  audienceUserIds: z.array(UserIdSchema),
  existingExecution: z.boolean().optional(),
});
export type SidekickSkillReadRequest = z.infer<typeof SidekickSkillReadRequestSchema>;
