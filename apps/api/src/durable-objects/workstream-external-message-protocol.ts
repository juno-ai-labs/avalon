import {
  AutomationActivationV1Schema,
  AgentExchangeSchema,
  AgentIdSchema,
  ExecutionPrincipalSchema,
  ExternalActorSchema,
  IdSchema,
  MESSAGE_MAX_CHARACTERS,
  SidekickReviewNoticeV1Schema,
  SlackOriginContextSchema,
  SlackSearchAuthorizationSchema,
  WorkstreamMessageAdmissionReceiptSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { z } from "zod";

const ExternalMessageBaseSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  /**
   * Which of the parent's conversations receives the message: the main one
   * when absent. A reply routed through an external conversation binding to a
   * Sidekick run names the run child (the run id) under the Sidekick parent.
   */
  substreamId: z.union([z.literal("0"), IdSchema]).optional(),
  messageId: IdSchema,
  clientMessageId: z.string().min(1).max(120),
  actor: ExternalActorSchema,
  text: z.string().max(MESSAGE_MAX_CHARACTERS),
  structuredContentJson: z.string().max(MESSAGE_MAX_CHARACTERS).nullable(),
  executionPrincipal: ExecutionPrincipalSchema,
  origin: z.string().min(1).max(80),
  parentHarnessRunId: z.string().min(1).max(180).optional(),
  slackOrigin: SlackOriginContextSchema.optional(),
  slackSearchAuthorization: SlackSearchAuthorizationSchema.optional(),
  runMode: z.enum(["steer", "queue"]).default("steer"),
  now: z.number().int().nonnegative(),
});

/** An external participant message that must reach the persistent Bind loop. */
export const AdmitExternalMessageInputSchema = ExternalMessageBaseSchema.extend({
  messageType: z.literal("text"),
}).strict();

/**
 * One Slack elicitation answer. The object decides atomically whether this is
 * the final open answer (pending loop input) or a non-invoking canonical turn.
 */
export const AnswerExternalElicitationInputSchema = ExternalMessageBaseSchema.extend({
  messageType: z.literal("elicitation"),
  // Provider-backed scheduling rows predate UUID-only public identifiers. The
  // object still treats this as an opaque local key and fences the update on
  // the matching pending row, so narrowing it here would reject valid legacy
  // and connector-issued questions without buying identity safety.
  elicitationId: z.string().min(1).max(180),
  answerJson: z.string(),
}).strict();

/**
 * One automation activation, on its way to becoming a loop input.
 *
 * Not an extension of {@link ExternalMessageBaseSchema}, and the difference is
 * the point: an external message carries a provider account that a person is
 * behind, and an activation carries nobody. Everything that base schema
 * requires about that actor — the provider, the account, the Slack origin it
 * came from — is absent here rather than filled with a placeholder that later
 * readers would have to recognize as one.
 *
 * Nothing admits a new one: `post_result`, its only caller, is gone. The schema
 * stays so preparation recovery can still replay an activation stored before
 * that deploy; it can go once none can remain in any mailbox.
 */
export const AdmitAutomationActivationInputSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  messageId: IdSchema,
  clientMessageId: z.string().min(1).max(120),
  /** What the room reads: the automation's result, rendered for people. */
  text: z.string().min(1).max(MESSAGE_MAX_CHARACTERS),
  activation: AutomationActivationV1Schema,
  /** Whose authority the woken run carries. The automation's, not a reader's. */
  executionPrincipal: ExecutionPrincipalSchema,
  origin: z.string().min(1).max(80),
  now: z.number().int().nonnegative(),
});

export const ExternalMessageAdmissionResultSchema = WorkstreamMessageAdmissionReceiptSchema;

/** A teammate message is system-attributed input, never a fabricated participant. */
export const AdmitAgentMessageInputSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  messageId: IdSchema,
  clientMessageId: z.string().min(1).max(120),
  text: z.string().max(MESSAGE_MAX_CHARACTERS),
  agentExchange: AgentExchangeSchema,
  recipientAgentId: AgentIdSchema,
  /** Host settlement notices do not resume a stopped recipient. */
  resumeStopped: z.boolean().optional(),
  attachmentIds: z.array(IdSchema).max(10).default([]),
  executionPrincipal: ExecutionPrincipalSchema,
  origin: z.literal("agent_message"),
  now: z.number().int().nonnegative(),
}).refine((input) => input.agentExchange.messageId === input.messageId, "Agent exchange and input message IDs must match.");
/**
 * The host's own notice to a Sidekick's wizard that a scheduled self-review is
 * due. Like an agent message it is system-attributed input with no person
 * behind it, and it carries the review's counts as structured content so a
 * later reader can tell the host's notice from a teammate's words; unlike one
 * it names no sender and joins no team, so it is queued behind in-flight work
 * rather than steered into it. See `HostedSidekick.startReview`.
 */
export const AdmitSidekickReviewInputSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  messageId: IdSchema,
  clientMessageId: z.string().min(1).max(120),
  text: z.string().min(1).max(MESSAGE_MAX_CHARACTERS),
  review: SidekickReviewNoticeV1Schema,
  /** Whose authority the woken wizard carries: an eligible delegate's. */
  executionPrincipal: ExecutionPrincipalSchema,
  origin: z.literal("sidekick_review"),
  now: z.number().int().nonnegative(),
});
export type AdmitSidekickReviewInput = z.infer<typeof AdmitSidekickReviewInputSchema>;

export const AdmitSystemActivationInputSchema = z.union([
  AdmitAutomationActivationInputSchema, AdmitAgentMessageInputSchema, AdmitSidekickReviewInputSchema,
]);
export type AdmitAgentMessageInput = z.infer<typeof AdmitAgentMessageInputSchema>;
export type AdmitSystemActivationInput = z.infer<typeof AdmitSystemActivationInputSchema>;

export type AdmitExternalMessageInput = z.infer<typeof AdmitExternalMessageInputSchema>;
export type AnswerExternalElicitationInput = z.infer<typeof AnswerExternalElicitationInputSchema>;
export type ExternalMessageAdmissionResult = z.infer<typeof ExternalMessageAdmissionResultSchema>;
