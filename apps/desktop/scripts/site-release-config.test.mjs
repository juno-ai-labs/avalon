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
  'Rally-0.1.0-arm64.dmg',
  'Rally-0.1.0-arm64.dmg.blockmap',
  'Rally-0.1.0-arm64-mac.zip',
  'Rally-0.1.0-arm64-mac.zip.blockmap',
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
    ['Rally.dmg', sha256('1')],
    ['SHA256SUMS', sha256('f')],
  ]);
  const config = createPublishedSiteReleaseConfig({
    published: true,
    version: '0.0.9',
    platform: 'macOS',
    architecture: 'Apple silicon',
  }, {
    version: '0.1.0',
    artifactNames: artifacts,
    checksumsFile: 'SHA256SUMS',
    bucket: 'rally-desktop-releases',
    prefix: '/stable/darwin/arm64/',
    downloadBaseUrl: 'https://downloads.rallywith.ai',
    sha256: hashes,
    publishedAt: '2026-08-02T12:00:00.000Z',
  });

  assert.equal(config.published, true);
  assert.equal(config.version, '0.1.0');
  assert.equal(config.objects.dmg, 'stable/darwin/arm64/Rally-0.1.0-arm64.dmg');
  assert.equal(config.objects.canonicalDmg, 'stable/darwin/arm64/Rally.dmg');
  assert.equal(config.objects.checksums, 'stable/darwin/arm64/0.1.0/SHA256SUMS');
  assert.equal(config.objects.latest, 'stable/darwin/arm64/latest-mac.yml');
  assert.deepEqual(config.files.blockmaps, [
    'Rally-0.1.0-arm64-mac.zip.blockmap',
    'Rally-0.1.0-arm64.dmg.blockmap',
  ]);
});

test('the published config records the commit the release was built from', () => {
  // plan-release.mjs measures unreleased desktop work against this commit, so
  // it is the difference between the next merge releasing and skipping.
  const hashes = Object.fromEntries([
    ...artifacts.map((name, index) => [name, sha256(String(index + 1))]),
    ['Rally.dmg', sha256('1')],
    ['SHA256SUMS', sha256('f')],
  ]);
  const options = {
    version: '0.1.0',
    artifactNames: artifacts,
    bucket: 'rally-desktop-releases',
    prefix: 'stable/darwin/arm64',
    downloadBaseUrl: 'https://downloads.rallywith.ai',
    sha256: hashes,
    publishedAt: '2026-08-02T12:00:00.000Z',
  };
  const commit = 'a'.repeat(40);
  const previous = { version: '0.0.9', commit: 'b'.repeat(40) };

  assert.equal(createPublishedSiteReleaseConfig(previous, { ...options, commit }).commit, commit);

  // Carrying the previous release's commit forward would measure new work
  // against a release that did not contain it. Dropping it makes the planner
  // fail open and cut a release instead.
  assert.equal(createPublishedSiteReleaseConfig(previous, options).commit, undefined);
  assert.equal('commit' in createPublishedSiteReleaseConfig(previous, options), false);

  // A ref or an abbreviation can later name a different object; only a full
  // object name is a durable watermark.
  for (const invalid of ['main', 'a'.repeat(39), `${'a'.repeat(39)}Z`, 'A'.repeat(40), '']) {
    assert.throws(
      () => createPublishedSiteReleaseConfig(previous, { ...options, commit: invalid }),
      /Release commit/u,
    );
  }
});

test('site activation requires both differential blockmaps and refuses downgrades', () => {
  const options = {
    version: '0.1.0',
    artifactNames: artifacts.filter((name) => name !== 'Rally-0.1.0-arm64.dmg.blockmap'),
    bucket: 'rally-desktop-releases',
    prefix: 'stable/darwin/arm64',
    downloadBaseUrl: 'https://downloads.rallywith.ai',
    sha256: {},
    publishedAt: '2026-08-02T12:00:00.000Z',
  };
  assert.throws(
    () => createPublishedSiteReleaseConfig({ version: '0.1.0' }, options),
    /Missing release blockmap/u,
  );
  assert.throws(
    () => createPublishedSiteReleaseConfig({ version: '0.1.1' }, options),
    /Refusing to roll site release back/u,
  );
});

test('site release configuration replacement is atomic and leaves no temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-site-release-test-'));
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
