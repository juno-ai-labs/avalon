import { ArtifactSidekickInvocationSchema } from "@rally/contracts";
import {
  AutomationDraftSchema,
  AutomationRunReferenceV1Schema,
  AutomationScopeSchema,
  AutomationSetEvaluatorRulesInputV1Schema,
  IdSchema,
  MESSAGE_MAX_CHARACTERS,
  PickedAppearanceSchema,
  SidekickAudienceUpdateSchema,
  SidekickMessageIntentSchema,
  SidekickSourceRequestInputSchema,
  UserIdSchema,
  WorkspaceExternalEventSchema,
  WorkspaceIdSchema,
  WorkstreamAppearancePatchSchema,
} from "@rally/contracts";
import { z } from "zod";

/**
 * What the Worker and the Queue consumer say to a hosted Sidekick.
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
  actorRole: z.enum(["owner", "admin", "member"]).nullable().optional(),
  participantOfOwningWorkstream: z.boolean().default(false),
});
export type AutomationActor = z.infer<typeof AutomationActorSchema>;

export const AutomationCreateRequestSchema = z.strictObject({
  ...Addressed,
  authorUserId: UserIdSchema,
  scope: AutomationScopeSchema,
  authorityGeneration: z.number().int().positive(),
  /**
   * The Canvas this Sidekick is being made for, by its Chat or by a request
   * to the Canvas's own route. It is attached to that Canvas in the creating
   * transaction, marked `made_here`, and everyone the Canvas admits manages
   * it. The host derives it; no caller names another conversation's Canvas.
   */
  madeInCanvasId: IdSchema.optional(),
});
export type AutomationCreateRequest = z.input<typeof AutomationCreateRequestSchema>;

export const AutomationSubmitDefinitionRequestSchema = z.strictObject({
  ...Addressed,
  draft: AutomationDraftSchema,
  evaluatorRules: AutomationSetEvaluatorRulesInputV1Schema.nullable(),
  submittedByRunId: IdSchema.nullable(),
  /**
   * The icon and colour the setup chat chose, written over the stored ones.
   * Optional because only the chat has to choose: a scripted definition
   * leaves the appearance as it is.
   */
  appearance: PickedAppearanceSchema.optional(),
  /**
   * Set when the wizard submits during a scheduled self-review: the revision
   * is then recorded against that review, so what reviews changed is one
   * query. A marker for reading, not a gate on writing.
   */
  origin: z.literal("sidekick_review").optional(),
});
export type AutomationSubmitDefinitionRequest = z.infer<typeof AutomationSubmitDefinitionRequestSchema>;

export const AutomationActorRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
});
export type AutomationActorRequest = z.infer<typeof AutomationActorRequestSchema>;

/** A manager asks people to let events from one of their connectors start the Sidekick. */
export const SidekickSourceAskRequestSchema = AutomationActorRequestSchema.extend({
  ask: SidekickSourceRequestInputSchema,
  /** The asker's name as it is now, kept on the request for the person asked. */
  actorName: z.string(),
});
export type SidekickSourceAskRequest = z.infer<typeof SidekickSourceAskRequestSchema>;

/** The asked person answers. `userId` is who answers, established by the caller (a session, or the signed link). */
export const SidekickSourceDecisionRequestSchema = z.strictObject({
  ...Addressed,
  requestId: IdSchema,
  userId: UserIdSchema,
  decision: z.enum(["approve", "decline"]),
});
export type SidekickSourceDecisionRequest = z.infer<typeof SidekickSourceDecisionRequestSchema>;

/** A person takes back what they let in from one connection. */
export const SidekickSourceWithdrawRequestSchema = z.strictObject({
  ...Addressed,
  userId: UserIdSchema,
  connectionId: IdSchema,
});
export type SidekickSourceWithdrawRequest = z.infer<typeof SidekickSourceWithdrawRequestSchema>;

/** One request as one reader may see it; null from the object when they may not. */
export const SidekickSourceRequestReadSchema = AutomationActorRequestSchema.extend({ requestId: IdSchema });
export type SidekickSourceRequestRead = z.infer<typeof SidekickSourceRequestReadSchema>;

