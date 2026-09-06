import { Tokenizer } from '@huggingface/tokenizers';
import { z } from 'zod';
import type { Env } from '../env';
import type { SemanticChunkPolicy } from './semantic-chunks';
import { runEmbeddingInference } from './structured-inference';
import { SEARCH_EMBEDDING_DIMENSIONS, SEARCH_TOKENIZER_REVISION } from './text-search';

// Immutable public model assets; source text is tokenized locally, never sent here.
const TOKENIZER_ROOT = `https://huggingface.co/Qwen/Qwen3-Embedding-8B/resolve/${SEARCH_TOKENIZER_REVISION}`;
const ChunkSettingsSchema = z.strictObject({
  maxTokens: z.coerce.number().int().positive(),
  overlapTokens: z.coerce.number().int().nonnegative(),
}).refine((value) => value.overlapTokens < value.maxTokens);

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
