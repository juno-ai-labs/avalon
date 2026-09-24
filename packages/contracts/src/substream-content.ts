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
  provider: z.enum(["chatgpt", "claude", "claude_code", "codex"]),
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

export const SessionImportPreviewRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("link"), url: HttpsUrlSchema }),
  z.strictObject({ kind: z.literal("export"), provider: z.enum(["chatgpt", "claude", "claude_code", "codex"]), text: z.string().min(1), sourceUrl: HttpsUrlSchema.optional() }),
]);
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
    provider: z.enum(["chatgpt", "claude", "claude_code", "codex"]),
    sessionId: z.string().min(1),
    url: HttpsUrlSchema.nullable(),
  }).nullable(),
});
export const SessionImportUpdateResponseSchema = z.strictObject({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
});
export type SessionImportPreview = z.infer<typeof SessionImportPreviewSchema>;
