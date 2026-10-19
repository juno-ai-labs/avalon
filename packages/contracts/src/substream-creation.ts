import { AnnotatedMessageContentSchema } from "./artifact-annotations";
import { z } from "zod";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";
import { SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema, WorkstreamIdSchema } from "./identifiers";
import { TranscriptAttachmentSchema, TranscriptMentionSchema, TranscriptTurnIdSchema } from "./workstream-transcript";

const ContextConfigScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
/**
 * Recipes are deliberately flat. This finite JSON shape stays serializable
 * across native RPC without exporting Zod's recursive `z.json()` type through
 * every parent operation.
 */
export const ContextConfigSchema = z.record(
  z.string(),
  z.union([ContextConfigScalarSchema, z.array(ContextConfigScalarSchema)]),
);

/** One address everywhere: drafts, preparation receipts, seeds, sockets and inference. */
export const SubstreamAddressSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
});
export type SubstreamAddress = z.infer<typeof SubstreamAddressSchema>;

export const ContextPluginRefSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
});
export type ContextPluginRef = z.infer<typeof ContextPluginRefSchema>;

/** Exported participant content only. No execution receipts, private reasoning or live actions. */
export const SubstreamContextMessageSchema = z.strictObject({
  turnId: TranscriptTurnIdSchema,
  transcriptSequence: z.number().int().positive(),
  actor: z.enum(["human", "assistant", "external", "sidekick"]),
  authorUserId: UserIdSchema.nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  blocks: z.array(z.strictObject({
    text: z.string(),
    structuredContent:AnnotatedMessageContentSchema.optional(),
    mentions: z.array(TranscriptMentionSchema),
    attachments: z.array(TranscriptAttachmentSchema),
  })).min(1),
}).superRefine((message, context) => {
  const validHuman = message.actor === "human"
    && message.authorUserId !== null && message.authorLabel !== null;
  const validNonHuman = message.actor !== "human"
    && message.authorUserId === null && message.authorLabel !== null;
  if (!validHuman && !validNonHuman) {
    context.addIssue({ code: "custom", message: "context_message_author_invalid" });
  }
});
export type SubstreamContextMessage = z.infer<typeof SubstreamContextMessageSchema>;

export const SubstreamContextCaptureSchema = z.strictObject({
  source: SubstreamAddressSchema,
  throughTurnId: TranscriptTurnIdSchema.nullable(),
  throughSequence: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative(),
  messages: z.array(SubstreamContextMessageSchema),
});
export type SubstreamContextCapture = z.infer<typeof SubstreamContextCaptureSchema>;

export const ContextRecipePartSchema = z.strictObject({
  id: z.string().min(1),
  selector: ContextPluginRefSchema,
  selectorConfig: ContextConfigSchema,
  transform: ContextPluginRefSchema,
  transformConfig: ContextConfigSchema,
});
export type ContextRecipePart = z.infer<typeof ContextRecipePartSchema>;

export const SubstreamContextPolicySchema = z.strictObject({
  revision: z.string().min(1),
  strategy: ContextPluginRefSchema,
  config: ContextConfigSchema,
});
export type SubstreamContextPolicy = z.infer<typeof SubstreamContextPolicySchema>;

export const SubstreamContextRecipeSchema = z.strictObject({
  policy: SubstreamContextPolicySchema,
  capture: z.enum(["none", "source"]),
  parts: z.array(ContextRecipePartSchema),
});
export type SubstreamContextRecipe = z.infer<typeof SubstreamContextRecipeSchema>;

