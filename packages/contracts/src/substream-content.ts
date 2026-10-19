import { HttpsUrlSchema } from "./url-schemas";
import { SpaceIdSchema } from "./spaces";
import { z } from "zod";

/** Source bytes and unavailable references are explicit; a URL is never proof of retrieval. */
export const ConversationFileSchema = z.strictObject({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  kind: z.enum(["attachment", "artifact"]),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("inline"), encoding: z.enum(["utf8", "base64"]), data: z.string() }),
    z.strictObject({ kind: z.literal("remote"), url: HttpsUrlSchema }),
    z.strictObject({ kind: z.literal("unavailable"), reference: z.string(), reason: z.string() }),
  ]),
});
export type ConversationFile = z.infer<typeof ConversationFileSchema>;

/** Prepared history is content, not a claim that Rally executed a run. */
export const SubstreamContentMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  files: z.array(ConversationFileSchema).optional(),
  sourceMessageId: z.string().min(1).optional(),
}).refine((message) => message.text.trim().length > 0 || !!message.files?.length, "Message has no content");
export const SubstreamContentSchema = z.strictObject({
  messages: z.array(SubstreamContentMessageSchema).min(1),
});
export type SubstreamContent = z.infer<typeof SubstreamContentSchema>;

/** Internal authority input. Adapters resolve bytes and bind provenance before materialization. */
export const PreparedConversationSchema = z.strictObject({
  messages: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    attachmentIds: z.array(z.string().uuid()).optional(),
    structuredContent: z.unknown().optional(),
  }).refine((message) => !!message.text.trim() || !!message.attachmentIds?.length, "Message has no content")).min(1),
});
export type PreparedConversation = z.infer<typeof PreparedConversationSchema>;
export const ConversationInitializationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("prompt") }),
  z.strictObject({ kind: z.literal("history"), conversation: PreparedConversationSchema, identityHash: z.string().optional() }),
]);
export type ConversationInitialization = z.infer<typeof ConversationInitializationSchema>;

export const SessionSourceSchema = z.strictObject({
  // `claude_code` names Channels imported from local Claude Code files before
  // importing moved to Rally's browser; it is kept so their provenance reads.
  provider: z.enum(["chatgpt", "claude", "claude_code"]),
  url: HttpsUrlSchema.nullable(),
  sessionId: z.string().min(1).optional(),
});
export const ImportedMessageProvenanceSchema = z.strictObject({
  kind: z.literal("imported_session"),
  source: SessionSourceSchema,
  importedByUserId: z.string().uuid(),
  importedByName: z.string().min(1),
  sourceMessageId: z.string().min(1).optional(),
  sourceRevision: z.string().min(1).optional(),
  supersedesTurnId: z.string().uuid().optional(),
});
export type ImportedMessageProvenance = z.infer<typeof ImportedMessageProvenanceSchema>;

export const SessionImportPreviewSchema = z.strictObject({
  title: z.string().min(1),
  source: SessionSourceSchema,
  content: SubstreamContentSchema,
});
export const SessionImportRequestSchema = SessionImportPreviewSchema.extend({
  title: z.string().min(1).max(180),
  clientMessageId: z.string().uuid(),
  spaceIds: z.array(SpaceIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Space ids must be unique")
    .default([]),
});
export const SessionImportUpdateRequestSchema = SessionImportPreviewSchema.extend({
  clientMessageId: z.string().uuid(),
});
export const SessionImportSourceResponseSchema = z.strictObject({
  source: z.strictObject({
    provider: z.enum(["chatgpt", "claude", "claude_code"]),
    sessionId: z.string().min(1),
    url: HttpsUrlSchema.nullable(),
  }).nullable(),
});
export const SessionImportUpdateResponseSchema = z.strictObject({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
});
export type SessionImportPreview = z.infer<typeof SessionImportPreviewSchema>;
export type SessionImportRequest = z.infer<typeof SessionImportRequestSchema>;

/**
 * Start a conversation import: reserve its Channel and start the agent that
 * reads the conversation in the person's Rally browser.
 */
export const SessionImportStartRequestSchema = z.strictObject({
  sourceUrl: HttpsUrlSchema,
  title: z.string().trim().min(1).max(180),
  clientMessageId: z.string().uuid(),
  spaceIds: z.array(SpaceIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Space ids must be unique")
    .default([]),
});
/** The Channel an import fills and the hidden conversation its agent runs in. */
export const SessionImportRunSchema = z.strictObject({
  workstreamId: z.string().min(1),
  substreamId: z.string().min(1),
});
export const SessionImportDiscardRequestSchema = z.strictObject({
  /** The hidden child an import runs in; never the main conversation of a Channel. */
  substreamId: z.string().min(1).refine((id) => id !== "0", "An import never runs in the main conversation"),
  /** The create key of a new import; null for an update, whose Channel stays. */
  clientMessageId: z.string().uuid().nullable(),
  /** The create key names a Breakout reservation in this thread rather than a new thread. */
  breakout: z.boolean().optional(),
});
/**
 * Take back a new import by its create key alone, for a start whose answer
 * (the ids `discard` needs) never came back.
 */
export const SessionImportAbandonRequestSchema = z.strictObject({
  clientMessageId: z.string().uuid(),
});

/**
 * Start importing a conversation as a Breakout of an existing thread. The
 * create key is also the Breakout's preparation id, so a retried start
 * reserves the same Breakout and finds the agent it already launched.
 */
export const SessionImportBreakoutStartRequestSchema = z.strictObject({
  sourceUrl: HttpsUrlSchema,
  title: z.string().trim().min(1).max(180),
  clientMessageId: z.string().uuid(),
});
/**
 * Open the reserved Breakout with what the agent read. The Breakout keeps the
 * title it was reserved under at start; `title` here is the preview's and does
 * not rename it.
 */
export const SessionImportBreakoutRequestSchema = SessionImportPreviewSchema.extend({
  title: z.string().min(1).max(180),
  clientMessageId: z.string().uuid(),
});
export type SessionImportBreakoutRequest = z.infer<typeof SessionImportBreakoutRequestSchema>;
