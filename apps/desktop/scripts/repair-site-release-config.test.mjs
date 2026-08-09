import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublishedSiteReleaseConfig } from './site-release-config.mjs';
import {
  buildRepairOptions,
  dmgSizeFromManifest,
  parseChecksumManifest,
  versionFromManifest,
} from './repair-site-release-config.mjs';

const digest = (seed) => seed.repeat(64).slice(0, 64);

const manifest = (version) => [
  `version: "${version}"`,
  'files:',
  `  - url: "Avalon-${version}-mac-arm64.zip"`,
  '    sha512: "aGVsbG8="',
  '    size: 136819468',
  `  - url: "Avalon-${version}-mac-arm64.dmg"`,
  '    sha512: "d29ybGQ="',
  '    size: 137324235',
  `path: "Avalon-${version}-mac-arm64.zip"`,
  '',
].join('\n');

const checksums = (version) => [
  `${digest('a')}  Avalon-${version}-mac-arm64.dmg`,
  `${digest('b')}  Avalon-${version}-mac-arm64.dmg.blockmap`,
  `${digest('c')}  Avalon-${version}-mac-arm64.zip`,
  `${digest('d')}  Avalon-${version}-mac-arm64.zip.blockmap`,
  '',
].join('\n');

const currentConfig = (version) => ({
  published: true,
  version,
  platform: 'macOS',
  architecture: 'Apple silicon',
  downloadBaseUrl: 'https://downloads.with-avalon.com',
  bucket: 'avalon-desktop-releases',
  prefix: 'stable/darwin/arm64',
  files: {
    dmg: `Avalon-${version}-mac-arm64.dmg`,
    canonicalDmg: 'Avalon.dmg',
    zip: `Avalon-${version}-mac-arm64.zip`,
    blockmaps: [`Avalon-${version}-mac-arm64.dmg.blockmap`, `Avalon-${version}-mac-arm64.zip.blockmap`],
    checksums: 'SHA256SUMS',
    latest: 'latest-mac.yml',
  },
  objects: {},
  sha256: {},
  publishedAt: '2026-08-09T00:00:00.000Z',
});

test('the live version and DMG size are read from the update manifest', () => {
  assert.equal(versionFromManifest(manifest('1.34.0')), '1.34.0');
  assert.deepEqual(dmgSizeFromManifest(manifest('1.34.0'), '1.34.0'), {
    name: 'Avalon-1.34.0-mac-arm64.dmg',
    size: 137324235,
  });
});

test('a manifest without a usable version is rejected rather than assumed', () => {
  assert.throws(() => versionFromManifest('files:\n  - url: "Avalon.zip"\n'), /semantic version/u);
  assert.throws(() => versionFromManifest('version: latest\n'), /semantic version/u);
});

test('checksum lines are parsed, and malformed ones rejected', () => {
  const digests = parseChecksumManifest(checksums('1.34.0'));
  assert.equal(Object.keys(digests).length, 4);
  assert.equal(digests['Avalon-1.34.0-mac-arm64.dmg'], digest('a'));
  assert.throws(() => parseChecksumManifest('not-a-digest  Avalon.dmg\n'), /Unreadable SHA256SUMS line/u);
  assert.throws(() => parseChecksumManifest(''), /empty/u);
  assert.throws(
    () => parseChecksumManifest(`${digest('a')}  x.dmg\n${digest('b')}  x.dmg\n`),
    /Duplicate artifact/u,
  );
});

test('a repaired record is one the publisher would have written', () => {
  // The repair reuses createPublishedSiteReleaseConfig, so a record rebuilt
  // from the live channel has to satisfy every publication invariant.
  const current = currentConfig('1.33.0');
  const options = buildRepairOptions({
    current,
    version: '1.34.0',
    digests: parseChecksumManifest(checksums('1.34.0')),
    checksumsDigest: digest('e'),
    publishedAt: '2026-08-09T20:25:23.000Z',
  });
  const repaired = createPublishedSiteReleaseConfig(current, options);

  assert.equal(repaired.published, true);
  assert.equal(repaired.version, '1.34.0');
  assert.equal(repaired.files.dmg, 'Avalon-1.34.0-mac-arm64.dmg');
  assert.equal(repaired.objects.dmg, 'stable/darwin/arm64/Avalon-1.34.0-mac-arm64.dmg');
  assert.equal(repaired.objects.checksums, 'stable/darwin/arm64/1.34.0/SHA256SUMS');
  // The canonical DMG is a byte-identical copy, so it carries the same digest.
  assert.equal(repaired.sha256['Avalon.dmg'], repaired.sha256['Avalon-1.34.0-mac-arm64.dmg']);
  assert.equal(repaired.publishedAt, '2026-08-09T20:25:23.000Z');
});

test('the repair refuses to roll the record backwards', () => {
  // A stale channel read must never undo a newer recorded release.
  const current = currentConfig('1.34.0');
  const options = buildRepairOptions({
    current,
    version: '1.33.0',
    digests: parseChecksumManifest(checksums('1.33.0')),
    checksumsDigest: digest('e'),
    publishedAt: '2026-08-09T20:25:23.000Z',
  });
  assert.throws(() => createPublishedSiteReleaseConfig(current, options), /Refusing to roll site release back/u);
});

test('a channel missing a blockmap is rejected rather than half-recorded', () => {
  const current = currentConfig('1.33.0');
  const partial = parseChecksumManifest(
    `${digest('a')}  Avalon-1.34.0-mac-arm64.dmg\n${digest('c')}  Avalon-1.34.0-mac-arm64.zip\n`,
  );
  const options = buildRepairOptions({
    current,
    version: '1.34.0',
    digests: partial,
    checksumsDigest: digest('e'),
    publishedAt: '2026-08-09T20:25:23.000Z',
  });
  assert.throws(() => createPublishedSiteReleaseConfig(current, options), /Missing release blockmap/u);
});