export const SubstreamHistoryContextPartSchema = z.strictObject({
  kind: z.literal("history"),
  messages: z.array(SubstreamContextMessageSchema),
});
export const SubstreamSummaryContextPartSchema = z.strictObject({
  kind: z.literal("summary"),
  text: z.string().trim().min(1),
  requestedModel: z.string().min(1),
  resolvedModel: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export const SubstreamContextPartSchema = z.discriminatedUnion("kind", [
  SubstreamHistoryContextPartSchema,
  SubstreamSummaryContextPartSchema,
]);
export type SubstreamContextPart = z.infer<typeof SubstreamContextPartSchema>;

export const ResolvedContextPartSchema = z.strictObject({
  recipe: ContextRecipePartSchema,
  sourceTurnIds: z.array(TranscriptTurnIdSchema),
  selectionHash: z.string().regex(/^[0-9a-f]{64}$/u),
  content: SubstreamContextPartSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type ResolvedContextPart = z.infer<typeof ResolvedContextPartSchema>;

export const PreparedSubstreamContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recipe: SubstreamContextRecipeSchema,
  recipeHash: z.string().regex(/^[0-9a-f]{64}$/u),
  capture: SubstreamContextCaptureSchema.nullable(),
  captureHash: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  parts: z.array(ResolvedContextPartSchema),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type PreparedSubstreamContext = z.infer<typeof PreparedSubstreamContextSchema>;

/** Only the selected seed crosses to the child, never the discarded source capture. */
export const SubstreamInitialContextSchema = z.strictObject({
  source: SubstreamAddressSchema,
  throughTurnId: TranscriptTurnIdSchema.nullable(),
  policyRevision: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  parts: z.array(SubstreamContextPartSchema),
});
export type SubstreamInitialContext = z.infer<typeof SubstreamInitialContextSchema>;

export const SubstreamPreparationPreviewSchema = z.strictObject({
  operationId: z.string().min(1),
  substreamId: SubstreamIdSchema,
  title: z.string().min(1),
  context: SubstreamInitialContextSchema,
});
export type SubstreamPreparationPreview = z.infer<typeof SubstreamPreparationPreviewSchema>;

/**
 * The first instruction a substream is created with.
 *
 * Creation and the opening turn are one request because they are one act: the
 * person pressed enter on a composer, exactly as they do to start a work
 * stream, and a child that exists without the message that caused it is a
 * state nobody asked for and every caller would have to clean up. It is
 * optional because the API can still create an idle child — the desktop no
 * longer does.
 */
export const SubstreamOpeningMessageSchema = z.strictObject({
  /** The sender's identity for this turn, and what makes a retried confirm replay rather than repeat. */
  clientMessageId: z.string().min(1).max(120),
  // Both of these come from leaf modules rather than from `index`: this module
  // is imported by the parent-object contract, which `index` imports in turn,
  // so reaching back through it would close a cycle and leave whichever schema
  // was evaluated first undefined. The transcript's mention shape is the same
  // five fields the wire carries anyway.
  text: z.string().max(MESSAGE_MAX_CHARACTERS),
  mentions: z.array(TranscriptMentionSchema).default([]),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  /**
   * People the composer's mention confirmation named. They are added to the
   * child's parent-owned membership before the turn is written, because a
   * mention that reached the text with nobody attached to it names somebody
   * who cannot read it.
   */
  confirmedParticipantUserIds: z.array(UserIdSchema).default([]),
}).refine((value) => value.text.trim().length > 0 || value.attachmentIds.length > 0, {
  message: "An opening message must include text or an attachment",
});
export type SubstreamOpeningMessage = z.infer<typeof SubstreamOpeningMessageSchema>;

/**
 * What confirmation answers with.
 *
 * The turn identity is the canonical one, so the optimistic turn the launch
 * surface is already showing is replaced by identity when the child's socket
 * delivers it rather than by two rows having equal text.
 */
export const SubstreamCreationResultSchema = z.strictObject({
  substreamId: SubstreamIdSchema,
  /**
   * The title the child was created under. Provisional where the naming pass
   * is still running against the opening message, and the reason the caller
   * does not have to derive one of its own: two answers to what a first line
   * is would disagree the moment either changed.
   */
  title: z.string().min(1).max(500),
  opening: z.strictObject({
    turnId: TranscriptTurnIdSchema,
    clientMessageId: z.string().min(1).max(120),
    createdAt: z.string().datetime({ offset: true }),
  }).nullable(),
});
export type SubstreamCreationResult = z.infer<typeof SubstreamCreationResultSchema>;
