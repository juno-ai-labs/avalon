import { messageAnnotations } from "./artifact-annotations";
import { HttpsUrlSchema } from "./url-schemas";
import { z } from "zod";

/** Internal authority input. Adapters resolve bytes and bind provenance before materialization. */
export const PreparedConversationSchema = z.strictObject({
  messages: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    attachmentIds: z.array(z.string().uuid()).optional(),
    structuredContent: z.unknown().optional(),
  }).refine((message) => !!message.text.trim() || !!message.attachmentIds?.length || (message.role === "user" && messageAnnotations(message.structuredContent).some((annotation) => annotation.comment.trim())), "Message has no content")).min(1),
});
export type PreparedConversation = z.infer<typeof PreparedConversationSchema>;

/**
 * The provenance an imported session's messages were stored with. Session
 * import retired with Threads, so nothing writes it; the transcript readers
 * still parse it so a stored imported message keeps its attribution.
 */
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
