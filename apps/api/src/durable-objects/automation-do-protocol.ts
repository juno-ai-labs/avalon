import {
  AutomationDraftSchema,
  AutomationScopeSchema,
  AutomationSetEvaluatorRulesInputV1Schema,
  DemoSeedSchema,
  IdSchema,
  UserIdSchema,
  WorkspaceExternalEventSchema,
  WorkspaceIdSchema,
  WorkstreamAppearancePatchSchema,
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

/**
 * A partial icon/colour choice for the Sidekick itself.
 *
 * A patch rather than a whole appearance, for the reason the work stream's
 * command is one: two people picking at once change a field each, and sending
 * the pair would let the second one silently undo the first's colour.
 */
export const AutomationSetAppearanceRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
  appearance: WorkstreamAppearancePatchSchema,
});
export type AutomationSetAppearanceRequest = z.infer<typeof AutomationSetAppearanceRequestSchema>;

export const AutomationRunNowRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
  idempotencyKey: z.string().min(8).max(120),
});
export type AutomationRunNowRequest = z.infer<typeof AutomationRunNowRequestSchema>;

/**
 * A demo's request for one run whose model bytes come from its pack.
 *
 * Deliberately not a field on `AutomationRunNowRequest`: that shape is what a
 * client's `POST /sidekicks/:id/run` body reaches, and a seed there would let a
 * member write their own Sidekick's output into its run history. This shape is
 * reachable only from the demo seeder. The occurrence key comes from the pack
 * and the action, so replaying a half-finished seeding answers from the run it
 * already admitted rather than running a second briefing.
 */
export const AutomationRunSeededRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
  seed: DemoSeedSchema,
});
export type AutomationRunSeededRequest = z.infer<typeof AutomationRunSeededRequestSchema>;

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
