import assert from 'node:assert/strict';
import test from 'node:test';

import { selectApiDeployMode } from './select-api-deploy-mode.mjs';

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
