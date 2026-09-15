import { HttpsUrlSchema } from "./url-schemas";
import { z } from "zod";

/** Prepared history is content, not a claim that Rally executed a run. */
export const SubstreamContentMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string().refine((text) => text.trim().length > 0, "Message text is empty"),
});
export const SubstreamContentSchema = z.strictObject({
  messages: z.array(SubstreamContentMessageSchema).min(1),
});
export type SubstreamContent = z.infer<typeof SubstreamContentSchema>;

export const SessionSourceSchema = z.strictObject({
  provider: z.enum(["chatgpt", "claude"]),
  url: HttpsUrlSchema.nullable(),
});
export const ImportedMessageProvenanceSchema = z.strictObject({
  kind: z.literal("imported_session"),
  source: SessionSourceSchema,
  importedByUserId: z.string().uuid(),
  importedByName: z.string().min(1),
});
export type ImportedMessageProvenance = z.infer<typeof ImportedMessageProvenanceSchema>;

export const SessionImportPreviewRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("link"), url: HttpsUrlSchema }),
  z.strictObject({ kind: z.literal("export"), provider: z.enum(["chatgpt", "claude"]), text: z.string().min(1) }),
]);
export const SessionImportPreviewSchema = z.strictObject({
  title: z.string().min(1),
  source: SessionSourceSchema,
  content: SubstreamContentSchema,
});
export const SessionImportRequestSchema = SessionImportPreviewSchema.extend({
  clientMessageId: z.string().uuid(),
});
export type SessionImportPreview = z.infer<typeof SessionImportPreviewSchema>;
