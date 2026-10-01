import { HttpsUrlSchema } from "./url-schemas";
import { SpaceIdSchema } from "./spaces";
import { WorkstreamIdSchema } from "./identifiers";
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

/** A conversation Rally's browser read from the provider's page, signed in or shared. */
export const SessionImportPreviewRequestSchema = z.strictObject({
  kind: z.literal("export"), provider: z.enum(["chatgpt", "claude"]), text: z.string().min(1), sourceUrl: HttpsUrlSchema,
});
export const SessionImportPreviewSchema = z.strictObject({
  title: z.string().min(1),
  source: SessionSourceSchema,
  content: SubstreamContentSchema,
});
export const SessionImportRequestSchema = SessionImportPreviewSchema.extend({
  title: z.string().min(1).max(180),
  clientMessageId: z.string().uuid(),
  /**
   * The id the caller already listed this Channel under, as `POST /workstreams`
   * takes it. Creation semantics, like `spaceIds`: not part of the imported
   * content's identity.
   */
  workstreamId: WorkstreamIdSchema.optional(),
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
  substreamId: z.string().min(1),
  /** The create key of a new import; null for an update, whose Channel stays. */
  clientMessageId: z.string().uuid().nullable(),
});
