// Refresh the immutable tokenizer shipped with the search Worker.
// Run from any directory: node scripts/vendor-search-tokenizer.mjs
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const source = await readFile(new URL('../apps/api/src/services/text-search.ts', import.meta.url), 'utf8');
const revision = /export const QWEN_MODEL_COMMIT = "([a-f0-9]{40})"/u.exec(source)?.[1];
if (!revision) throw new Error('Cannot find the pinned Qwen tokenizer revision');
const root = `https://huggingface.co/Qwen/Qwen3-Embedding-8B/resolve/${revision}`;
const files = await Promise.all(['tokenizer.json', 'tokenizer_config.json', 'LICENSE'].map(async (name) => {
  const response = await fetch(`${root}/${name}`);
  if (!response.ok) throw new Error(`Tokenizer asset ${name}: HTTP ${response.status}`);
  return { name, text: await response.text() };
}));
const definition = JSON.parse(files[0].text);
const config = JSON.parse(files[1].text);
const asset = {
  revision,
  source: root,
  files: files.map(({ name, text }) => ({ name, sha256: createHash('sha256').update(text).digest('hex') })),
  // Gzip avoids parsing a 150k-entry vocabulary during Worker module startup.
  gzipBase64: gzipSync(JSON.stringify({ definition, config }), { level: 9 }).toString('base64'),
};
await writeFile(new URL('../apps/api/src/services/assets/qwen3-tokenizer.json', import.meta.url), `${JSON.stringify(asset, null, 2)}\n`);
await writeFile(new URL('../apps/api/src/services/assets/qwen3-tokenizer.LICENSE', import.meta.url), files[2].text);
console.log(`Vendored Qwen tokenizer ${revision}: ${asset.gzipBase64.length} base64 bytes`);
