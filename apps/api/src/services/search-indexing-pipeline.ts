import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { SearchDocumentBatchSchema, type SearchDocument, type SearchDocumentBatch } from './search-document';
import { searchChunkPolicy, SEARCH_EMBEDDING_BATCH_SIZE } from './search-embedding';
import { semanticChunks, type SemanticChunkPolicy } from './semantic-chunks';
import { isMemoryEmbeddingModel } from './structured-inference';
import { publishSearchEmbeddingBatches, type SearchEmbeddingBatch, type SearchSourceReference } from './search-indexing-jobs';
import { SEARCH_EMBEDDING_DIMENSIONS, searchChunkIdentity, workspaceSearchIndex, type TextSearchDocument, type TextSearchIndex } from './text-search';

/** One canonical chunk plan; batch jobs contain offsets, not source text. */
export async function searchEmbeddingJobs(reference: SearchSourceReference,
  document: SearchDocument & { text: string }, policy: SemanticChunkPolicy): Promise<SearchEmbeddingBatch[]> {
  const chunks = await semanticChunks(document.text, policy);
  const generation = await sha256Hex(document.text);
  const identity = { id: document.id, source: document.source, sourceId: document.sourceId,
    scopeId: document.scopeId, revision: document.revision };
  const jobs: SearchEmbeddingBatch[] = [];
  for (let start = 0; start < chunks.length; start += SEARCH_EMBEDDING_BATCH_SIZE) {
    jobs.push({ type: 'search_embedding_batch_v1', reference, document: identity, generation, chunkPolicy: searchChunkIdentity(),
      totalChunks: chunks.length, spans: chunks.slice(start, start + SEARCH_EMBEDDING_BATCH_SIZE)
        .map(({ start, end, strategies }) => ({ start, end, strategies })) });
  }
  return jobs;
}

/** Each delivery validates and publishes only its batch; completion reclaims old revisions. */
export async function indexSemanticBatch(index: TextSearchIndex, job: SearchEmbeddingBatch,
  load: () => Promise<SearchDocumentBatch>,
  embed: (texts: string[]) => Promise<{ model: string; vectors: number[][] }>,
): Promise<void> {
  const currentDocument = async () => {
    const current = SearchDocumentBatchSchema.parse(await load()).documents.find((document) => document.id === job.document.id);
    if (!current || current.text === null || current.revision !== job.document.revision
      || current.source !== job.document.source || current.sourceId !== job.document.sourceId
      || current.scopeId !== job.document.scopeId || await sha256Hex(current.text) !== job.generation) return null;
    return { ...current, text: current.text };
  };
  const document = await currentDocument();
  if (!document) {
    await index.removeSemanticGeneration(job.document, job.generation);
    return;
  }
  const chunks = job.spans.map((span) => {
    if (span.end <= span.start || span.end > document.text.length) throw new Error('invalid_search_chunk_range');
    return { ...span, text: document.text.slice(span.start, span.end) };
  });
  const ids = await Promise.all(chunks.map((chunk) => sha256Hex(JSON.stringify([
    'semantic-queue-chunks-v1', document.source, document.scopeId, document.sourceId,
    document.revision, job.generation, chunk.start, chunk.end, chunk.text,
  ]))));
  // Persisted deterministic rows let retries skip already completed provider work.
  if (await index.countSemanticChunks(document, { ids }) !== ids.length) {
    const embedding = await embed(chunks.map((chunk) => chunk.text));
    if (!isMemoryEmbeddingModel(embedding.model) || embedding.vectors.length !== chunks.length
      || !embedding.vectors.every((vector) => vector.length === SEARCH_EMBEDDING_DIMENSIONS
        && vector.every(Number.isFinite))) throw new Error('search_embedding_space_mismatch');
    const rows: TextSearchDocument[] = chunks.map((chunk, offset) => ({ ...document, id: ids[offset]!,
      text: chunk.text, vector: embedding.vectors[offset]!, generation: job.generation,
      chunk: { start: chunk.start, end: chunk.end, strategies: chunk.strategies } }));
    // Avoid a stale write after a slow provider request; recheck after publication too.
    if (!await currentDocument()) { await index.removeSemanticGeneration(job.document, job.generation); return; }
    await index.upsert(rows);
  }
  if (!await currentDocument()) { await index.removeSemanticGeneration(job.document, job.generation); return; }
  if (await index.countSemanticChunks(document, { generation: job.generation }) === job.totalChunks) {
    await index.removeSemanticGenerations(document, 'Lt', true);
  }
}

/** Source state stays batch-local; the immutable tokenizer is shared by the isolate. */
export function createSearchIndexingPipeline(env: Env) {
  return async (reference: SearchSourceReference, load: () => Promise<SearchDocumentBatch>): Promise<void> => {
    const input = SearchDocumentBatchSchema.parse(await load());
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
      const jobs = await searchEmbeddingJobs(reference, { ...document, text: document.text }, searchChunkPolicy());
      if (jobs.length) await publishSearchEmbeddingBatches(env.ACTIVITY_QUEUE, jobs);
      else await index.removeSemanticGenerations(document, 'Lte');
    }
    // An edit or deletion can commit during fan-out. Remove this stale
    // generation before retrying; newer revisions are never removed by this job.
    const current = SearchDocumentBatchSchema.parse(await load());
    let changed = false;
    for (const document of input.documents) {
      const next = current.documents.find((value) => value.id === document.id);
      if (next?.revision === document.revision && next.text === document.text) continue;
      changed = true;
      // An equal-revision extraction change must remain rewritable on retry.
      // A tombstone here would permanently reject the replacement lexical row.
      if (!next || next.revision > document.revision || next.text === null) {
        await index.remove(document.id, document.revision);
      }
      if (document.text !== null) await index.removeSemanticGeneration(document, await sha256Hex(document.text));
    }
    if (changed) throw new Error('search_source_changed');
    if (input.retry || current.retry) throw new Error('search_capture_retry_required');
  };
}
