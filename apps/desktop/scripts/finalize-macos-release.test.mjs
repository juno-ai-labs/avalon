import assert from 'node:assert/strict';
import test from 'node:test';

import { macFeedYaml, selectDeveloperIdIdentity } from './finalize-macos-release.mjs';
import { parseMacUpdateFeed } from './release-lib.mjs';

const IDENTITIES = `
  1) 642062832487A93FF44B46D449EFB750F4AE1216 "Developer ID Application: Pay Tgthr, Inc (2ZG8V3KUG2)"
  2) D3C743867424ACED012930551258595C06F93BB0 "Developer ID Application: Juno AI Labs Inc. (7ZLT6A8W25)"
     2 valid identities found
`;

test('DMG signing selects only Avalon pinned Developer ID identity', () => {
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

test('post-build update feed is ZIP-primary and contains the final ZIP hash and size', () => {
  const yaml = macFeedYaml({
    version: '1.2.3',
    zipName: 'Avalon-1.2.3-mac-arm64.zip',
    sha512: 'YWJjZA==',
    size: 42,
    date: '2026-08-02T00:00:00.000Z',
  });
  assert.deepEqual(parseMacUpdateFeed(yaml), {
    version: '1.2.3',
    file: { url: 'Avalon-1.2.3-mac-arm64.zip', sha512: 'YWJjZA==', size: 42 },
  });
  assert.match(yaml, /^path: "Avalon-1\.2\.3-mac-arm64\.zip"$/mu);
  assert.match(yaml, /^releaseDate: "2026-08-02T00:00:00\.000Z"$/mu);
});
