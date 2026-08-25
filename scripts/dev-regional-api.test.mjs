import assert from 'node:assert/strict';
import test from 'node:test';

import { regionalApiCommands, wranglerReadyLine } from './dev-regional-api.mjs';

test('starts Global before EU so Wrangler Container image builds cannot race', () => {
  assert.deepEqual(regionalApiCommands({ local: true }), [
    {
      name: 'global',
      arguments: ['--filter', '@rally/api', 'dev:local'],
    },
    {
      name: 'eu',
      arguments: ['--filter', '@rally/api', 'dev:local:eu'],
    },
  ]);
  assert.deepEqual(regionalApiCommands({ local: false }), [
    {
      name: 'global',
      arguments: ['--filter', '@rally/api', 'dev'],
    },
    {
      name: 'eu',
      arguments: ['--filter', '@rally/api', 'dev:eu'],
    },
  ]);
});

test('waits for Wrangler readiness rather than an incidental build line', () => {
  assert.equal(wranglerReadyLine('[wrangler:info] Ready on http://localhost:8787'), true);
  assert.equal(wranglerReadyLine('naming to docker.io/cloudflare-dev/image:tag done'), false);
  assert.equal(wranglerReadyLine('The following containers are available:'), false);
});
