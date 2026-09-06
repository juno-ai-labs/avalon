import { BPE, Tokenizer } from '@huggingface/tokenizers';
import { gunzipSync, strFromU8 } from 'fflate';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { searchChunkPolicy } from '../src/services/search-embedding';
import tokenizerAsset from '../src/services/assets/qwen3-tokenizer.json';

afterEach(() => vi.restoreAllMocks());

it('reuses one immutable policy with exact Qwen counts', () => {
  const first = searchChunkPolicy();
  const second = searchChunkPolicy();
  expect(first).toBe(second);
  expect(Object.isFrozen(first)).toBe(true);
  expect(first.countTokens('A harmless memory measurement.')).toBe(6);
  expect(second.countTokens('A harmless memory measurement.')).toBe(6);
});

it('does not retain input fragments in the shared model after counting', () => {
  // These published library members deliberately pin the cache cleanup contract.
  const bpe = vi.spyOn(BPE.prototype, 'bpe');
  searchChunkPolicy().countTokens('A harmless memory measurement.');
  expect(bpe).toHaveBeenCalled();
  for (const [index, [fragment]] of bpe.mock.calls.entries()) {
    const model = bpe.mock.contexts[index];
    if (!(model instanceof BPE)) throw new Error('unexpected test model');
    expect(model.cache.get(fragment)).toBeUndefined();
  }
});

it('clears input fragments when tokenization throws', () => {
  let model: BPE | undefined;
  vi.spyOn(Tokenizer.prototype, 'tokenize').mockImplementation(function (this: Tokenizer) {
    if (!(this.model instanceof BPE)) throw new Error('unexpected test model');
    model = this.model;
    model.bpe('private');
    expect(model.cache.get('private')).toBeDefined();
    throw new Error('tokenization failed');
  });
  expect(() => searchChunkPolicy().countTokens('private')).toThrow('tokenization failed');
  expect(model?.cache.get('private')).toBeUndefined();
});

it('releases construction tables while preserving the complete pinned encoding counts', () => {
  const payload: unknown = JSON.parse(strFromU8(gunzipSync(Uint8Array.from(
    atob(tokenizerAsset.gzipBase64), (character) => character.charCodeAt(0),
  ))));
  const { definition, config } = z.object({
    definition: z.record(z.string(), z.unknown()), config: z.record(z.string(), z.unknown()),
  }).parse(payload);
  const reference = new Tokenizer(definition, config);
  const tokenize = vi.spyOn(Tokenizer.prototype, 'tokenize');
  const policy = searchChunkPolicy();
  for (const text of ['', 'A harmless memory measurement.', '漢🙂字🚀é',
    'بيانات اختبار пример', '<|endoftext|>\n<|im_start|>user\nhi<|im_end|>',
    'https://example.com/q?x=1&y=two', ' \n\t '.repeat(300), 'unbroken'.repeat(1000)]) {
    expect(policy.countTokens(text)).toBe(reference.encode(text).ids.length);
  }
  const compact = tokenize.mock.contexts[0];
  if (!(compact instanceof Tokenizer) || !(compact.model instanceof BPE)) throw new Error('unexpected test model');
  expect(compact.model.config.vocab).toEqual({});
  expect(compact.model.config.merges).toEqual([]);
  expect(compact.model.merges).toEqual([]);
  expect(compact.model.tokens_to_ids.size).toBeGreaterThan(0);
  expect(compact.model.bpe_ranks.size).toBeGreaterThan(0);
});
