import { z } from 'zod';

/**
 * Every schema here is a plain `z.object`, which strips keys it does not know,
 * rather than `z.strictObject`. A deploy runs Durable Objects and the stateless
 * Queue consumer on different Worker versions for minutes: a producer on the
 * new build hands a consumer still on the old build a document carrying a field
 * the old contract never named. Rejecting it retried the job into the
 * dead-letter queue on 2026-09-10 (see docs/text-search.md), and the source's
 * publish intent had already been cleared. The old consumer now indexes what it
 * understands; `ignoredSearchDocumentKeys` names what it dropped so the window
 * is visible in Workers Logs, and the next re-projection rewrites the row.
 */

/**
 * What a result renders without reloading its canonical source: the index
 * serves these beside the text. Absent on a deletion watermark, and absent on
 * a row written before this contract existed, which the read path then omits
 * rather than reloading.
 */
export const SearchDocumentDisplaySchema = z.object({
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
export const SearchDocumentSchema = z.object({
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

export const SearchDocumentBatchSchema = z.object({
  documents: z.array(SearchDocumentSchema),
  // Capture can fail after URL/label extraction. Index available text, then retry.
  retry: z.boolean(),
});
export type SearchDocumentBatch = z.infer<typeof SearchDocumentBatchSchema>;

/**
 * The key paths a parse of this batch would strip: what a producer on a newer
 * build sent that this build's contract does not name. Empty on every batch
 * from a producer at or behind this build.
 */
export function ignoredSearchDocumentKeys(input: unknown): string[] {
  const unknownKeys = (value: unknown, shape: Record<string, unknown>, path: string) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).filter((key) => !Object.hasOwn(shape, key)).map((key) => `${path}${key}`)
      : [];
  const keys = unknownKeys(input, SearchDocumentBatchSchema.shape, '');
  const documents = (input as { documents?: unknown } | null)?.documents;
  for (const document of Array.isArray(documents) ? (documents as unknown[]) : []) {
    keys.push(...unknownKeys(document, SearchDocumentSchema.shape, 'documents.'));
    keys.push(...unknownKeys((document as { display?: unknown } | null)?.display, SearchDocumentDisplaySchema.shape, 'documents.display.'));
  }
  return [...new Set(keys)];
}
