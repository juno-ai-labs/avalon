import { BPE, Tokenizer } from '@huggingface/tokenizers';
import { gunzipSync, strFromU8 } from 'fflate';
import { z } from 'zod';
import type { Env } from '../env';
import { SEARCH_CHUNK_MAX_TOKENS, SEARCH_CHUNK_OVERLAP_TOKENS, type SemanticChunkPolicy } from './semantic-chunks';
import { runEmbeddingInference } from './structured-inference';
import { additiveSpanCounter } from './token-span-counter';
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
  const countTokens = (text: string) => {
    // tokenize uses the same pipeline as encode without allocating unused
    // token-ID and attention-mask arrays. Its framing default is different.
    try { return tokenizer.tokenize(text, { add_special_tokens: true }).length; }
    finally { model.clear_cache(); }
  };
  return Object.freeze({
    maxTokens: SEARCH_CHUNK_MAX_TOKENS,
    overlapTokens: SEARCH_CHUNK_OVERLAP_TOKENS,
    countTokens,
    spanCounter: (text: string) => additiveSpanCounter(text, countTokens, qwenAdditiveCuts(text), { before: 1, after: 2 }),
  });
}

// Segments between kept cuts are tokenized once per text and a span's two edges
// once per measurement, so this trades the number of tokenize calls against
// the length of each edge. A performance setting, not a limit: any value gives
// the same counts. Measured on 2026-11-10 against 1.2-million-character prose
// and pretty-printed JSON: 16 planned fastest of 1, 16, 32, 64 and 128.
const QWEN_CUT_SPACING = 16;

// Printable ASCII other than the space: never whitespace, never composed by NFC
// with a neighbor across a space or line feed, and not part of an added token's
// surrounding whitespace.
const isVisibleAscii = (code: number) => code > 32 && code < 127;

/**
 * Positions where the pinned Qwen3 pipeline is additive, at least
 * `QWEN_CUT_SPACING` apart: before a single space that has visible ASCII on
 * both sides (`word| word`, `":| "`), and between a line feed and visible ASCII.
 * Each stage splits there identically on the whole text and on its two sides.
 * No added token contains whitespace or strips it. NFC never composes across a
 * space or line feed. Every alternative of the Split pattern that can cover the
 * character before the cut stops there: letter runs and punctuation runs stop
 * at whitespace, `[\r\n]*` stops at visible text, and a digit is a token alone;
 * the pattern has no lookbehind, so the match that starts at the cut is the one
 * the right side starts with. ByteLevel and BPE work within one pre-token, and
 * the template appends `<|endoftext|>` once per call, which
 * `additiveSpanCounter` subtracts. This holds for revision `QWEN_MODEL_COMMIT`
 * only, which `createSearchChunkPolicy` enforces; the differential tests in
 * `search-embedding-policy.test.ts` compare it with direct counts.
 */
function qwenAdditiveCuts(text: string): Int32Array {
  const cuts: number[] = [];
  let previous = 0;
  for (let index = 1; index + 1 < text.length; index += 1) {
    if (index - previous < QWEN_CUT_SPACING) continue;
    const before = text.charCodeAt(index - 1);
    const at = text.charCodeAt(index);
    if ((isVisibleAscii(before) && at === 32 && isVisibleAscii(text.charCodeAt(index + 1)))
      || (before === 10 && isVisibleAscii(at))) {
      cuts.push(index);
      previous = index;
    }
  }
  return Int32Array.from(cuts);
}

// Approved by the team on 2026-09-06: 64 chunks per request, at most
// 32,768 input tokens and 65,536 vector values. Every chunk is still processed.
export const SEARCH_EMBEDDING_BATCH_SIZE = 64;

export async function embedSearchDocuments(env: Env, workspaceId: string, texts: string[]) {
  try {
    const result = await runEmbeddingInference(env, {
      context: { workspaceId }, text: texts, inputType: 'search_document',
      dimensions: SEARCH_EMBEDDING_DIMENSIONS, generationName: 'search_document_embedding',
      executionPrincipalType: 'workspace', executionPrincipalId: workspaceId,
      feature: 'search_embedding',
    });
    return { model: result.resolvedModel, vectors: result.embeddings };
  } catch {
    throw new Error('search_embedding_failed');
  }
}
