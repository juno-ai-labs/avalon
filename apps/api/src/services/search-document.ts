import { z } from 'zod';

/** Trusted source adapters return canonical text, never indexing policy. */
export const SearchDocumentSchema = z.strictObject({
  id: z.string(), source: z.string(), sourceId: z.string(), scopeId: z.string(),
  revision: z.number().int().positive(),
  // Null is a retained deletion watermark; empty text is a live document.
  text: z.string().nullable(),
});
export type SearchDocument = z.infer<typeof SearchDocumentSchema>;

export const SearchDocumentBatchSchema = z.strictObject({
  documents: z.array(SearchDocumentSchema),
  // Capture can fail after URL/label extraction. Index available text, then retry.
  retry: z.boolean(),
});
export type SearchDocumentBatch = z.infer<typeof SearchDocumentBatchSchema>;
