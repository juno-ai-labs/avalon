import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const promoterWorkflowPath = join(repositoryDirectory, '.github/workflows/promote-desktop-stable.yml');
const releaseWorkflowPath = join(repositoryDirectory, '.github/workflows/release-desktop-macos.yml');

test('Stable promotion runs hourly and can be dispatched manually', async () => {
  const workflow = await readFile(promoterWorkflowPath, 'utf8');

  assert.match(workflow, /^ {4}- cron: '17 \* \* \* \*'$/mu);
  assert.match(workflow, /^ {2}workflow_dispatch:$/mu);
  assert.match(workflow, /^ {4}environment: desktop-release$/mu);
  assert.match(workflow, /^ {8}run: pnpm --filter @rally\/desktop release:promote:stable$/mu);
});

test('the cron cannot evict a pending release and relies on the shared R2 lock', async () => {
  const [promoterWorkflow, releaseWorkflow, promoter] = await Promise.all([
    readFile(promoterWorkflowPath, 'utf8'),
    readFile(releaseWorkflowPath, 'utf8'),
    readFile(join(repositoryDirectory, 'apps/desktop/scripts/promote-stable-release.mjs'), 'utf8'),
  ]);

  assert.match(promoterWorkflow, /^ {2}group: desktop-stable-promotion$/mu);
  assert.match(promoterWorkflow, /^ {2}cancel-in-progress: false$/mu);
  assert.match(promoterWorkflow, /^ {2}queue: single$/mu);
  assert.doesNotMatch(promoterWorkflow, /group: desktop-macos-release/u);
  assert.match(releaseWorkflow, /^ {2}group: desktop-macos-release$/mu);
  assert.match(promoter, /withR2ReleaseLock\(\{/u);
  assert.match(promoter, /release-publish\.lock/u);
  assert.match(promoter, /strictCleanup: true/u);
  assert.doesNotMatch(promoter, /R2ReleaseLockHeldError/u);
});

test('the Stable promoter has read-only repository access and the release environment', async () => {
  const workflow = await readFile(promoterWorkflowPath, 'utf8');

  assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
  assert.doesNotMatch(workflow, /contents: write/u);
  for (const variable of [
    'RALLY_RELEASE_R2_BUCKET',
    'RALLY_RELEASE_BASE_URL',
    'RALLY_RELEASE_PREFIX',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_ZONE_ID',
    'CLOUDFLARE_API_TOKEN',
  ]) {
    assert.match(workflow, new RegExp(`^ {6}${variable}:`, 'mu'));
  }
});
