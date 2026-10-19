import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { logWarn } from '../observability/logger';
import { ignoredSearchDocumentKeys, SearchDocumentBatchSchema, type SearchDocument, type SearchDocumentBatch } from './search-document';
import { searchChunkPolicy, SEARCH_EMBEDDING_BATCH_SIZE } from './search-embedding';
import { semanticChunks, type SemanticChunkPolicy } from './semantic-chunks';
import { isMemoryEmbeddingModel } from './structured-inference';
import { publishSearchIndexingJobs, type SearchEmbeddingBatch, type SearchSourceReference } from './search-indexing-jobs';
import { SEARCH_EMBEDDING_DIMENSIONS, searchContentHash, searchChunkIdentity, workspaceSearchIndex, type TextSearchDocument, type TextSearchIndex } from './text-search';

/** One canonical chunk plan; batch jobs contain offsets, not source text. */
export async function searchEmbeddingJobs(reference: SearchSourceReference,
  document: SearchDocument & { text: string }, policy: SemanticChunkPolicy): Promise<SearchEmbeddingBatch[]> {
  // Queue ranges reconstruct canonical text only. Adding a prefix requires
  // extending the job and namespace contracts together, never silently dropping it.
  if (policy.prefix) throw new Error('search_embedding_prefix_unsupported');
  const chunks = await semanticChunks(document.text, policy);
  const generation = await searchContentHash(document.text);
  const identity = { id: document.id, source: document.source, sourceId: document.sourceId,
    scopeId: document.scopeId, revision: document.revision };
  const jobs: SearchEmbeddingBatch[] = [];
  for (let start = 0; start < chunks.length; start += SEARCH_EMBEDDING_BATCH_SIZE) {
    jobs.push({ type: 'search_embedding_batch_v1', reference, document: identity, generation, chunkPolicy: searchChunkIdentity(),
      spans: chunks.slice(start, start + SEARCH_EMBEDDING_BATCH_SIZE)
        .map(({ start, end, strategies }) => ({ start, end, strategies })) });
  }
  return jobs;
}

/**
 * Each delivery validates and publishes only its batch. Source jobs reclaim old revisions.
 *
 * `revision`, when a source has one, is its watermark read: equal to the job's
 * revision means the text loaded before embedding is still current, because
 * every input of that text bumps it. A source without one is re-read in full.
 */
export async function indexSemanticBatch(index: TextSearchIndex, job: SearchEmbeddingBatch,
  load: () => Promise<SearchDocumentBatch>,
  embed: (texts: string[]) => Promise<{ model: string; vectors: number[][] }>,
  revision?: () => Promise<number | null>,
): Promise<'indexed' | 'stale'> {
  const currentDocument = async () => {
    const current = SearchDocumentBatchSchema.parse(await load()).documents.find((document) => document.id === job.document.id);
    if (!current || current.text === null || current.revision !== job.document.revision
      || current.source !== job.document.source || current.sourceId !== job.document.sourceId
      || current.scopeId !== job.document.scopeId || await searchContentHash(current.text) !== job.generation) return null;
    return { ...current, text: current.text };
  };
  const fresh = async () => revision ? await revision() === job.document.revision : await currentDocument() !== null;
  const reclaim = async (): Promise<'stale'> => {
    await index.removeSemanticGeneration(job.document, job.generation);
    return 'stale';
  };
  // Persisted deterministic rows are the receipt, and they are read before the
  // source: a same-revision re-projection finds nearly every batch already
  // written, and a delivery that will write nothing need not load anything.
  // It still runs the post-write check, `fresh`: a delivery cancelled between
  // its upsert and that check leaves rows no one validated, and a later
  // revision's source job may already have reclaimed that generation, so
  // acknowledging here unchecked would resurrect them.
  if (await index.countSemanticChunks(job.document, job.generation, job.spans) === job.spans.length) {
    return await fresh() ? 'indexed' : reclaim();
  }
  const document = await currentDocument();
  if (!document) return reclaim();
  const chunks = job.spans.map((span) => {
    if (span.end <= span.start || span.end > document.text.length) throw new Error('invalid_search_chunk_range');
    return { ...span, text: document.text.slice(span.start, span.end) };
  });
  const ids = await Promise.all(chunks.map((chunk) => sha256Hex(JSON.stringify([
    'semantic-queue-chunks-v1', document.source, document.scopeId, document.sourceId,
    document.revision, job.generation, chunk.start, chunk.end, chunk.text,
  ]))));
  const embedding = await embed(chunks.map((chunk) => chunk.text));
  if (!isMemoryEmbeddingModel(embedding.model) || embedding.vectors.length !== chunks.length
    || !embedding.vectors.every((vector) => vector.length === SEARCH_EMBEDDING_DIMENSIONS
      && vector.every(Number.isFinite))) throw new Error('search_embedding_space_mismatch');
  const rows: TextSearchDocument[] = chunks.map((chunk, offset) => ({ ...document, id: ids[offset]!,
    text: chunk.text, vector: embedding.vectors[offset]!, generation: job.generation,
    chunk: { start: chunk.start, end: chunk.end, strategies: chunk.strategies } }));
  await index.upsert(rows);
  return await fresh() ? 'indexed' : reclaim();
}

