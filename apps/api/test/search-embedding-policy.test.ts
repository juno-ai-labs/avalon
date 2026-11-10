import { BPE, Tokenizer } from '@huggingface/tokenizers';
import { gunzipSync, strFromU8 } from 'fflate';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { searchChunkPolicy } from '../src/services/search-embedding';
import { semanticChunks } from '../src/services/semantic-chunks';
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

// Every boundary the Qwen cut rule admits, next to every hazard for it: case-
// insensitive contractions, combining marks NFC composes, CRLF and blank-line
// runs, trailing whitespace, digits, punctuation, URLs, code, scripts without
// spaces, and added tokens with and without surrounding words.
const ADDITIVITY_FIXTURES = [
  "It's what THEY'RE saying, isn't it? We'll see who'd've known.",
  'Cafe\u0301 de\u0301ja\u0300 vu: e\u0301 a\u030a o\u0308 re\u0301sume\u0301 Ange\u0301lique.',
  'Line one\r\nLine two\n\n\nLine three  \n  indented\n\tTabbed after\nend   ',
  'Order 12345 shipped on 2026-11-10 at 09:30, total $1,234.56 (approx 1.2e3 units).',
  'See https://example.com/path?q=search&x=1#frag and mail ops@example.com now.',
  'function search(query) {\n  return index.filter((row) => row.text.includes(query));\n}\nconst x = 1;',
  '漢字かな交じり文 with English words 混在 and 🙂 emoji 🚀 between words here.',
  'بيانات اختبار mixed with Latin words и кириллица tоже here and there.',
  'user said hello<|im_end|>\n<|im_start|>assistant\nhi there <|endoftext|> after words',
  '<tool_call>\n{"name": "lookup", "arguments": {"q": "word word"}}\n</tool_call> trailing words',
  '{"id": 42, "items": [1, 2, 3], "ok": true, "note": "it\'s 9 o\'clock", "nested": {"a": null}}',
  '- [x] done item\n* bullet (paren) [link](url) \'quoted\' "double" ` code ` ~ ^ | \\ / end',
  'x = a + b * (c - 1) / 2; if (x >= 10 && y != 3) { return "z"; } // comment\n# heading\n> quote',
  '\n\n\n.\n,\n1\n"\n<|im_end|>\n<think>\n \'s\n\'S\n é\n',
];

const mixedDocument = (length: number) => {
  let text = '';
  for (let index = 0; text.length < length; index += 1) {
    text += ADDITIVITY_FIXTURES[(index * 7) % ADDITIVITY_FIXTURES.length]!;
    text += index % 3 === 0 ? '\n\n' : index % 3 === 1 ? '\n' : ' ';
  }
  return text.slice(0, length);
};

it('counts every span of a text exactly as the tokenizer counts its slice', () => {
  const policy = searchChunkPolicy();
  const text = mixedDocument(6_000);
  const spans = policy.spanCounter!(text);
  // A fixed linear congruential sequence keeps the sampled spans reproducible.
  let seed = 7;
  const next = (bound: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % bound; };
  for (let sample = 0; sample < 400; sample += 1) {
    const start = next(text.length);
    const end = Math.min(text.length, start + 1 + next(sample % 2 ? 4_000 : 300));
    expect([start, end, spans(start, end)]).toEqual([start, end, policy.countTokens(text.slice(start, end))]);
  }
  expect(spans(0, text.length)).toBe(policy.countTokens(text));
  expect(spans(0, 0)).toBe(policy.countTokens(''));
});

it('plans the same chunks with span counts as with whole-span counts', async () => {
  const policy = searchChunkPolicy();
  const direct = { maxTokens: policy.maxTokens, overlapTokens: policy.overlapTokens, countTokens: policy.countTokens };
  const json = JSON.stringify(Array.from({ length: 150 }, (_, id) => ({ id, name: `row ${id}`, tags: ['a', 'b'] })), null, 2);
  for (const text of [mixedDocument(12_000), json, 'word '.repeat(3_000), 'unbroken'.repeat(2_000)]) {
    expect(await semanticChunks(text, policy)).toEqual(await semanticChunks(text, direct));
  }
});
