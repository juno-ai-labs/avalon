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

export const AutomationDraftTurnAdmissionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  authorUserId: UserIdSchema,
  region: z.enum(["global", "eu"]),
  clientMessageId: IdSchema,
  content: z.string().min(1),
  attachmentIds: z.array(IdSchema).default([]),
  inputMode: z.enum(["typed", "suggested_prompt", "elicitation_response", "edit"]).default("typed"),
}).strict();

export const AutomationDraftCreationClaimRequestSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceIdSchema,
  authorUserId: UserIdSchema,
  region: z.enum(["global", "eu"]),
  clientCreationKey: IdSchema,
}).strict();

export const AutomationDraftCreationClaimResultSchema = z.object({
  automationId: AutomationIdSchema,
  created: z.boolean(),
}).strict();

export const AutomationDraftTurnAdmissionResultSchema = z.object({
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
}).strict();

export const AutomationDraftMessageSchema = z.object({
  turnId: IdSchema,
  transcriptSequence: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  authorUserId: UserIdSchema.nullable(),
  clientMessageId: IdSchema.nullable(),
  content: z.string(),
  attachmentIds: z.array(IdSchema),
  createdAt: z.number().int().nonnegative(),
}).strict();

/**
 * What an automation delivered into a work stream, as the row's typed content.
 *
 * The row itself is an ordinary message authored by "Automation"; everything
 * specific to an activation lives here, inside the `structuredContent` every
 * other typed row already uses. No column, no table, no migration.
 */
export const AutomationActivationV1Schema = z.object({
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
  trigger: z.object({
    kind: z.enum(["manual", "schedule", "external_event", "inbound_email"]),
  }).strict(),
  occurredAt: z.number().int().nonnegative(),
}).strict();
export type AutomationActivationV1 = z.infer<typeof AutomationActivationV1Schema>;

export const AutomationAgentSnapshotSchema = z.object({
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
  activeCompilerRun: z.object({
    id: IdSchema,
    state: AutomationCompilerRunStateSchema,
    admittedTurnId: IdSchema,
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }).strict().nullable(),
  compilerCheckpoint: z.object({
    runId: IdSchema,
    narration: z.string(),
  }).strict().nullable(),
  pendingElicitation: z.object({
    id: IdSchema,
    definitionRevision: z.number().int().positive(),
    payload: z.unknown(),
  }).strict().nullable(),
  eventSequence: z.number().int().nonnegative(),
}).strict();

export const AutomationSetEvaluatorRulesMutationSchema = z.object({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  authorUserId: UserIdSchema,
  compilerRunId: IdSchema,
  providerCallId: z.string().min(1),
  inputHash: z.string().min(1),
  evaluatorRules: z.unknown(),
}).strict();

const AutomationRunDeliveryTargetV1Schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    emailAddress: z.string().email(),
  }).strict(),
  z.object({
    type: z.literal("slack_agent_dm"),
    connectionId: IdSchema,
    slackTeamId: z.string().min(1),
    slackUserId: z.string().min(1),
  }).strict(),
]);

export const AutomationRunTriggerV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), requestedByUserId: UserIdSchema }).strict(),
  z.object({
    kind: z.literal("schedule"),
    scheduleId: IdSchema,
    scheduleKind: z.enum(["calendar", "interval"]),
    plannedFor: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("external_event"),
    workspaceEventId: IdSchema,
    eventType: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    payloadHash: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("inbound_email"),
    receiptId: IdSchema,
    occurredAt: z.number().int().nonnegative(),
  }).strict(),
]);

/** Immutable, self-contained execution input frozen when an occurrence commits. */
export const AutomationRunContextV1Schema = z.object({
  schemaVersion: z.literal(1),
  automationId: AutomationIdSchema,
  workspaceId: WorkspaceIdSchema,
  runId: IdSchema,
  authorityGeneration: z.number().int().positive(),
  definitionRevision: z.number().int().positive(),
  definition: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    overview: z.string().min(1),
    instructions: z.string().min(1),
    requiredCapabilities: z.array(z.string()),
    expectedOutputs: z.array(z.string()),
    defaultBehavior: z.record(z.string(), z.unknown()),
    recommendedPlugins: z.array(z.unknown()),
    memoryTables: z.array(z.unknown()),
  }).strict(),
  defaultPluginIds: z.array(z.string().min(1)),
  activitySourcePluginIds: z.record(z.string(), z.string().min(1)),
  connectorBindings: z.record(z.string(), z.unknown()),
  deliveryTargets: z.array(AutomationRunDeliveryTargetV1Schema),
  modelOverride: z.string().min(1).nullable(),
  executionPrincipal: z.object({ type: z.literal("user"), userId: UserIdSchema }).strict(),
  trigger: AutomationRunTriggerV1Schema,
  opening: z.object({
    clientMessageId: IdSchema,
    textContent: z.string().min(1),
    structuredContent: z.record(z.string(), z.unknown()),
    resourceId: IdSchema,
  }).strict().nullable().default(null),
  memoryScope: z.object({
    automationId: AutomationIdSchema,
    authorityGeneration: z.number().int().positive(),
  }).strict(),
}).strict();

export type AutomationLifecycleState = z.infer<typeof AutomationLifecycleStateSchema>;
export type AutomationDraftTurnAdmissionRequest = z.infer<typeof AutomationDraftTurnAdmissionRequestSchema>;
export type AutomationDraftTurnAdmissionResult = z.infer<typeof AutomationDraftTurnAdmissionResultSchema>;
export type AutomationDraftCreationClaimRequest = z.infer<typeof AutomationDraftCreationClaimRequestSchema>;
export type AutomationDraftCreationClaimResult = z.infer<typeof AutomationDraftCreationClaimResultSchema>;
export type AutomationAgentSnapshot = z.infer<typeof AutomationAgentSnapshotSchema>;
export type AutomationSetEvaluatorRulesMutation = z.infer<typeof AutomationSetEvaluatorRulesMutationSchema>;
export type AutomationRunContextV1 = z.infer<typeof AutomationRunContextV1Schema>;
