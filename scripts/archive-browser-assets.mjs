// Uploads the browser host's hashed build files to the bucket its Worker reads
// when the current deploy lacks a file (`pastAsset` in apps/browser/src/worker.tsx).
// Run after the build and before `wrangler deploy`, so every deployed file is
// already archived by the time a later deploy replaces it. Wrangler creates the
// bucket a binding names only at deploy, after this upload, so a new account's
// first deploy creates it here.
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const browser = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/browser');
const BUCKET = 'rally-browser-assets';
const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.wasm': 'application/wasm', '.json': 'application/json',
};
// Uploads in flight at once; only deploy time depends on it.
const PARALLEL = 8;

const files = await readdir(join(browser, 'dist/assets'));
if (files.length === 0) throw new Error('apps/browser/dist/assets is empty: build the client first');
try {
  await run('pnpm', ['exec', 'wrangler', 'r2', 'bucket', 'create', BUCKET], { cwd: browser });
} catch (error) {
  if (!/already exists/iu.test(`${error.stdout}${error.stderr}`)) throw error;
}
const queue = [...files];
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  for (let name = queue.shift(); name; name = queue.shift()) {
    const type = TYPES[extname(name)] ?? 'application/octet-stream';
    await run('pnpm', ['exec', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/assets/${name}`,
      `--file=dist/assets/${name}`, `--content-type=${type}`, '--remote'], { cwd: browser });
  }
}));
console.log(`Archived ${files.length} build files to ${BUCKET}`);