export const AutomationRunListRequestSchema = AutomationActorRequestSchema.extend({
  before: z.strictObject({ createdAt: z.number().int().nonnegative(), runId: IdSchema }).optional(),
  limit: z.number().int().positive().optional(),
});
export type AutomationRunListRequest = z.infer<typeof AutomationRunListRequestSchema>;
export const AutomationRunReadRequestSchema = AutomationActorRequestSchema.extend({ runId: IdSchema });
export type AutomationRunReadRequest = z.infer<typeof AutomationRunReadRequestSchema>;

/** Host-private preparation state, never part of a model-advertised input. */
export const SidekickPrepareDelegationRequestSchema = z.strictObject({
  ...Addressed, userId: UserIdSchema, allowed: z.boolean(), operationId: IdSchema,
});
export const SidekickSetDelegationRequestSchema = SidekickPrepareDelegationRequestSchema.extend({
  actorUserId: UserIdSchema.optional(),
  expectedGeneration: z.number().int().nonnegative(),
  source: z.enum(["self_service", "agent_request"]),
});
export const SidekickReadDelegationReceiptRequestSchema = SidekickPrepareDelegationRequestSchema.extend({
  actorUserId: UserIdSchema.optional(),
  source: z.enum(["self_service", "agent_request"]),
});


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

/** A manager's choice of who a Sidekick is shared with (`SidekickAudienceUpdateSchema`). */
export const AutomationSetAudienceRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
  update: SidekickAudienceUpdateSchema,
});
export type AutomationSetAudienceRequest = z.input<typeof AutomationSetAudienceRequestSchema>;

export const SidekickInvocationRequestSchema = ArtifactSidekickInvocationSchema.extend({ automationId: IdSchema });
export type SidekickInvocationRequest = z.infer<typeof SidekickInvocationRequestSchema>;

export const AutomationRunNowRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
  idempotencyKey: z.string().min(8).max(120),
});
export type AutomationRunNowRequest = z.infer<typeof AutomationRunNowRequestSchema>;

/**
 * What the caller judged a `semantic_activity` trigger's written condition to be.
 *
 * The verdict crosses the boundary because the model call belongs outside the
 * object: every other model call in this tree runs in a Worker, and an object
 * that blocked on a provider would serialize every other request to the same
 * Sidekick behind it. The object still decides, though — it knows which of its
 * triggers are gated, so a delivery that arrives without a verdict for a gated
 * event is refused rather than admitted.
 *
 * `code` is an enum and not the free text the classifier could have produced: it
 * reaches an outcome code that a runbook greps for, and a caller must not be
 * able to write arbitrary strings into one.
 */
export const AutomationSemanticConditionVerdictSchema = z.strictObject({
  admit: z.boolean(),
  code: z.enum([
    "condition_met",
    "condition_not_met",
    "condition_not_judgeable",
    "confidence_below_threshold",
    "classifier_unavailable",
  ]),
  confidence: z.number().min(0).max(1).nullable(),
  model: z.string().min(1).max(200).nullable(),
});
export type AutomationSemanticConditionVerdict = z.infer<typeof AutomationSemanticConditionVerdictSchema>;

export const AutomationExternalEventAdmissionSchema = z.strictObject({
  ...Addressed,
  registrationId: IdSchema,
  event: WorkspaceExternalEventSchema,
  payloadHash: z.string().min(1),
  /**
   * Required in effect, not in schema: a gated event without one is refused.
   * Optional here so an ungated delivery — every `connector_activity` and
   * `webhook` trigger, which is nearly all of them — carries nothing extra.
   */
  conditionVerdict: AutomationSemanticConditionVerdictSchema.optional(),
  /**
   * The verdict on the source's own condition: the filter of the person whose
   * events these are. Required in effect for an event whose source carries a
   * condition, and separate from `conditionVerdict` because the two filters
   * have different owners and both must hold.
   */
  sourceVerdict: AutomationSemanticConditionVerdictSchema.extend({
    /**
     * The conditions this verdict judged, as the first call returned them. A
     * person's filter can change while the classifier runs; a verdict on a
     * filter that is no longer theirs admits nothing.
     */
    conditions: z.array(z.string()),
  }).optional(),
});
export type AutomationExternalEventAdmission = z.infer<typeof AutomationExternalEventAdmissionSchema>;

