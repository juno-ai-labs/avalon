import { z } from 'zod';
import { IdSchema, WorkspaceIdSchema } from '@rally/contracts';
import { RegionSchema } from '@rally/contracts/regions';
import { ResourceSearchProjectionSchema } from '../durable-objects/resource-search-projection';
import { SearchProjectionMessageSchema } from '../durable-objects/search-projection-outbox';
import { SearchDocumentSchema } from './search-document';
import { SEARCH_EMBEDDING_BATCH_SIZE } from './search-embedding';

/**
 * A Channel message's search job. Channel messages are retired with Channels
 * (plan step C-2) and nothing publishes one; a job published before that still
 * parses so it is answered with no documents rather than retried.
 */
export const ChannelMessageSearchProjectionSchema = z.strictObject({
  type: z.literal('channel_message_search_projection_v1'),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  messageId: IdSchema,
});

export const SearchSourceReferenceSchema = z.union([
  ResourceSearchProjectionSchema, SearchProjectionMessageSchema, ChannelMessageSearchProjectionSchema,
]);
export type SearchSourceReference = z.infer<typeof SearchSourceReferenceSchema>;

/** One document per planning delivery, even when a turn contains many pages. */
export const SearchDocumentJobSchema = z.strictObject({
  // Old consumers recognize this envelope and retry its unknown strict shape,
  // rather than acknowledging an unknown type during a rolling deployment.
  type: z.literal('search_embedding_batch_v1'),
  phase: z.literal('document'),
  reference: SearchSourceReferenceSchema,
  documentId: z.string().min(1),
});
export type SearchDocumentJob = z.infer<typeof SearchDocumentJobSchema>;

/** Queue messages carry source/range references; text is reloaded from authority. */
export const SearchEmbeddingBatchSchema = z.strictObject({
  type: z.literal('search_embedding_batch_v1'),
  reference: SearchSourceReferenceSchema,
  document: SearchDocumentSchema.omit({ text: true }),
  chunkPolicy: z.string(),
  generation: z.string().regex(/^[a-f0-9]{64}$/u),
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

export async function publishSearchIndexingJobs(queue: Queue, jobs: Array<SearchEmbeddingBatch | SearchDocumentJob>): Promise<void> {
  let batch: MessageSendRequest<SearchEmbeddingBatch | SearchDocumentJob>[] = [];
  let bytes = 0;
  for (const job of jobs) {
    const message = { body: job, contentType: 'json' as const };
    const size = new TextEncoder().encode(JSON.stringify(message)).byteLength + QUEUE_METADATA_BYTES;
    if (size > QUEUE_MESSAGE_BYTES) throw new Error('search_indexing_job_too_large');
    if (batch.length && (batch.length === QUEUE_BATCH_MESSAGES || bytes + size > QUEUE_BATCH_BYTES)) {
      await queue.sendBatch(batch);
      batch = []; bytes = 0;
    }
    batch.push(message); bytes += size;
  }
  if (batch.length) await queue.sendBatch(batch);
}
