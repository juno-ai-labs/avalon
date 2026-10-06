#!/usr/bin/env node
// Starts a new draft from an example: copies it to <dest> and points its kit
// paths at this skill, so the draft can live anywhere (use the scratchpad).
//
//   node kit/new.mjs import-ad-square /path/to/scratchpad/my-ad
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = path.dirname(fileURLToPath(import.meta.url));
const [example, dest] = process.argv.slice(2);
const src = path.join(kit, '..', 'examples', example || '');
if (!example || !dest || !fs.existsSync(src)) {
  console.error(`usage: new.mjs <example> <dest>\nexamples: ${fs.readdirSync(path.join(kit, '..', 'examples')).join(', ')}`);
  process.exit(2);
}
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (!/\.(html|mjs)$/.test(f)) continue; // renders and previews stay behind
  const body = fs.readFileSync(path.join(src, f), 'utf8').replaceAll('../../kit/', kit + '/');
  fs.writeFileSync(path.join(dest, f), body);
}
console.log(`new draft in ${dest}: edit scene.html and score.mjs, then\n  node ${path.join(kit, 'render.mjs')} ${path.join(dest, 'scene.html')} --preview 0,2,4`);