/** Source state stays batch-local; the immutable tokenizer is shared by the isolate. */
export function createSearchIndexingPipeline(env: Env) {
  return async (reference: SearchSourceReference, load: (captureLinks?: boolean) => Promise<SearchDocumentBatch>): Promise<void> => {
    // A producer on a newer build may name fields this build does not. They
    // are indexed without them (the schema strips, never rejects) and named
    // here with the source, so a deploy can list from the logs which rows the
    // skew window wrote behind the contract and re-project exactly those.
    const raw = await load();
    const ignored = ignoredSearchDocumentKeys(raw);
    if (ignored.length) logWarn(env, 'search_document_keys_ignored', { workspace_id: reference.workspaceId,
      ...(reference.type === 'resource_search_projection_v1' ? { resource_id: reference.resourceId }
        : reference.type === 'channel_message_search_projection_v1' ? { channel_message_id: reference.messageId }
        : { parent_id: reference.parentId, substream_id: reference.substreamId, turn_id: reference.turnId }),
      ignored_keys: ignored.join(',') });
    const input = SearchDocumentBatchSchema.parse(raw);
    if (!input.documents.length) {
      if (input.retry) throw new Error('search_source_retry_required');
      return;
    }
    const index = await workspaceSearchIndex(env, reference.workspaceId);
    // One lossless lexical policy for all sources. Never normalize text: result
    // ranges address canonical UTF-16 text and substring matches can cross chunks.
    for (const document of input.documents) {
      if (document.text === null) {
        await index.remove(document.id, document.revision);
        await index.removeSemanticGenerations(document, 'Lte');
      } else {
        await index.upsert([{ ...document, text: document.text }]);
      }
    }
    for (const document of input.documents) {
      if (document.text === null) continue;
      // Old revisions cannot pass canonical result validation. Reclaim them
      // once at planning, rather than waiting for every child to finish.
      await index.removeSemanticGenerations(document, 'Lt', true);
      const jobs = await searchEmbeddingJobs(reference, { ...document, text: document.text }, searchChunkPolicy());
      if (jobs.length) await publishSearchIndexingJobs(env.ACTIVITY_QUEUE, jobs);
      else await index.removeSemanticGenerations(document, 'Lte');
    }
    // An edit or deletion can commit during fan-out. Remove this stale
    // generation before retrying; newer revisions are never removed by this job.
    const current = SearchDocumentBatchSchema.parse(await load(false));
    let changed = false;
    for (const document of input.documents) {
      const next = current.documents.find((value) => value.id === document.id);
      const sameContent = next?.revision === document.revision && next.text === document.text;
      // A display change (a rename, an archive) during the upsert would leave
      // this row behind a patch that already ran; retrying rewrites it current.
      const sameDisplay = JSON.stringify(next?.display ?? null) === JSON.stringify(document.display ?? null);
      if (sameContent && sameDisplay) continue;
      changed = true;
      if (sameContent) continue;
      // An equal-revision extraction change must remain rewritable on retry.
      // A tombstone here would permanently reject the replacement lexical row.
      if (!next || next.revision > document.revision || next.text === null) {
        await index.remove(document.id, document.revision);
      }
      if (document.text !== null) await index.removeSemanticGeneration(document, await searchContentHash(document.text));
    }
    if (changed) throw new Error('search_source_changed');
    if (input.retry || current.retry) throw new Error('search_capture_retry_required');
  };
}
