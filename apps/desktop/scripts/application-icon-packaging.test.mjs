import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Use the same matcher and YAML parser as the installed packaging tool.
const builderRequire = createRequire(import.meta.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { FileMatcher } = libraryRequire('./fileMatcher');
const { load } = libraryRequire('js-yaml');
const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const config = load(readFileSync(join(desktop, 'electron-builder.yml'), 'utf8'));

function declaredStrings(path, declaration) {
  const source = readFileSync(path, 'utf8');
  const list = source.match(new RegExp(`${declaration} = \\[([\\s\\S]*?)\\]`, 'u'))?.[1];
  assert.ok(list, `Missing declaration ${declaration}`);
  return [...list.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]);
}

test('electron-builder includes the icon catalog along with every selectable rendition', () => {
  const entry = config.mac.extraResources.find((item) => item.to === 'app-icons');
  assert.ok(entry, 'Missing app-icons resources');
  const from = join(desktop, entry.from);
  const matcher = new FileMatcher(from, '/packaged/Resources/app-icons', (value) => value, entry.filter);
  const filter = matcher.createFilter();
  const fileStat = statSync(join(desktop, 'package.json'));
  assert.equal(filter(join(from, 'manifest.json'), fileStat), true, 'The runtime catalog must be packaged');
  assert.equal(filter(join(from, 'quiet.icns'), fileStat), true);
  assert.equal(filter(join(from, 'quiet.png'), fileStat), false);
});

test('catalog and verifier IDs match the preference contract and native slug grammar', () => {
  const contract = declaredStrings(join(desktop, '../../packages/contracts/src/telemetry.ts'), 'CURRENT_APPLICATION_ICON_IDS');
  const build = declaredStrings(join(desktop, 'scripts/build-macos-icon-components.mjs'), 'selectableIconNames');
  const verify = declaredStrings(join(desktop, 'scripts/verify-macos-app.mjs'), 'applicationIconNames');
  assert.deepEqual(build, contract);
  assert.deepEqual(verify, contract);
  for (const identifier of contract) assert.match(identifier, /^[a-z0-9-]+$/u);
});
