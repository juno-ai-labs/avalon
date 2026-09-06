import { Tokenizer } from '@huggingface/tokenizers';
import { z } from 'zod';
import type { Env } from '../env';
import type { SemanticChunkPolicy } from './semantic-chunks';
import { runEmbeddingInference } from './structured-inference';
import { SEARCH_EMBEDDING_DIMENSIONS, QWEN_MODEL_COMMIT } from './text-search';

// Immutable public model assets; source text is tokenized locally, never sent here.
const TOKENIZER_ROOT = `https://huggingface.co/Qwen/Qwen3-Embedding-8B/resolve/${QWEN_MODEL_COMMIT}`;
const ChunkSettingsSchema = z.strictObject({
  maxTokens: z.coerce.number().int().positive(),
  overlapTokens: z.coerce.number().int().nonnegative(),
}).refine((value) => value.overlapTokens < value.maxTokens);

/** Missing deployment settings leave durable intents pending, without a hot alarm. */
export function searchIndexingConfigured(env: Env): boolean {
  const key = env.APP_ENV === 'production' ? env.TURBO_PUFFER_PROD_API_KEY : env.TURBO_PUFFER_DEV_API_KEY;
  return Boolean(key && env.OPENROUTER_API_KEY && env.SEARCH_CHUNK_MAX_TOKENS
    && env.SEARCH_CHUNK_OVERLAP_TOKENS !== undefined
    && env.SEARCH_CHUNK_OVERLAP_TOKENS !== ''
    && ChunkSettingsSchema.safeParse({ maxTokens: env.SEARCH_CHUNK_MAX_TOKENS,
      overlapTokens: env.SEARCH_CHUNK_OVERLAP_TOKENS }).success);
}

/** One policy per regional Queue batch; sources cannot override it. */
export async function searchChunkPolicy(env: Env): Promise<SemanticChunkPolicy> {
  if (!env.SEARCH_CHUNK_MAX_TOKENS || env.SEARCH_CHUNK_OVERLAP_TOKENS === undefined) {
    throw new Error('search_chunk_policy_unconfigured');
  }
  const settings = ChunkSettingsSchema.parse({
    maxTokens: env.SEARCH_CHUNK_MAX_TOKENS, overlapTokens: env.SEARCH_CHUNK_OVERLAP_TOKENS,
  });
  const readAsset = async (name: string) => {
    const response = await fetch(`${TOKENIZER_ROOT}/${name}`);
    if (!response.ok) throw new Error('search_tokenizer_unavailable');
    return z.record(z.string(), z.unknown()).parse(await response.json());
  };
  const [definition, config] = await Promise.all([readAsset('tokenizer.json'), readAsset('tokenizer_config.json')]);
  const tokenizer = new Tokenizer(definition, config);
  return { ...settings, countTokens: (text) => tokenizer.encode(text).ids.length };
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
