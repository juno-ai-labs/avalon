import { z } from "zod";
import {
  IdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./identifiers";

export const AutomationIdSchema = IdSchema.brand<"AutomationId">();
export type AutomationId = z.infer<typeof AutomationIdSchema>;
export const asAutomationId = (value: string): AutomationId => AutomationIdSchema.parse(value);

/**
 * Who can see an automation and who may change it — and nothing else.
 *
 * Deliberately not `ScopeSchema`, which a work stream shares: a work stream has
 * no third scope, and widening the shared enum would offer `workstream` in
 * every place a room's audience is chosen.
 *
 * Scope is not a destination. Where a result goes follows from what the
 * automation belongs to: a person's own destinations for `personal`, the owning
 * room for `workstream`, and nothing at all for `workspace`, which reaches
 * people by acting with its connector tools rather than by delivering.
 */
export const AutomationScopeSchema = z.enum(["personal", "workspace", "workstream"]);
export type AutomationScope = z.infer<typeof AutomationScopeSchema>;

export const AutomationLifecycleStateSchema = z.enum([
  "draft",
  "activating",
  "active",
  "paused",
  "deleted",
]);

export const AutomationCompilerRunStateSchema = z.enum([
  "admitted",
  "running",
  "needs_input",
  "completed",
  "failed",
  "cancelled",
]);

export const AutomationDraftTurnAdmissionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  authorUserId: UserIdSchema,
  region: z.enum(["global", "eu"]),
  clientMessageId: IdSchema,
  content: z.string().min(1),
  attachmentIds: z.array(IdSchema).default([]),
  inputMode: z.enum(["typed", "suggested_prompt", "elicitation_response", "edit"]).default("typed"),
});

export const AutomationDraftCreationClaimRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceIdSchema,
  authorUserId: UserIdSchema,
  region: z.enum(["global", "eu"]),
  clientCreationKey: IdSchema,
});

export const AutomationDraftCreationClaimResultSchema = z.strictObject({
  automationId: AutomationIdSchema,
  created: z.boolean(),
});

export const AutomationDraftTurnAdmissionResultSchema = z.strictObject({
  automationId: AutomationIdSchema,
  turnId: IdSchema,
  transcriptSequence: z.number().int().positive(),
  compilerRunId: IdSchema,
  admitted: z.boolean(),
  /**
   * The coordinate the agent allocated for this turn's directory projection.
   *
   * The Worker seeds the first projection directly so the sidebar row exists
   * before the outbox drains, and WorkspaceDO discards a projection that is
   * not strictly newer — so both writers have to draw from the object's one
   * monotonic counter rather than each inventing a number.
   */
  projectionVersion: z.number().int().positive().optional(),
});

export const AutomationDraftMessageSchema = z.strictObject({
  turnId: IdSchema,
  transcriptSequence: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  authorUserId: UserIdSchema.nullable(),
  clientMessageId: IdSchema.nullable(),
  content: z.string(),
  attachmentIds: z.array(IdSchema),
  createdAt: z.number().int().nonnegative(),
});

/**
 * What an automation delivered into a work stream, as the row's typed content.
 *
 * The row itself is an ordinary message authored by "Automation"; everything
 * specific to an activation lives here, inside the `structuredContent` every
 * other typed row already uses. No column, no table, no migration.
 */
export const AutomationActivationV1Schema = z.strictObject({
  type: z.literal("automation_activation"),
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  /**
   * Frozen at delivery so a later rename does not rewrite history — the same
   * reason a delivery receipt carries the address it was sent to rather than
   * looking one up.
   */
  automationName: z.string().min(1).max(300),
  runId: IdSchema,
  /** What an "open the run" affordance needs; the run's own child work stream. */
  runWorkstreamId: IdSchema,
  deliveryId: z.string().min(1).max(200),
  /**
   * Provenance a reader and the model can both see. It narrows nothing about
   * what the woken run may do: an activation from an inbound email is the same
   * kind of arrival as one from a Monday schedule, and the untrusted label is
   * what carries the difference in how far to trust the text.
   */
  trigger: z.strictObject({
    kind: z.enum(["manual", "schedule", "external_event", "inbound_email"]),
  }).strict(),
  occurredAt: z.number().int().nonnegative(),
});
export type AutomationActivationV1 = z.infer<typeof AutomationActivationV1Schema>;

