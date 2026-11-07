import {
  AutomationActivationV1Schema,
  IdSchema,
  MESSAGE_MAX_CHARACTERS,
  SubstreamIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@rally/contracts";
import { z } from "zod";

/**
 * What the conversation tools ask WorkspaceDO.
 *
 * The scope is host-derived from the loop input and travels here as data; the
 * model never supplies it. Every answer is a discriminated outcome with a
 * stable code, which the tool turns into its model-visible sentence.
 */

export const ConversationToolScopeSchema = z.strictObject({
  kind: z.literal("sidekick"),
  automationId: IdSchema,
  /** Asked from the Sidekick's configuration conversation, where its own conversation is `isOwn`; a run's is `isParent`. */
  authoring: z.boolean().optional(),
});
/**
 * Whose conversations a tool call reaches: a Sidekick's own, the Canvases it
 * writes, and the Canvases attached to it.
 */
export type ConversationToolScope = z.input<typeof ConversationToolScopeSchema>;

/**
 * A `conversation_post`, as the addressed conversation's AgentLoopDO takes
 * it (`appendConversationPost`): the conversation it is for, the host-derived
 * key it lands once under, and the Sidekick's post.
 */
export const ConversationPostRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  /** Whose conversation `workstreamId` names: a Sidekick's own shared conversation, or a Canvas's Chat. */
  parentKind: z.enum(["automation", "canvas"]),
  workstreamId: z.string().min(1),
  substreamId: z.union([z.literal("0"), z.string().min(1)]),
  clientMessageId: z.string().min(1).max(300),
  text: z.string().min(1).max(MESSAGE_MAX_CHARACTERS),
  post: AutomationActivationV1Schema,
});
export type ConversationPostRequest = z.input<typeof ConversationPostRequestSchema>;

const Addressed = {
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
} as const;

export const ConversationToolScopeRequestSchema = z.strictObject({
  ...Addressed,
  scope: ConversationToolScopeSchema,
});
export type ConversationToolScopeRequest = z.input<typeof ConversationToolScopeRequestSchema>;

/**
 * One conversation a tool can reach, read from its own conversation object.
 * `kind` is the host's to route on, never the model's to see: a Sidekick's
 * own shared conversation (`sidekick`, `parentId` the Sidekick's id) or a
 * Canvas's Chat (`canvas`, `parentId` the Canvas's id), both substream "0".
 * `isParent` marks the conversation a run sits inside: its Sidekick's.
 */
export const ConversationToolEntrySchema = z.strictObject({
  conversationId: z.string().min(1),
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  kind: z.enum(["canvas", "sidekick"]),
  title: z.string(),
  isOwn: z.boolean(),
  isParent: z.boolean(),
});
export type ConversationToolEntry = z.infer<typeof ConversationToolEntrySchema>;

export interface ConversationToolScopeResult {
  conversations: ConversationToolEntry[];
}

export const ConversationToolResolveRequestSchema = z.strictObject({
  ...Addressed,
  scope: ConversationToolScopeSchema,
  /** A conversationId or an exact title. */
  reference: z.string().min(1),
});
export type ConversationToolResolveRequest = z.input<typeof ConversationToolResolveRequestSchema>;

export const CONVERSATION_TOOL_REFUSAL_CODES = [
  "conversation_not_in_scope",
  "conversation_ambiguous",
  "conversation_not_found",
  "conversation_archived",
  "conversation_access_denied",
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