/**
 * What a delivery has to do before it may admit an event.
 *
 * `judge` carries the conditions to test and the connector they came from, so
 * the caller needs no second read to build the classifier's state.
 */
export const AutomationExternalEventPlanSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("refuse"), outcomeCode: z.string().min(1) }),
  z.strictObject({ kind: z.literal("admit") }),
  z.strictObject({
    kind: z.literal("judge"),
    conditions: z.array(z.string().min(1)),
    connectorType: z.string().min(1).nullable(),
  }),
]);
export type AutomationExternalEventPlan = z.infer<typeof AutomationExternalEventPlanSchema>;

export const AutomationRunRequestSchema = z.strictObject({
  ...Addressed,
  runId: IdSchema,
});
export type AutomationRunRequest = z.infer<typeof AutomationRunRequestSchema>;

/**
 * A run's definition, read by the revision its loop input names.
 *
 * `definitionRevision` is optional so a caller that names only the run keeps
 * reading the revision the run was admitted under. A continued run names the
 * revision `continueRun` handed it, which is the Sidekick's accepted revision
 * at the moment the run continued, not the one it started with.
 */
export const AutomationRunDefinitionRequestSchema = AutomationRunRequestSchema.extend({
  definitionRevision: z.number().int().positive().optional(),
});
export type AutomationRunDefinitionRequest = z.infer<typeof AutomationRunDefinitionRequestSchema>;

/** Why input to a Sidekick run child did not continue the run. */
/**
 * Who sent the input that would continue a run, as the run child's queue
 * recorded it: a person (their own message or an answer to a question the run
 * asked), outside text from a provider thread bound to the run, or Rally
 * itself (a scheduled wake-up, a worker's report, an agent's message). The
 * Sidekick decides from it whether that input may continue the run; see
 * `HostedSidekick.continueRun`.
 */
export const SidekickRunContinuationSenderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), userId: UserIdSchema }),
  /** Outside text from a provider thread bound to the run, which the run's own outbound message bound. */
  z.strictObject({ kind: z.literal("external") }),
  /** Another agent's message acting for no person (an Organization-authority turn). */
  z.strictObject({ kind: z.literal("unattributed") }),
  z.strictObject({ kind: z.literal("system") }),
]);
export type SidekickRunContinuationSender = z.infer<typeof SidekickRunContinuationSenderSchema>;

export const SidekickRunContinuationRequestSchema = z.strictObject({
  ...Addressed,
  runId: IdSchema,
  sender: SidekickRunContinuationSenderSchema,
});
export type SidekickRunContinuationRequest = z.infer<typeof SidekickRunContinuationRequestSchema>;

export const SidekickRunContinuationRefusalCodeSchema = z.enum([
  "sidekick_paused",
  "sidekick_deleted",
  "run_not_found",
  "run_no_eligible_delegate",
  /** A person other than its requester wrote in a run that acts under the requester's own access. */
  "run_continuation_requires_requester",
  /** A person who does not manage the Sidekick wrote in a run that acts as the Sidekick itself. */
  "run_continuation_requires_manager",
  /** A person who is not an eligible delegate wrote in a run that acts under a delegate's access. */
  "run_continuation_requires_delegate",
  /** Another agent's message acting for no person who may continue the run. */
  "run_continuation_requires_rally_user",
]);
export type SidekickRunContinuationRefusalCode = z.infer<typeof SidekickRunContinuationRefusalCodeSchema>;

/**
 * What `continueRun` answers: a refusal, or the run context the scheduled start
 * builds, against the Sidekick's currently accepted revision.
 *
 * `stopGeneration` is the Sidekick's stop counter when it approved the
 * continuation. The run row still reads finished until the child's own
 * `running` projection reaches the parent through the Queue, so the run
 * authority check lets a continuation act through a finished row; a `stopped`
 * row only while the counter has not moved, so a pause that lands after the
 * approval still refuses. A counter rather than a time: a pause on the
 * approval's own millisecond is still after it.
 */
