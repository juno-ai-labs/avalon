import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertMinorReleaseVersion,
  assertNextMinorReleaseVersion,
  assertReleaseTag,
  compareVersions,
  normalizeReleasePrefix,
  parseMacUpdateFeed,
  releaseContentType,
  sha512File,
  verifyFeedArtifact,
} from './release-lib.mjs';

test('release tag must exactly match both package versions', () => {
  assert.equal(assertReleaseTag('v1.2.0', '1.2.0', '1.2.0'), '1.2.0');
  assert.throws(() => assertReleaseTag('1.2.0', '1.2.0', '1.2.0'), /v<semver>/u);
  assert.throws(() => assertReleaseTag('v1.2.0', '1.1.0', '1.2.0'), /Root package/u);
  assert.throws(() => assertReleaseTag('v1.2.0', '1.2.0', '1.1.0'), /Desktop package/u);
  assert.throws(() => assertReleaseTag('v1.2.1', '1.2.1', '1.2.1'), /patch 0/u);
  assert.throws(() => assertReleaseTag('v1.2.0-beta.1', '1.2.0-beta.1', '1.2.0-beta.1'), /stable minor/u);
});

test('release versions advance exactly one minor and reset patch to zero', () => {
  assert.equal(assertMinorReleaseVersion('0.2.0'), '0.2.0');
  assert.equal(assertNextMinorReleaseVersion('0.1.5', '0.2.0'), '0.2.0');
  assert.throws(() => assertNextMinorReleaseVersion('0.1.5', '0.1.6'), /patch 0/u);
  assert.throws(() => assertNextMinorReleaseVersion('0.1.5', '0.2.1'), /patch 0/u);
  assert.throws(() => assertNextMinorReleaseVersion('0.1.5', '0.3.0'), /must be 0\.2\.0/u);
  assert.throws(() => assertNextMinorReleaseVersion('0.1.5', '1.0.0'), /must be 0\.2\.0/u);
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
    files: [{ url: 'Avalon-1.2.3-mac-arm64.zip', sha512: 'YWJjZA==', size: 42 }],
    file: { url: 'Avalon-1.2.3-mac-arm64.zip', sha512: 'YWJjZA==', size: 42 },
  });
  assert.throws(
    () => parseMacUpdateFeed(`version: 1.2.3\nfiles:\n  - url: https://elsewhere.invalid/a.zip\n    sha512: YWJjZA==\n    size: 42\n`),
    /sibling artifact/u,
  );
});

test('release verification rejects stale metadata in a secondary feed file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-feed-verification-test-'));
  const zipName = 'Avalon-1.2.3-mac-arm64.zip';
  const dmgName = 'Avalon-1.2.3-mac-arm64.dmg';
  try {
    await Promise.all([
      writeFile(join(directory, zipName), 'zip bytes'),
      writeFile(join(directory, dmgName), 'final dmg bytes'),
    ]);
    const zipSha512 = await sha512File(join(directory, zipName));
    await assert.rejects(
      verifyFeedArtifact({
        directory,
        feed: {
          files: [
            { url: zipName, sha512: zipSha512, size: 9 },
            { url: dmgName, sha512: 'YWJjZA==', size: 15 },
          ],
        },
      }),
      /SHA-512 mismatch for Avalon-1\.2\.3-mac-arm64\.dmg/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release prefixes and content types are deterministic', () => {
  assert.equal(normalizeReleasePrefix('/stable/darwin/arm64/'), 'stable/darwin/arm64');
  assert.throws(() => normalizeReleasePrefix('../stable'), /Invalid release prefix/u);
  assert.equal(releaseContentType('Avalon.dmg'), 'application/x-apple-diskimage');
  assert.equal(releaseContentType('latest-mac.yml'), 'application/yaml; charset=utf-8');
});
