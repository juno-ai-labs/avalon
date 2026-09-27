import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * What the conversation tools ask WorkspaceDO.
 *
 * The scope is host-derived from the loop input and travels here as data; the
 * model never supplies it. Every answer is a discriminated outcome with a
 * stable code, which the tool turns into its model-visible sentence.
 */

export const ConversationToolScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sidekick"), automationId: IdSchema }),
  z.strictObject({ kind: z.literal("conversation"), parentId: IdSchema, substreamId: SubstreamIdSchema }),
]);

const Addressed = {
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
} as const;

export const ConversationToolScopeRequestSchema = z.strictObject({
  ...Addressed,
  scope: ConversationToolScopeSchema,
});
export type ConversationToolScopeRequest = z.input<typeof ConversationToolScopeRequestSchema>;

export const ConversationToolEntrySchema = z.strictObject({
  conversationId: z.string().min(1),
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  kind: z.enum(["channel", "breakout"]),
  title: z.string(),
  isHome: z.boolean(),
  isOwn: z.boolean(),
});
export type ConversationToolEntry = z.infer<typeof ConversationToolEntrySchema>;

export interface ConversationToolScopeResult {
  conversations: ConversationToolEntry[];
}

export const ConversationToolResolveRequestSchema = z.strictObject({
  ...Addressed,
  scope: ConversationToolScopeSchema,
  /** A conversationId or an exact title; null means the Sidekick's home. */
  reference: z.string().min(1).nullable(),
});
export type ConversationToolResolveRequest = z.input<typeof ConversationToolResolveRequestSchema>;

export const CONVERSATION_TOOL_REFUSAL_CODES = [
  "conversation_not_in_scope",
  "conversation_ambiguous",
  "conversation_not_found",
  "conversation_archived",
  "conversation_access_denied",
  "conversation_home_missing",
] as const;
export type ConversationToolRefusalCode = typeof CONVERSATION_TOOL_REFUSAL_CODES[number];

export interface ConversationToolRefusal {
  ok: false;
  code: ConversationToolRefusalCode;
  /** Conversation ids the model may use instead, where there are any. */
  available: string[];
  /** The refused conversation's own id (its Channel's, or its Breakout's), where one was resolved. */
  resourceId: string | null;
}

export type ConversationToolResolveResult =
  | {
    ok: true;
    conversation: ConversationToolEntry;
    /** For a Sidekick scope, the name a post from it wears; null for a Channel or Breakout loop. */
    sidekickName: string | null;
  }
  | ConversationToolRefusal;

export const ConversationToolAttachRequestSchema = z.strictObject({
  ...Addressed,
  automationId: IdSchema,
  /** A conversationId (the Worker has already turned a link into one) or an exact title. */
  reference: z.string().min(1),
});
export type ConversationToolAttachRequest = z.input<typeof ConversationToolAttachRequestSchema>;

export type ConversationToolAttachResult =
  | { ok: true; conversation: ConversationToolEntry; alreadyAttached: boolean }
  | ConversationToolRefusal;
