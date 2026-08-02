import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertReleaseTag,
  compareVersions,
  normalizeReleasePrefix,
  parseMacUpdateFeed,
  releaseContentType,
} from './release-lib.mjs';

test('release tag must exactly match both package versions', () => {
  assert.equal(assertReleaseTag('v1.2.3-beta.1', '1.2.3-beta.1', '1.2.3-beta.1'), '1.2.3-beta.1');
  assert.throws(() => assertReleaseTag('1.2.3', '1.2.3', '1.2.3'), /v<semver>/u);
  assert.throws(() => assertReleaseTag('v1.2.3', '1.2.2', '1.2.3'), /Root package/u);
  assert.throws(() => assertReleaseTag('v1.2.3', '1.2.3', '1.2.2'), /Desktop package/u);
});

test('semantic versions compare with prerelease precedence', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.10'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3-rc.1'), 1);
});

test('mac update feed parser requires a local checksummed artifact', () => {
  const feed = parseMacUpdateFeed(`version: 1.2.3\nfiles:\n  - url: Avalon-1.2.3-mac-arm64.zip\n    sha512: YWJjZA==\n    size: 42\npath: Avalon-1.2.3-mac-arm64.zip\n`);
  assert.deepEqual(feed, {
    version: '1.2.3',
    file: { url: 'Avalon-1.2.3-mac-arm64.zip', sha512: 'YWJjZA==', size: 42 },
  });
  assert.throws(
    () => parseMacUpdateFeed(`version: 1.2.3\nfiles:\n  - url: https://elsewhere.invalid/a.zip\n    sha512: YWJjZA==\n    size: 42\n`),
    /sibling artifact/u,
  );
});

test('release prefixes and content types are deterministic', () => {
  assert.equal(normalizeReleasePrefix('/stable/darwin/arm64/'), 'stable/darwin/arm64');
  assert.throws(() => normalizeReleasePrefix('../stable'), /Invalid release prefix/u);
  assert.equal(releaseContentType('Avalon.dmg'), 'application/x-apple-diskimage');
  assert.equal(releaseContentType('latest-mac.yml'), 'application/yaml; charset=utf-8');
});
