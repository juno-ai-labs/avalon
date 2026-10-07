import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  macFeedYaml,
  selectDeveloperIdIdentity,
  writeFinalMacFeed,
} from './finalize-macos-release.mjs';
import { parseMacUpdateFeed, sha512File } from './release-lib.mjs';

const IDENTITIES = `
  1) 642062832487A93FF44B46D449EFB750F4AE1216 "Developer ID Application: Pay Tgthr, Inc (2ZG8V3KUG2)"
  2) D3C743867424ACED012930551258595C06F93BB0 "Developer ID Application: Juno AI Labs Inc. (7ZLT6A8W25)"
     2 valid identities found
`;

test('DMG signing selects only Rally pinned Developer ID identity', () => {
  assert.deepEqual(selectDeveloperIdIdentity(IDENTITIES), {
    hash: 'D3C743867424ACED012930551258595C06F93BB0',
    name: 'Developer ID Application: Juno AI Labs Inc. (7ZLT6A8W25)',
  });
  assert.equal(
    selectDeveloperIdIdentity(IDENTITIES, 'Juno AI Labs Inc. (7ZLT6A8W25)').hash,
    'D3C743867424ACED012930551258595C06F93BB0',
  );
  assert.throws(
    () => selectDeveloperIdIdentity(IDENTITIES, 'Pay Tgthr, Inc (2ZG8V3KUG2)'),
    /found 0/u,
  );
});

test('post-build update feed is ZIP-primary and contains all final artifact metadata', () => {
  const yaml = macFeedYaml({
    version: '1.2.3',
    files: [
      { url: 'Rally-1.2.3-mac-arm64.zip', sha512: 'YWJjZA==', size: 42 },
      { url: 'Rally-1.2.3-mac-arm64.dmg', sha512: 'ZWZnaA==', size: 84 },
    ],
    date: '2026-08-02T00:00:00.000Z',
  });
  assert.deepEqual(parseMacUpdateFeed(yaml), {
    version: '1.2.3',
    files: [
      { url: 'Rally-1.2.3-mac-arm64.zip', sha512: 'YWJjZA==', size: 42 },
      { url: 'Rally-1.2.3-mac-arm64.dmg', sha512: 'ZWZnaA==', size: 84 },
    ],
    file: { url: 'Rally-1.2.3-mac-arm64.zip', sha512: 'YWJjZA==', size: 42 },
  });
  assert.match(yaml, /^path: "Rally-1\.2\.3-mac-arm64\.zip"$/mu);
  assert.match(yaml, /^releaseDate: "2026-08-02T00:00:00\.000Z"$/mu);
});

test('final feed rewrite replaces electron-builder metadata after its process exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-final-feed-test-'));
  const zipName = 'Rally-1.2.3-mac-arm64.zip';
  const dmgName = 'Rally-1.2.3-mac-arm64.dmg';
  try {
    await Promise.all([
      writeFile(join(directory, zipName), 'final zip bytes'),
      writeFile(join(directory, dmgName), 'signed, notarized, and stapled dmg bytes'),
      writeFile(join(directory, 'latest-mac.yml'), 'stale electron-builder metadata'),
    ]);
    await writeFinalMacFeed(directory, '1.2.3', { SOURCE_DATE_EPOCH: '1785628800' });
    const feed = parseMacUpdateFeed(await readFile(join(directory, 'latest-mac.yml'), 'utf8'));
    assert.deepEqual(feed.files, [
      {
        url: zipName,
        sha512: await sha512File(join(directory, zipName)),
        size: 15,
      },
      {
        url: dmgName,
        sha512: await sha512File(join(directory, dmgName)),
        size: 40,
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
