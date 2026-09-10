import { z } from 'zod';

/**
 * What a result renders without reloading its canonical source: the index
 * serves these beside the text. Absent on a deletion watermark, and absent on
 * a row written before this contract existed, which the read path then omits
 * rather than reloading.
 */
export const SearchDocumentDisplaySchema = z.strictObject({
  title: z.string(),
  sourceLabel: z.string(),
  // Unix milliseconds; null when the source has no display time (a link).
  occurredAt: z.number().int().nonnegative().nullable(),
  transcriptSequence: z.number().int().positive().nullable(),
  url: z.string().nullable(),
  mimeType: z.string().nullable(),
  // Archived conversations stay indexed and are hidden at read time.
  archived: z.boolean(),
});
export type SearchDocumentDisplay = z.infer<typeof SearchDocumentDisplaySchema>;

/** Trusted source adapters return canonical text, never indexing policy. */
export const SearchDocumentSchema = z.strictObject({
  id: z.string(), source: z.string(), sourceId: z.string(), scopeId: z.string(),
  // Conversation documents name their substream so a display change can
  // address one conversation's rows without touching its siblings.
  substreamId: z.string().optional(),
  // Connector resources name their connection: one projected decision per
  // (subject, connection) admits every row the connection synced.
  connectionId: z.string().optional(),
  revision: z.number().int().positive(),
  // Null is a retained deletion watermark; empty text is a live document.
  text: z.string().nullable(),
  display: SearchDocumentDisplaySchema.optional(),
});
export type SearchDocument = z.infer<typeof SearchDocumentSchema>;

export const SearchDocumentBatchSchema = z.strictObject({
  documents: z.array(SearchDocumentSchema),
  // Capture can fail after URL/label extraction. Index available text, then retry.
  retry: z.boolean(),
});
export type SearchDocumentBatch = z.infer<typeof SearchDocumentBatchSchema>;