export const AutomationAgentSnapshotSchema = z.strictObject({
export const AutomationAgentSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  authorUserId: UserIdSchema,
  region: z.enum(["global", "eu"]),
  lifecycle: AutomationLifecycleStateSchema,
  authorityGeneration: z.number().int().positive(),
  title: z.string(),
  definitionRevision: z.number().int().nonnegative(),
  definition: z.unknown().nullable(),
  messages: z.array(AutomationDraftMessageSchema),
  activeCompilerRun: z.strictObject({
    id: IdSchema,
    state: AutomationCompilerRunStateSchema,
    admittedTurnId: IdSchema,
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }).nullable(),
  compilerCheckpoint: z.strictObject({
    runId: IdSchema,
    narration: z.string(),
  }).nullable(),
  pendingElicitation: z.strictObject({
    id: IdSchema,
    definitionRevision: z.number().int().positive(),
    payload: z.unknown(),
  }).nullable(),
  eventSequence: z.number().int().nonnegative(),
});

export const AutomationSetEvaluatorRulesMutationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  authorUserId: UserIdSchema,
  compilerRunId: IdSchema,
  providerCallId: z.string().min(1),
  inputHash: z.string().min(1),
  evaluatorRules: z.unknown(),
});

const AutomationRunDeliveryTargetV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("email"),
    emailAddress: z.string().email(),
  }),
  z.strictObject({
    type: z.literal("slack_agent_dm"),
    connectionId: IdSchema,
    slackTeamId: z.string().min(1),
    slackUserId: z.string().min(1),
  }),
]);

export const AutomationRunTriggerV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual"), requestedByUserId: UserIdSchema }),
  z.strictObject({
    kind: z.literal("schedule"),
    scheduleId: IdSchema,
    scheduleKind: z.enum(["calendar", "interval"]),
    plannedFor: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("external_event"),
    workspaceEventId: IdSchema,
    eventType: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    payloadHash: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("inbound_email"),
    receiptId: IdSchema,
    occurredAt: z.number().int().nonnegative(),
  }),
]);

/**
 * The card a room gets when the person an automation runs as loses access.
 *
 * A `system` row, because this is Rally noting something that happened *to* the
 * work stream rather than somebody speaking in it — the opposite call from an
 * activation, which is a message with an author. Idempotent on the automation
 * and the outgoing principal, and edited in place as providers are repaired, so
 * an hourly automation writes one card rather than one an hour.
 */
export const AutomationPrincipalUnavailableV1Schema = z.object({
  type: z.literal("automation_principal_unavailable"),
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  automationName: z.string().min(1).max(300),
  /** Whose access ended. Named so the room knows why, not to attribute blame. */
  outgoingUserId: IdSchema,
  outgoingUserName: z.string().min(1).max(300).nullable(),
  /**
   * What is unreachable right now. Workspace-scoped bindings never appear here:
   * they belong to the workspace rather than to whoever authorized them, so
   * they keep working and the automation keeps delivering on them.
   */
  unreachableProviders: z.array(z.string().min(1)).min(1),
}).strict();
export type AutomationPrincipalUnavailableV1 =
  z.infer<typeof AutomationPrincipalUnavailableV1Schema>;

/**
 * The card proposing an automation an agent drafted in this work stream.
 *
 * A `system` row: Rally noting that something now exists for the room to decide
 * about. The draft itself lives on the automation object — this carries only
 * what the card shows and the id the accept action needs, so a card that has
 * scrolled out of a long feed cannot disagree with the automation it proposes.
 */
export const AutomationDraftProposedV1Schema = z.object({
  type: z.literal("automation_draft_proposed"),
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  automationName: z.string().min(1).max(300),
  description: z.string().min(1).max(1200),
  /** One line per trigger, already rendered: the card shows them, not parses them. */
  triggerSummaries: z.array(z.string().min(1).max(300)).max(10),
  suggestedScope: AutomationScopeSchema,
  /**
   * False when the agent still has a blocking question. The card says so and
   * offers no accept, because accepting an unfinished draft freezes the gap.
   */
  ready: z.boolean(),
}).strict();
export type AutomationDraftProposedV1 = z.infer<typeof AutomationDraftProposedV1Schema>;

