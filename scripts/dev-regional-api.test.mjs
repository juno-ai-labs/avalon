import assert from 'node:assert/strict';
import test from 'node:test';

import { regionalApiCommands, wranglerReadyLine } from './dev-regional-api.mjs';

test('starts the configured deployment with its service Workers', () => {
  const [global] = regionalApiCommands({ local: true });
  assert.equal(regionalApiCommands({ local: true }).length, 1);
  assert.equal(global.name, 'global');
  assert.ok(global.arguments.includes('wrangler.global.jsonc'));
  assert.ok(global.arguments.includes('wrangler.documents.global.jsonc'));
  assert.ok(global.arguments.includes('--local'));
  assert.equal(global.arguments[global.arguments.indexOf('--port') + 1], '8787');
  assert.ok(!regionalApiCommands({ local: false })[0].arguments.includes('--local'));
});

test('waits for Wrangler readiness rather than an incidental build line', () => {
  assert.equal(wranglerReadyLine('[wrangler:info] Ready on http://localhost:8787'), true);
  assert.equal(wranglerReadyLine('naming to docker.io/cloudflare-dev/image:tag done'), false);
  assert.equal(wranglerReadyLine('The following containers are available:'), false);
});
