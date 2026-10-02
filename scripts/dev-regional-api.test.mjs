import assert from 'node:assert/strict';
import test from 'node:test';

import { wranglerReadyLine } from './dev-regional-api.mjs';

test('waits for Wrangler readiness rather than an incidental build line', () => {
  assert.equal(wranglerReadyLine('[wrangler:info] Ready on http://localhost:8787'), true);
  assert.equal(wranglerReadyLine('naming to docker.io/cloudflare-dev/image:tag done'), false);
  assert.equal(wranglerReadyLine('The following containers are available:'), false);
});
