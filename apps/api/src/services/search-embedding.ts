import { BPE, Tokenizer } from '@huggingface/tokenizers';
import { gunzipSync, strFromU8 } from 'fflate';
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

// Only closure-private public model data survives a delivery. Never share request promises,
// streams, credentials, source text, or the tokenizer's input cache.
let sharedPolicy: SemanticChunkPolicy | undefined;

/** One tokenizer per isolate, even when multiple Queue deliveries overlap. */
export function searchChunkPolicy(): SemanticChunkPolicy {
  return sharedPolicy ??= createSearchChunkPolicy();
}

function createSearchChunkPolicy(): SemanticChunkPolicy {
  if (tokenizerAsset.revision !== QWEN_MODEL_COMMIT) throw new Error('search_tokenizer_revision_mismatch');
  // Lazy synchronous initialization cannot interleave with another delivery or
  // retain I/O owned by its request. Keep vocabulary parsing out of startup.
  const bytes = Uint8Array.from(atob(tokenizerAsset.gzipBase64), (character) => character.charCodeAt(0));
  const payload: unknown = JSON.parse(strFromU8(gunzipSync(bytes)));
  const { definition, config } = z.object({
    definition: z.record(z.string(), z.unknown()),
    config: z.record(z.string(), z.unknown()),
  }).parse(payload);
  const tokenizer = new Tokenizer(definition, config);
  const model = tokenizer.model;
  if (!(model instanceof BPE)) throw new Error('search_tokenizer_model_mismatch');
  // The pinned library compiles these construction tables into tokens_to_ids
  // and bpe_ranks. Encoding uses those maps, not the retained source tables.
  // Keep the runtime maps/vocabulary and all framing/normalization settings.
  model.config.vocab = {};
  model.config.merges = [];
  model.merges = [];
  return Object.freeze({
    maxTokens: SEARCH_CHUNK_MAX_TOKENS,
    overlapTokens: SEARCH_CHUNK_OVERLAP_TOKENS,
    countTokens: (text: string) => {
      // tokenize uses the same pipeline as encode without allocating unused
      // token-ID and attention-mask arrays. Its framing default is different.
      try { return tokenizer.tokenize(text, { add_special_tokens: true }).length; }
      finally { model.clear_cache(); }
    },
  });
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
