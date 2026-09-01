import {
  ExecutionPrincipalSchema,
  ExternalActorSchema,
  IdSchema,
  MESSAGE_MAX_CHARACTERS,
  SlackOriginContextSchema,
  SlackSearchAuthorizationSchema,
  WorkstreamMessageAdmissionReceiptSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { z } from "zod/v3";

const ExternalMessageBaseSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
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
  now: z.number().int().safe().nonnegative(),
}).strict();

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

export const ExternalMessageAdmissionResultSchema = WorkstreamMessageAdmissionReceiptSchema;

export type AdmitExternalMessageInput = z.infer<typeof AdmitExternalMessageInputSchema>;
export type AnswerExternalElicitationInput = z.infer<typeof AnswerExternalElicitationInputSchema>;
export type ExternalMessageAdmissionResult = z.infer<typeof ExternalMessageAdmissionResultSchema>;