export const SidekickRunContinuationSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("refused"),
    code: SidekickRunContinuationRefusalCodeSchema,
  }),
  z.strictObject({
    outcome: z.literal("continue"),
    automationRun: AutomationRunReferenceV1Schema,
    /**
     * Who the continued run acts as: a person, or the Organization when no
     * delegate is behind the run and it acts as the Sidekick itself.
     */
    executionPrincipal: z.union([
      z.strictObject({ type: z.literal("user"), userId: UserIdSchema }),
      z.strictObject({ type: z.literal("workspace"), workspaceId: WorkspaceIdSchema }),
    ]),
    stopGeneration: z.number().int().nonnegative(),
  }),
]);
export type SidekickRunContinuation = z.infer<typeof SidekickRunContinuationSchema>;

/**
 * A person's input in the Sidekick's shared conversation (substream `"0"`)
 * that reaches an agent, asked about once before the conversation's loop
 * takes it. `messageId` is the turn the input lands as, so a retried claim
 * admits the same run. `intent` is `edit_sidekick` when the input is for the
 * wizard: a message its sender marked as an edit, or an answer to something
 * the wizard asked. `authorName` is the sender's display name as the
 * conversation snapshotted it, unbounded like `UserSchema.name`.
 */
export const SidekickConversationMessageRequestSchema = z.strictObject({
  ...Addressed,
  actor: AutomationActorSchema,
  messageId: IdSchema,
  intent: SidekickMessageIntentSchema.nullable(),
  authorName: z.string().nullable(),
  text: z.string().min(1),
});
/** The caller's side, so a default (`participantOfOwningWorkstream`) need not be spelled. */
export type SidekickConversationMessageRequest = z.input<typeof SidekickConversationMessageRequestSchema>;

/** Why a message addressed to the Sidekick started no run. */
export const SidekickConversationMessageRefusalCodeSchema = z.enum([
  "sidekick_not_active",
  "sidekick_not_runnable",
  "run_no_eligible_delegate",
  /** The input was for the wizard (`intent: "edit_sidekick"`) and its sender does not manage the Sidekick. */
  "sidekick_edit_requires_manager",
]);
export type SidekickConversationMessageRefusalCode = z.infer<typeof SidekickConversationMessageRefusalCodeSchema>;

/**
 * Who answers the message: the wizard (an edit from a manager, which is the
 * authoring turn), a run the message started, or nobody, with why.
 */
export const SidekickConversationMessageRouteSchema = z.discriminatedUnion("route", [
  z.strictObject({ route: z.literal("wizard") }),
  z.strictObject({ route: z.literal("run"), runId: IdSchema, reused: z.boolean() }),
  z.strictObject({ route: z.literal("refused"), code: SidekickConversationMessageRefusalCodeSchema }),
]);
export type SidekickConversationMessageRoute = z.infer<typeof SidekickConversationMessageRouteSchema>;

/**
 * One run, as its row in the Sidekick's shared conversation shows it: a
 * projection of the Sidekick's `sidekick_runs` row, sent whole each time so
 * any delivery converges. `version` is the run row's `updated_at`; the
 * conversation applies a projection not older than the one it holds.
 */
export const SidekickRunRowProjectionSchema = z.strictObject({
  ...Addressed,
  runId: IdSchema,
  automationName: z.string().min(1).max(300),
  triggerKind: z.enum(["manual", "schedule", "external_event", "invocation", "inbound_email"]),
  createdAt: z.number().int().nonnegative(),
  state: z.enum(["pending", "running", "needs_input", "completed", "failed", "stopped"]),
  stepCount: z.number().int().nonnegative(),
  reply: z.string().max(MESSAGE_MAX_CHARACTERS).nullable(),
  version: z.number().int().nonnegative(),
  /**
   * The person whose own request started the run — Run now, or a message in
   * the shared conversation — or null for a trigger's. While the run works,
   * the row's write reads as seen by them: they are looking at what they
   * asked for, so it is not news to them. Optional so a projection queued
   * before the field still parses.
   */
  requesterUserId: IdSchema.nullable().optional(),
  /**
   * The run's ordinal among its Sidekick's runs, oldest first, read with the
   * run. Optional so a projection queued before the field still parses.
   */
  runNumber: z.number().int().positive().optional(),
  /**
   * Set by a replay: apply this projection even when the conversation holds a
   * newer version. Safe because the projection is the run read at delivery,
   * and it is how a row whose version ran ahead of its run is repaired.
   */
  replay: z.boolean().default(false),
});
export type SidekickRunRowProjection = z.input<typeof SidekickRunRowProjectionSchema>;

