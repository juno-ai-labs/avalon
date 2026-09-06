import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { encodeTokenizerAsset } from './vendor-search-tokenizer.mjs';

test('tokenizer packaging preserves Unicode definition/config with a portable gzip header', () => {
  const definition = { model: { type: 'BPE', vocab: { 'hello': 0, '漢🙂': 1 } } };
  const config = { add_bos_token: false, bos_token: '<start>' };
  const encoded = encodeTokenizerAsset(definition, config);
  const compressed = Buffer.from(encoded, 'base64');
  // Gzip compression method, zero timestamp, and OS=unknown are portable metadata.
  assert.deepEqual([...compressed.subarray(0, 10)], [31, 139, 8, 0, 0, 0, 0, 0, 2, 255]);
  assert.deepEqual(JSON.parse(gunzipSync(compressed).toString('utf8')), { definition, config });
  assert.equal(encodeTokenizerAsset(definition, config), encoded);
});
