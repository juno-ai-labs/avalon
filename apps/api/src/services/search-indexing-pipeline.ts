import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { SearchDocumentBatchSchema, type SearchDocument, type SearchDocumentBatch } from './search-document';
import { searchChunkPolicy, embedSearchDocuments, SEARCH_EMBEDDING_BATCH_SIZE } from './search-embedding';
import { semanticChunks, type SemanticChunkPolicy } from './semantic-chunks';
import { isMemoryEmbeddingModel } from './structured-inference';
import { SEARCH_EMBEDDING_DIMENSIONS, workspaceSearchIndex, type TextSearchDocument, type TextSearchIndex } from './text-search';

/** Every source uses these exact inputs, offsets, chunk strategies, and model checks. */
export async function indexSemanticDocument(index: TextSearchIndex,
  document: SearchDocument & { text: string }, policy: SemanticChunkPolicy,
  embed: (text: string[]) => Promise<{ model: string; vectors: number[][] }>,
  batchSize = SEARCH_EMBEDDING_BATCH_SIZE,
): Promise<string[]> {
  if (batchSize !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(batchSize) || batchSize <= 0)) {
    throw new Error('invalid_search_embedding_batch_size');
  }
  const chunks = await semanticChunks(document.text, policy);
  const rows: TextSearchDocument[] = [];
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const embedding = await embed(batch.map((chunk) => chunk.embeddingText));
    if (!isMemoryEmbeddingModel(embedding.model)
      || embedding.vectors.length !== batch.length
      || !embedding.vectors.every((vector) => vector.length === SEARCH_EMBEDDING_DIMENSIONS
        && vector.every(Number.isFinite))) throw new Error('search_embedding_space_mismatch');
    for (const [offset, chunk] of batch.entries()) {
      const id = await sha256Hex(JSON.stringify([
        'semantic-chunks-v1', document.source, document.scopeId, document.sourceId,
        document.revision, chunk.start, chunk.end, chunk.embeddingText,
      ]));
      rows.push({ ...document, id, text: chunk.text, vector: embedding.vectors[offset]!,
        chunk: { start: chunk.start, end: chunk.end, strategies: chunk.strategies } });
    }
  }
  // Prepare all vectors before publishing this generation; a model mismatch
  // cannot leave a half-written generation. Queue retries reuse deterministic IDs.
  await index.upsert(rows);
  await index.removeSemanticGenerations(document, 'Lt');
  return rows.map((row) => row.id);
}

/** Source state stays batch-local; the immutable tokenizer is shared by the isolate. */
export function createSearchIndexingPipeline(env: Env) {
  return async (workspaceId: string, load: () => Promise<SearchDocumentBatch>): Promise<void> => {
    const input = SearchDocumentBatchSchema.parse(await load());
    if (!input.documents.length) {
      if (input.retry) throw new Error('search_source_retry_required');
      return;
    }
    const index = await workspaceSearchIndex(env, workspaceId);
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
      await indexSemanticDocument(index, { ...document, text: document.text }, searchChunkPolicy(),
        (text) => embedSearchDocuments(env, workspaceId, text));
    }
    // An edit or deletion can commit during embedding. Remove this stale
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
      await index.removeSemanticGenerations(document, 'Eq');
    }
    if (changed) throw new Error('search_source_changed');
    if (input.retry || current.retry) throw new Error('search_capture_retry_required');
  };
}