export const AUTOMATION_SCHEDULE_ALARM_KIND = "automation_schedule";
export const AUTOMATION_RUN_ALARM_KIND = "automation_run";
/** One entry per Sidekick, armed when enough runs have finished; see `HostedSidekick.startReview`. */
export const SIDEKICK_REVIEW_ALARM_KIND = "sidekick_review";

export const AutomationReviewRequestSchema = z.strictObject({
  ...Addressed,
  reviewId: IdSchema,
});
export type AutomationReviewRequest = z.infer<typeof AutomationReviewRequestSchema>;

export const SidekickSkillReadRequestSchema = z.strictObject({
  ...Addressed,
  principalUserId: UserIdSchema.nullable(),
  conversationParentId: IdSchema,
  audienceScope: z.enum(["personal", "workspace"]),
  audienceUserIds: z.array(UserIdSchema),
  existingExecution: z.boolean().optional(),
});
export type SidekickSkillReadRequest = z.infer<typeof SidekickSkillReadRequestSchema>;

/**
 * Several Sidekicks' skill reads in one call: by id, every active loadable
 * one in the Organization (`allLoadable`, what a run offers as skills), or
 * both. `onlyScope` keeps
 * only Sidekicks of that scope, for a caller that may offer only Organization
 * ones.
 */
export const SidekickBatchSkillReadRequestSchema = SidekickSkillReadRequestSchema.omit({ automationId: true }).extend({
  automationIds: z.array(IdSchema).optional(),
  allLoadable: z.boolean().optional(),
  onlyScope: z.enum(["personal", "workspace", "workstream"]).optional(),
}).strict();
export type SidekickBatchSkillReadRequest = z.infer<typeof SidekickBatchSkillReadRequestSchema>;

/** Several Sidekicks' details in one call, by id. */
export const SidekickBatchDetailRequestSchema = AutomationActorRequestSchema.omit({ automationId: true }).extend({
  automationIds: z.array(IdSchema).optional(),
}).strict();
export type SidekickBatchDetailRequest = z.infer<typeof SidekickBatchDetailRequestSchema>;

/**
 * The activity-Queue message that starts a hosted Sidekick's run. Its consumer
 * reads what to provision from `WorkspaceDO`, opens the run's conversation,
 * starts its loop, and reports back; see `HostedSidekick.startRun`.
 */
export const SidekickRunProvisionQueueMessageSchema = z.strictObject({
  kind: z.literal("sidekick_run_provision"),
  region: z.string().min(1),
  workspaceId: WorkspaceIdSchema,
  automationId: IdSchema,
  runId: IdSchema,
});
export type SidekickRunProvisionQueueMessage = z.infer<typeof SidekickRunProvisionQueueMessageSchema>;

/**
 * The activity-Queue message that wakes a hosted Sidekick's wizard for a
 * scheduled self-review. Its consumer reads the notice from `WorkspaceDO`,
 * admits it into the authoring conversation, and reports back; see
 * `HostedSidekick.startReview`.
 */
export const SidekickReviewQueueMessageSchema = z.strictObject({
  kind: z.literal("sidekick_review"),
  region: z.string().min(1),
  workspaceId: WorkspaceIdSchema,
  automationId: IdSchema,
  reviewId: IdSchema,
});
export type SidekickReviewQueueMessage = z.infer<typeof SidekickReviewQueueMessageSchema>;
