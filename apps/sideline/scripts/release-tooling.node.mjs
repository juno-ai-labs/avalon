import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sidelineMacFeedYaml } from './finalize-macos-release.mjs';
import { parseMacUpdateFeed } from '../../desktop/scripts/release-lib.mjs';

const sidelineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Sideline update feed is ZIP-primary and round-trips through the release parser', () => {
  const feed = sidelineMacFeedYaml({
    version: '0.1.0',
    date: '2026-09-21T00:00:00.000Z',
    files: [
      { url: 'Sideline-0.1.0-mac-arm64.zip', sha512: 'YWJj', size: 12 },
      { url: 'Sideline-0.1.0-mac-arm64.dmg', sha512: 'ZGVm', size: 34 },
    ],
  });
  const parsed = parseMacUpdateFeed(feed);
  assert.equal(parsed.version, '0.1.0');
  assert.equal(parsed.file.url, 'Sideline-0.1.0-mac-arm64.zip');
  assert.equal(parsed.files[1].url, 'Sideline-0.1.0-mac-arm64.dmg');
});

test('Sideline update feed rejects artifact paths', () => {
  assert.throws(() => sidelineMacFeedYaml({
    version: '0.1.0',
    date: '2026-09-21T00:00:00.000Z',
    files: [
      { url: '../Sideline.zip', sha512: 'YWJj', size: 12 },
      { url: 'Sideline.dmg', sha512: 'ZGVm', size: 34 },
    ],
  }), /invalid artifact/u);
});

test('packaging embeds the Sideline identity and its disjoint R2 update prefix', async () => {
  const config = await readFile(resolve(sidelineDirectory, 'electron-builder.yml'), 'utf8');
  assert.match(config, /^appId: ai\.rallywith\.sideline$/mu);
  assert.match(config, /^\s*icon: resources\/icon\.icns$/mu);
  assert.doesNotMatch(config, /desktop\/resources\/icon\.icns/u);
  assert.match(config, /^\s*url: https:\/\/downloads\.rallywith\.ai\/sideline\/stable\/darwin\/arm64$/mu);
  assert.match(config, /^\s*schemes:\n\s*- sideline$/mu);
  assert.doesNotMatch(
    config,
    /^\s*url: https:\/\/downloads\.rallywith\.ai\/stable\/darwin\/arm64$/mu,
    'feed must be nested below the Sideline prefix',
  );
});

test('the release workflow reuses the desktop trust boundary but not its public channel', async () => {
  const workflow = await readFile(resolve(sidelineDirectory, '../../.github/workflows/release-sideline-macos.yml'), 'utf8');
  assert.match(workflow, /^\s*environment: desktop-release$/mu);
  assert.match(workflow, /SIDELINE_RELEASE_R2_BUCKET:.*RALLY_RELEASE_R2_BUCKET/u);
  assert.match(workflow, /SIDELINE_RELEASE_PREFIX: sideline\/stable\/darwin\/arm64/u);
  assert.match(workflow, /pnpm --filter @rally\/sideline package:release/u);
  assert.match(workflow, /pnpm --filter @rally\/sideline release:publish/u);
  assert.ok(
    workflow.indexOf('release:publish') < workflow.lastIndexOf('git push origin'),
    'the tag must be pushed only after R2 publication succeeds',
  );
  assert.doesNotMatch(workflow, /RALLY_MAC_PROVISIONING_PROFILE/u);
});

test('the release workflow rebuilds Sideline when an installed-app input changes', async () => {
  const workflow = await readFile(resolve(sidelineDirectory, '../../.github/workflows/release-sideline-macos.yml'), 'utf8');
  assert.match(workflow, /^[ ]{2}push:\n[ ]{4}branches:\n[ ]{6}- main$/mu);
  for (const path of [
    "'apps/sideline/**'",
    "'apps/desktop/scripts/release-lib.mjs'",
    "'packages/contracts/**'",
    "'packages/ui/**'",
    "'pnpm-lock.yaml'",
  ]) {
    assert.match(workflow, new RegExp(`^[ ]{6}- ${path.replaceAll('*', '\\*')}$`, 'mu'));
  }
  assert.match(workflow, /^[ ]{2}queue: single$/mu);
  assert.match(workflow, /node apps\/sideline\/scripts\/stamp-release\.mjs/u);
  assert.match(workflow, /fetch-depth: 0\n[ ]{10}ref: main\n[ ]{10}persist-credentials: true/u);
  assert.match(workflow, /should_release: \$\{\{ steps\.stamp\.outputs\.should_release \}\}/u);
  assert.match(workflow, /api_deployment_ref: \$\{\{ steps\.stamp\.outputs\.api_deployment_ref \}\}/u);
  assert.match(workflow, /if: steps\.stamp\.outputs\.should_release == 'true' && steps\.stamp\.outputs\.requires_api_deploy == 'true'/u);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.commit \}\}/u);
  assert.match(workflow, /if: needs\.verify\.outputs\.should_release == 'true'/u);
  assert.match(workflow, /actions\/workflows\/deploy-api\.yml\/runs/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$SIDELINE_API_DEPLOYMENT_REF" "\$candidate_sha"/u);
  assert.doesNotMatch(workflow, /--commit "\$SIDELINE_API_DEPLOYMENT_REF"/u);
  assert.match(workflow, /gh run watch "\$run_id".*--exit-status/u);
  assert.ok(
    workflow.lastIndexOf('already exists; refusing') < workflow.indexOf('release:publish'),
    'the remote tag must be checked immediately before publication',
  );
});
