import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applySidelineReleaseVersion } from './apply-release-version.mjs';
import {
  latestContractCommit,
  nextPatchVersion,
  planFromHead,
  planSidelineRelease,
  sidelineReleaseInputPaths,
} from './plan-release.mjs';

function git(directory, args) {
  return execFileSync('/usr/bin/git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('Sideline release inputs include the app, shared source, and release foundations', () => {
  assert.deepEqual(sidelineReleaseInputPaths([
    'apps/sideline/src/main/index.ts',
    'packages/ui/src/components/sideline-composer.tsx',
    'packages/contracts/src/impersonation.ts',
    'apps/desktop/scripts/release-lib.mjs',
    'apps/desktop/scripts/plan-release.mjs',
    'pnpm-lock.yaml',
    'apps/api/src/routes/sideline.ts',
    'docs/impersonation.md',
  ]), [
    'apps/sideline/src/main/index.ts',
    'packages/ui/src/components/sideline-composer.tsx',
    'packages/contracts/src/impersonation.ts',
    'apps/desktop/scripts/release-lib.mjs',
    'pnpm-lock.yaml',
  ]);
});

test('the first automatic release keeps the declared version', () => {
  const plan = planSidelineRelease({
    headSha: 'first',
    manifestVersion: '0.1.0',
    latestTag: undefined,
    changedPaths: [],
  });
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '0.1.0');
  assert.equal(plan.tag, 'sideline-v0.1.0');
  assert.equal(plan.requiresApiDeploy, true);
  assert.equal(plan.apiDeploymentRef, 'first');
});

test('a relevant change advances one patch after the published watermark', () => {
  const plan = planSidelineRelease({
    headSha: 'next',
    manifestVersion: '0.1.0',
    latestTag: 'sideline-v0.1.0',
    changedPaths: ['packages/ui/src/styles/app.css'],
  });
  assert.equal(nextPatchVersion('0.1.0'), '0.1.1');
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '0.1.1');
  assert.equal(plan.requiresApiDeploy, false);
});

test('a shared-contract change waits for the deployment of its newest contract commit', () => {
  const plan = planSidelineRelease({
    headSha: 'release-tip',
    manifestVersion: '0.1.0',
    latestTag: 'sideline-v0.1.0',
    changedPaths: ['packages/contracts/src/impersonation.ts'],
    apiDeploymentRef: 'contract-commit',
  });
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.requiresApiDeploy, true);
  assert.equal(plan.apiDeploymentRef, 'contract-commit');
});

test('the API deployment ref is the main-line merge that introduced a second-parent contract change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sideline-contract-merge-'));
  try {
    git(directory, ['init', '--initial-branch=main']);
    git(directory, ['config', 'user.name', 'Sideline Release Test']);
    git(directory, ['config', 'user.email', 'sideline-release-test@example.com']);
    await mkdir(join(directory, 'apps/sideline'), { recursive: true });
    await mkdir(join(directory, 'packages/contracts'), { recursive: true });
    await writeFile(join(directory, 'apps/sideline/package.json'), '{"version":"0.1.5"}\n');
    await writeFile(join(directory, 'packages/contracts/schema.ts'), 'export const version = 1;\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'Add contract']);
    git(directory, ['tag', 'sideline-v0.1.5']);

    git(directory, ['switch', '-c', 'feature']);
    await writeFile(join(directory, 'packages/contracts/schema.ts'), 'export const version = 2;\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'Change contract on feature branch']);

    git(directory, ['switch', 'main']);
    await writeFile(join(directory, 'README.md'), 'main-line change\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'Advance main']);
    git(directory, ['merge', '--no-ff', 'feature', '-m', 'Merge contract change']);
    const mergeSha = git(directory, ['rev-parse', 'HEAD']);

    assert.equal(latestContractCommit(mergeSha, directory), mergeSha);
    const plan = await planFromHead(directory);
    assert.equal(plan.shouldRelease, true);
    assert.equal(plan.ref, mergeSha);
    assert.equal(plan.version, '0.1.6');
    assert.equal(plan.requiresApiDeploy, true);
    assert.equal(plan.apiDeploymentRef, mergeSha);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a stale queued run skips when no release input changed after the tag', () => {
  const plan = planSidelineRelease({
    headSha: 'same-tree',
    manifestVersion: '0.1.1',
    latestTag: 'sideline-v0.1.1',
    changedPaths: ['docs/impersonation.md'],
  });
  assert.equal(plan.shouldRelease, false);
  assert.equal(plan.requiresApiDeploy, false);
});

test('an untagged bumped manifest resumes the same release version', () => {
  const plan = planSidelineRelease({
    headSha: 'retry',
    manifestVersion: '0.1.1',
    latestTag: 'sideline-v0.1.0',
    changedPaths: ['apps/sideline/package.json'],
  });
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '0.1.1');
});

test('the version writer changes only Sideline manifest version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sideline-version-'));
  const manifest = join(directory, 'package.json');
  try {
    await writeFile(manifest, '{\n  "name": "@rally/sideline",\n  "version": "0.1.0",\n  "private": true\n}\n');
    const result = await applySidelineReleaseVersion('0.1.1', manifest);
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), {
      name: '@rally/sideline',
      version: '0.1.1',
      private: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
