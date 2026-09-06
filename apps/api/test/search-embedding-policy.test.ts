import { BPE, Tokenizer } from '@huggingface/tokenizers';
import { afterEach, expect, it, vi } from 'vitest';
import { searchChunkPolicy } from '../src/services/search-embedding';

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

it('clears input fragments when encoding throws', () => {
  let model: BPE | undefined;
  vi.spyOn(Tokenizer.prototype, 'encode').mockImplementation(function (this: Tokenizer) {
    if (!(this.model instanceof BPE)) throw new Error('unexpected test model');
    model = this.model;
    model.bpe('private');
    expect(model.cache.get('private')).toBeDefined();
    throw new Error('encoding failed');
  });
  expect(() => searchChunkPolicy().countTokens('private')).toThrow('encoding failed');
  expect(model?.cache.get('private')).toBeUndefined();
});