/** Immutable, self-contained execution input frozen when an occurrence commits. */
export const AutomationRunContextV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  runId: IdSchema,
  authorityGeneration: z.number().int().positive(),
  definitionRevision: z.number().int().positive(),
  definition: z.strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    overview: z.string().min(1),
    instructions: z.string().min(1),
    requiredCapabilities: z.array(z.string()),
    expectedOutputs: z.array(z.string()),
    defaultBehavior: z.record(z.string(), z.unknown()),
    recommendedPlugins: z.array(z.unknown()),
    memoryTables: z.array(z.unknown()),
  }),
  defaultPluginIds: z.array(z.string().min(1)),
  activitySourcePluginIds: z.record(z.string(), z.string().min(1)),
  connectorBindings: z.record(z.string(), z.unknown()),
  deliveryTargets: z.array(AutomationRunDeliveryTargetV1Schema),
  /**
   * The work stream that owns this automation, for a `workstream`-scoped one.
   *
   * Frozen here rather than resolved at delivery, and not part of
   * `deliveryTargets`: nobody chose it. A room's automation delivers to its
   * room because that is what it belongs to, so there is no entry to keep in
   * agreement with the scope and no principal to record beside it.
   */
  owningWorkstreamId: IdSchema.nullable().default(null),
  /**
   * The accepted scope, frozen so exposing a run cannot widen it after the
   * fact. Null on a context frozen before this was recorded: exposing such a
   * run reveals it without changing its work stream's scope, because guessing
   * wrong in the other direction shares somebody's run with the workspace.
   */
  scope: AutomationScopeSchema.nullable().default(null),
  /**
   * Where the conversation that produced this automation was happening, when
   * that place is somewhere an occurrence can speak.
   *
   * Standing context, not instructions. "Ask what each person shipped" is what
   * the automation does and belongs in text a person reads and edits; which
   * channel this occurrence is speaking from is where it is authorized to act,
   * and belongs where the run learns the rest of what it may work with.
   * Writing the id into the instructions instead would freeze a literal into
   * prose that every later edit, rename, or move would have to find and rewrite.
   */
  authoringOrigin: z.object({
    kind: z.literal("slack"),
    teamId: z.string().min(1).max(255),
    channelId: z.string().min(1).max(255),
    channelName: z.string().min(1).max(255).nullable(),
  }).strict().nullable().default(null),
  modelOverride: z.string().min(1).nullable(),
  executionPrincipal: z.strictObject({ type: z.literal("user"), userId: UserIdSchema }),
  trigger: AutomationRunTriggerV1Schema,
  opening: z.strictObject({
    clientMessageId: IdSchema,
    textContent: z.string().min(1),
    structuredContent: z.record(z.string(), z.unknown()),
    resourceId: IdSchema,
  }).nullable().default(null),
  memoryScope: z.strictObject({
    automationId: AutomationIdSchema,
    authorityGeneration: z.number().int().positive(),
  }),
});

export type AutomationLifecycleState = z.infer<typeof AutomationLifecycleStateSchema>;
export type AutomationDraftTurnAdmissionRequest = z.infer<typeof AutomationDraftTurnAdmissionRequestSchema>;
export type AutomationDraftTurnAdmissionResult = z.infer<typeof AutomationDraftTurnAdmissionResultSchema>;
export type AutomationDraftCreationClaimRequest = z.infer<typeof AutomationDraftCreationClaimRequestSchema>;
export type AutomationDraftCreationClaimResult = z.infer<typeof AutomationDraftCreationClaimResultSchema>;
export type AutomationAgentSnapshot = z.infer<typeof AutomationAgentSnapshotSchema>;
export type AutomationSetEvaluatorRulesMutation = z.infer<typeof AutomationSetEvaluatorRulesMutationSchema>;
export type AutomationRunContextV1 = z.infer<typeof AutomationRunContextV1Schema>;
