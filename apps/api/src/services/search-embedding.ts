import { Tokenizer } from '@huggingface/tokenizers';
import { z } from 'zod';
import type { Env } from '../env';
import { SEARCH_CHUNK_MAX_TOKENS, SEARCH_CHUNK_OVERLAP_TOKENS, type SemanticChunkPolicy } from './semantic-chunks';
import { runEmbeddingInference } from './structured-inference';
import { SEARCH_EMBEDDING_DIMENSIONS, QWEN_MODEL_COMMIT } from './text-search';
import tokenizerAsset from './assets/qwen3-tokenizer.json';

/** Missing provider credentials leave durable intents pending, without a hot alarm. */
export function searchIndexingConfigured(env: Env): boolean {
  const key = env.APP_ENV === 'production' ? env.TURBO_PUFFER_PROD_API_KEY : env.TURBO_PUFFER_DEV_API_KEY;
  return Boolean(key && env.OPENROUTER_API_KEY);
}

/** One policy per regional Queue batch; sources cannot override it. */
export async function searchChunkPolicy(): Promise<SemanticChunkPolicy> {
  if (tokenizerAsset.revision !== QWEN_MODEL_COMMIT) throw new Error('search_tokenizer_revision_mismatch');
  // Inflate inside the Queue delivery, not during Worker module startup. These
  // immutable bytes ship with the Worker; no provider download or shared I/O.
  const bytes = Uint8Array.from(atob(tokenizerAsset.gzipBase64), (character) => character.charCodeAt(0));
  const payload: unknown = await new Response(new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('gzip'))).json();
  const { definition, config } = z.object({
    definition: z.record(z.string(), z.unknown()),
    config: z.record(z.string(), z.unknown()),
  }).parse(payload);
  const tokenizer = new Tokenizer(definition, config);
  return { maxTokens: SEARCH_CHUNK_MAX_TOKENS, overlapTokens: SEARCH_CHUNK_OVERLAP_TOKENS, countTokens: (text) => tokenizer.encode(text).ids.length };
}

export async function embedSearchDocument(env: Env, workspaceId: string, text: string) {
  try {
    const result = await runEmbeddingInference(env, {
      context: { workspaceId }, text, inputType: 'search_document',
      dimensions: SEARCH_EMBEDDING_DIMENSIONS, generationName: 'search_document_embedding',
      executionPrincipalType: 'workspace', executionPrincipalId: workspaceId,
      feature: 'search_embedding',
    });
    const vector = result.embeddings[0];
    if (!vector) throw new Error('search_embedding_missing');
    return { model: result.resolvedModel, vector };
  } catch {
    throw new Error('search_embedding_failed');
  }
}
