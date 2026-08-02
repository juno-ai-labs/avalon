import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createChecksumManifest,
  createPublishedSiteReleaseConfig,
  readSiteReleaseConfig,
  writeSiteReleaseConfigAtomically,
} from './site-release-config.mjs';

const sha256 = (character) => character.repeat(64);
const artifacts = [
  'Avalon-0.1.0-arm64.dmg',
  'Avalon-0.1.0-arm64.dmg.blockmap',
  'Avalon-0.1.0-arm64-mac.zip',
  'Avalon-0.1.0-arm64-mac.zip.blockmap',
];

test('checksum manifest is deterministic and contains only plain artifact names', () => {
  assert.equal(createChecksumManifest([
    { name: 'b.zip', sha256: sha256('b') },
    { name: 'a.dmg', sha256: sha256('a') },
  ]), `${sha256('a')}  a.dmg\n${sha256('b')}  b.zip\n`);
  assert.throws(
    () => createChecksumManifest([{ name: '../a.dmg', sha256: sha256('a') }]),
    /plain file name/u,
  );
});

test('published site configuration points to the exact promoted release channel', () => {
  const hashes = Object.fromEntries([
    ...artifacts.map((name, index) => [name, sha256(String(index + 1))]),
    ['Avalon.dmg', sha256('1')],
    ['SHA256SUMS', sha256('f')],
  ]);
  const config = createPublishedSiteReleaseConfig({
    published: false,
    version: '0.1.0',
    platform: 'macOS',
    architecture: 'Apple silicon',
  }, {
    version: '0.1.0',
    artifactNames: artifacts,
    checksumsFile: 'SHA256SUMS',
    bucket: 'avalon-desktop-releases',
    prefix: '/stable/darwin/arm64/',
    downloadBaseUrl: 'https://downloads.with-avalon.com',
    sha256: hashes,
    publishedAt: '2026-08-02T12:00:00.000Z',
  });

  assert.equal(config.published, true);
  assert.equal(config.objects.dmg, 'stable/darwin/arm64/Avalon-0.1.0-arm64.dmg');
  assert.equal(config.objects.canonicalDmg, 'stable/darwin/arm64/Avalon.dmg');
  assert.equal(config.objects.checksums, 'stable/darwin/arm64/0.1.0/SHA256SUMS');
  assert.equal(config.objects.latest, 'stable/darwin/arm64/latest-mac.yml');
  assert.deepEqual(config.files.blockmaps, [
    'Avalon-0.1.0-arm64-mac.zip.blockmap',
    'Avalon-0.1.0-arm64.dmg.blockmap',
  ]);
});

test('site activation requires the matching version and both differential blockmaps', () => {
  const options = {
    version: '0.1.0',
    artifactNames: artifacts.filter((name) => name !== 'Avalon-0.1.0-arm64.dmg.blockmap'),
    bucket: 'avalon-desktop-releases',
    prefix: 'stable/darwin/arm64',
    downloadBaseUrl: 'https://downloads.with-avalon.com',
    sha256: {},
    publishedAt: '2026-08-02T12:00:00.000Z',
  };
  assert.throws(
    () => createPublishedSiteReleaseConfig({ version: '0.1.0' }, options),
    /Missing release blockmap/u,
  );
  assert.throws(
    () => createPublishedSiteReleaseConfig({ version: '0.1.1' }, options),
    /does not match/u,
  );
});

test('site release configuration replacement is atomic and leaves no temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-site-release-test-'));
  const path = join(directory, 'release.config.json');
  try {
    await writeFile(path, '{"published":false}\n', 'utf8');
    const next = { published: true, version: '0.1.0' };
    await writeSiteReleaseConfigAtomically(path, next);
    assert.deepEqual(await readSiteReleaseConfig(path), next);
    assert.deepEqual(await readdir(directory), ['release.config.json']);
    assert.equal(await readFile(path, 'utf8'), `${JSON.stringify(next, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
