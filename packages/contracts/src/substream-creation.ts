import { z } from "zod";
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
  actor: z.enum(["human", "assistant", "external"]),
  authorUserId: UserIdSchema.nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  blocks: z.array(z.strictObject({
    text: z.string(),
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
