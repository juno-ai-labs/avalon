import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { changedPathsSince, selectApiDeployMode } from './select-api-deploy-mode.mjs';

const execFile = promisify(execFileCallback);

async function commitFile(directory, path, contents, message) {
  const absolutePath = join(directory, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
  await execFile('git', ['add', path], { cwd: directory });
  await execFile('git', ['commit', '-m', message], { cwd: directory });
  return (await execFile('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
}

async function testRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-api-deploy-mode-'));
  await execFile('git', ['init', '--initial-branch=main'], { cwd: directory });
  await execFile('git', ['config', 'user.email', 'deploy-test@rally.local'], { cwd: directory });
  await execFile('git', ['config', 'user.name', 'Rally deploy test'], { cwd: directory });
  const baseSha = await commitFile(directory, 'README.md', 'base\n', 'base');
  return { directory, baseSha };
}

test('uses an atomic version upload for an ordinary Worker release', () => {
  assert.deepEqual(selectApiDeployMode({
    deployedShas: ['abc123', 'abc123'],
    changedPaths: ['apps/api/src/index.ts', 'packages/contracts/src/index.ts'],
  }), {
    mode: 'versioned',
    reason: 'the release changes only Worker version content and version-compatible bindings',
  });
});

test('uses a direct deployment while active regional revisions are unknown or divergent', () => {
  assert.equal(selectApiDeployMode({
    deployedShas: [null, 'abc123'],
    changedPaths: [],
  }).mode, 'direct');
  assert.equal(selectApiDeployMode({
    deployedShas: ['abc123', 'def456'],
    changedPaths: [],
  }).mode, 'direct');
});

test('uses Wrangler direct deployment for platform state its Versions API cannot apply', () => {
  for (const changedPath of [
    'apps/api/wrangler.eu.jsonc',
    'apps/api/wrangler.global.jsonc',
    'apps/api/wrangler.documents.eu.jsonc',
    'apps/api/wrangler.documents.global.jsonc',
    'apps/api/wrangler.terminal.eu.jsonc',
    'apps/api/wrangler.terminal.global.jsonc',
    'apps/api/crash-symbolicator/src/index.js',
  ]) {
    const result = selectApiDeployMode({
      deployedShas: ['abc123', 'abc123'],
      changedPaths: [changedPath],
    });
    assert.equal(result.mode, 'direct', changedPath);
  }
});

test('an ancestor rollback compares deployed and target trees in both directions', async () => {
  const { directory, baseSha } = await testRepository();
  try {
    const deployedSha = await commitFile(
      directory,
      'apps/api/wrangler.global.jsonc',
      '{ "name": "changed" }\n',
      'change platform state',
    );
    await execFile('git', ['checkout', '--detach', baseSha], { cwd: directory });

    const changedPaths = await changedPathsSince(directory, deployedSha);
    assert.ok(changedPaths.includes('apps/api/wrangler.global.jsonc'));
    assert.equal(selectApiDeployMode({
      deployedShas: [deployedSha],
      changedPaths,
    }).mode, 'direct');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a divergent target sees platform state changed only on the deployed side', async () => {
  const { directory, baseSha } = await testRepository();
  try {
    await execFile('git', ['checkout', '-b', 'deployed'], { cwd: directory });
    const deployedSha = await commitFile(
      directory,
      'apps/api/wrangler.terminal.eu.jsonc',
      '{ "name": "deployed" }\n',
      'deployed platform state',
    );
    await execFile('git', ['checkout', '-b', 'target', baseSha], { cwd: directory });
    await commitFile(directory, 'apps/api/src/index.ts', 'export default {};\n', 'target code');

    const changedPaths = await changedPathsSince(directory, deployedSha);
    assert.ok(changedPaths.includes('apps/api/wrangler.terminal.eu.jsonc'));
    assert.equal(selectApiDeployMode({
      deployedShas: [deployedSha],
      changedPaths,
    }).mode, 'direct');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
