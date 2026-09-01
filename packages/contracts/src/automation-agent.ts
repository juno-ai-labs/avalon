import { z } from "zod";
import {
  IdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./identifiers";

export const AutomationIdSchema = IdSchema.brand<"AutomationId">();
export type AutomationId = z.infer<typeof AutomationIdSchema>;
export const asAutomationId = (value: string): AutomationId => AutomationIdSchema.parse(value);

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
