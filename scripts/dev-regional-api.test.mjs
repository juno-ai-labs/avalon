import assert from 'node:assert/strict';
import test from 'node:test';

import { containerFreeConfig, regionalApiCommands, wranglerReadyLine } from './dev-regional-api.mjs';

test('starts the configured deployment with its service Workers', () => {
  const [global] = regionalApiCommands({ local: true });
  assert.equal(regionalApiCommands({ local: true }).length, 1);
  assert.equal(global.name, 'global');
  assert.ok(global.arguments.includes('wrangler.global.scratch.jsonc'));
  assert.ok(!global.arguments.includes('wrangler.global.jsonc'));
  assert.ok(global.arguments.includes('wrangler.documents.global.jsonc'));
  assert.ok(global.arguments.includes('--local'));
  assert.equal(global.arguments[global.arguments.indexOf('--port') + 1], '8787');
  const [remote] = regionalApiCommands({ local: false });
  assert.ok(!remote.arguments.includes('--local'));
  assert.ok(remote.arguments.includes('wrangler.global.jsonc'));
});

test('drops only the containers block from the local main config', () => {
  const source = `{
    // The symbolicator needs Docker to build.
    "name": "avalon-api-global",
    "vars": { "PUBLIC_API_BASE_URL": "https://api.example.com" },
    "containers": [{ "name": "symbolicator", "image": "./Dockerfile" }],
    "durable_objects": { "bindings": [{ "name": "SYMBOLICATOR", "class_name": "Symbolicator" }] },
  }`;
  assert.deepEqual(JSON.parse(containerFreeConfig(source)), {
    name: 'avalon-api-global',
    vars: { PUBLIC_API_BASE_URL: 'https://api.example.com' },
    durable_objects: { bindings: [{ name: 'SYMBOLICATOR', class_name: 'Symbolicator' }] },
  });
});

test('waits for Wrangler readiness rather than an incidental build line', () => {
  assert.equal(wranglerReadyLine('[wrangler:info] Ready on http://localhost:8787'), true);
  assert.equal(wranglerReadyLine('naming to docker.io/cloudflare-dev/image:tag done'), false);
  assert.equal(wranglerReadyLine('The following containers are available:'), false);
});
