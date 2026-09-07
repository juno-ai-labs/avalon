import { z } from 'zod';
import { ResourceSearchProjectionSchema } from '../durable-objects/resource-search-projection';
import { SearchProjectionMessageSchema } from '../durable-objects/search-projection-outbox';
import { SearchDocumentSchema } from './search-document';
import { SEARCH_EMBEDDING_BATCH_SIZE } from './search-embedding';

export const SearchSourceReferenceSchema = z.union([ResourceSearchProjectionSchema, SearchProjectionMessageSchema]);
export type SearchSourceReference = z.infer<typeof SearchSourceReferenceSchema>;

/** Queue messages carry source/range references; text is reloaded from authority. */
export const SearchEmbeddingBatchSchema = z.strictObject({
  type: z.literal('search_embedding_batch_v1'),
  reference: SearchSourceReferenceSchema,
  document: SearchDocumentSchema.omit({ text: true }),
  chunkPolicy: z.string(),
  generation: z.string().regex(/^[a-f0-9]{64}$/u),
  totalChunks: z.number().int().positive(),
  spans: z.array(z.strictObject({
    start: z.number().int().nonnegative(), end: z.number().int().positive(),
    strategies: z.array(z.enum(['recursive', 'sliding_window'])).min(1),
  })).min(1).max(SEARCH_EMBEDDING_BATCH_SIZE),
});
export type SearchEmbeddingBatch = z.infer<typeof SearchEmbeddingBatchSchema>;

/** Cloudflare limits, verified 2026-09-06: decimal KB, including metadata.
 * https://developers.cloudflare.com/queues/platform/limits/ */
const QUEUE_MESSAGE_BYTES = 128_000;
const QUEUE_BATCH_BYTES = 256_000;
const QUEUE_BATCH_MESSAGES = 100;
const QUEUE_METADATA_BYTES = 100;

export async function publishSearchEmbeddingBatches(queue: Queue, jobs: SearchEmbeddingBatch[]): Promise<void> {
  let batch: MessageSendRequest<SearchEmbeddingBatch>[] = [];
  let bytes = 0;
  for (const job of jobs) {
    const message = { body: job, contentType: 'json' as const };
    const size = new TextEncoder().encode(JSON.stringify(message)).byteLength + QUEUE_METADATA_BYTES;
    if (size > QUEUE_MESSAGE_BYTES) throw new Error('search_embedding_reference_too_large');
    if (batch.length && (batch.length === QUEUE_BATCH_MESSAGES || bytes + size > QUEUE_BATCH_BYTES)) {
      await queue.sendBatch(batch);
      batch = []; bytes = 0;
    }
    batch.push(message); bytes += size;
  }
  if (batch.length) await queue.sendBatch(batch);
}
