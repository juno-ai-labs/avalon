import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodePreparedReleasePublication,
  parsePreparedReleasePublication,
  planReleasePointerPublication,
} from './release-publication.mjs';

function manifest(version) {
  return Buffer.from([
    `version: ${version}`,
    'files:',
    `  - url: Rally-${version}-arm64-mac.zip`,
    '    sha512: YWJjZA==',
    '    size: 4',
    '',
  ].join('\n'));
}

function publicationOptions(version) {
  const names = [
    `Rally-${version}-arm64.dmg`,
    `Rally-${version}-arm64.dmg.blockmap`,
    `Rally-${version}-arm64-mac.zip`,
    `Rally-${version}-arm64-mac.zip.blockmap`,
  ];
  const sha256 = Object.fromEntries(
    [...names, 'SHA256SUMS', 'Rally.dmg'].map((name, index) => [name, String(index).padStart(64, '0')]),
  );
  sha256['Rally.dmg'] = sha256[`Rally-${version}-arm64.dmg`];
  return {
    version,
    artifactNames: names,
    canonicalDmgFile: 'Rally.dmg',
    checksumsFile: 'SHA256SUMS',
    latestFile: 'latest-mac.yml',
    bucket: 'rally-desktop-releases',
    prefix: 'stable/darwin/arm64',
    downloadBaseUrl: 'https://downloads.rallywith.ai',
    sha256,
    commit: 'a'.repeat(40),
  };
}

test('the prepared publication receipt preserves exact manifest bytes and site inputs', () => {
  const manifestBytes = manifest('1.2.0');
  const options = publicationOptions('1.2.0');
  const parsed = parsePreparedReleasePublication(JSON.parse(
    encodePreparedReleasePublication({ manifestBytes, publicationOptions: options }),
  ));

  assert.equal(parsed.version, '1.2.0');
  assert.deepEqual(parsed.manifestBytes, manifestBytes);
  assert.deepEqual(parsed.publicationOptions, options);
});

test('rejects a Stable receipt ahead of its manifest before a publication plan exists', () => {
  assert.throws(() => planReleasePointerPublication({
    candidateManifestBytes: manifest('1.3.0'),
    currentSiteVersion: '1.2.0',
    fasterManifestBytes: manifest('1.2.0'),
    legacyManifestBytes: manifest('1.2.0'),
    now: Date.parse('2026-09-15T18:00:00Z'),
    stableManifestBytes: manifest('1.1.0'),
    stableReceipt: { version: '1.2.0', promotedAt: '2026-09-14T18:00:00Z' },
  }), /receipt 1\.2\.0 is ahead/u);
});

test('rejects an orphan Stable receipt before a publication plan exists', () => {
  assert.throws(() => planReleasePointerPublication({
    candidateManifestBytes: manifest('1.3.0'),
    currentSiteVersion: '1.2.0',
    fasterManifestBytes: manifest('1.2.0'),
    legacyManifestBytes: manifest('1.2.0'),
    now: Date.parse('2026-09-15T18:00:00Z'),
    stableManifestBytes: undefined,
    stableReceipt: { version: '1.2.0', promotedAt: '2026-09-14T18:00:00Z' },
  }), /receipt exists without a stable manifest/u);
});

test('a same-version retry may use the prepared manifest instead of rebuilt bytes', () => {
  const prepared = parsePreparedReleasePublication(JSON.parse(encodePreparedReleasePublication({
    manifestBytes: manifest('1.3.0'),
    publicationOptions: publicationOptions('1.3.0'),
  })));

  const plan = planReleasePointerPublication({
    candidateManifestBytes: prepared.manifestBytes,
    currentSiteVersion: '1.2.0',
    fasterManifestBytes: manifest('1.3.0'),
    legacyManifestBytes: manifest('1.3.0'),
    now: Date.parse('2026-09-15T18:00:00Z'),
    stableManifestBytes: manifest('1.2.0'),
    stableReceipt: { version: '1.2.0', promotedAt: '2026-09-15T17:00:00Z' },
  });

  assert.equal(plan.releaseIsCommitted, true);
  assert.equal(plan.stableDecision.reason, 'cooldown');
});
