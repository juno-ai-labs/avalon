import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pinStorageIds, storageFromWrangler } from './ensure-cloudflare-d1-kv.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const config = `{
  "d1_databases": [
    {
      // The usage ledger, apart from DB.
      "binding": "USAGE_DB",
      "database_name": "avalon-global-usage",
      "database_id": "fb6235ab-8856-44c0-afc0-04deb6dc62e0",
      "migrations_dir": "../../packages/db/usage-migrations"
    },
    { "binding": "PLATFORM_DB", "database_name": "rally-platform" }
  ],
  "vars": { "DOCS_URL": "https://example.test/a//b" },
  "kv_namespaces": [
    { "binding": "FAVICON_CACHE" },
    { "binding": "INFERENCE_PRICING_CACHE", "id": "ea2442c2ee744decbad3d1ca03fce728" }
  ]
}`;

test('pins the account ids into a Wrangler file, keeping comments, URLs and unpinned bindings', () => {
  const pinned = pinStorageIds(config, {
    databases: { 'avalon-global-usage': '11111111-1111-1111-1111-111111111111', 'rally-platform': '22222222-2222-2222-2222-222222222222' },
    namespaces: { INFERENCE_PRICING_CACHE: 'ffffffffffffffffffffffffffffffff', FAVICON_CACHE: 'should-not-appear' },
  });
  const parsed = parseWranglerConfig(pinned);
  assert.deepEqual(parsed.d1_databases.map((database) => database.database_id), [
    '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  ]);
  assert.equal(parsed.d1_databases[0].migrations_dir, '../../packages/db/usage-migrations');
  assert.deepEqual(parsed.kv_namespaces, [
    { binding: 'FAVICON_CACHE' },
    { binding: 'INFERENCE_PRICING_CACHE', id: 'ffffffffffffffffffffffffffffffff' },
  ]);
  assert.equal(parsed.vars.DOCS_URL, 'https://example.test/a//b');
  assert.match(pinned, /\/\/ The usage ledger, apart from DB\./u);
});

test('leaves a file whose ids already match byte for byte unchanged', () => {
  const same = pinStorageIds(config, {
    databases: { 'avalon-global-usage': 'fb6235ab-8856-44c0-afc0-04deb6dc62e0' },
    namespaces: { INFERENCE_PRICING_CACHE: 'ea2442c2ee744decbad3d1ca03fce728' },
  });
  assert.equal(same, config);
});

test('declares only D1 databases and KV namespaces that carry an id', () => {
  assert.deepEqual(storageFromWrangler(config, 'test'), {
    databases: [
      { name: 'avalon-global-usage', id: 'fb6235ab-8856-44c0-afc0-04deb6dc62e0' },
      { name: 'rally-platform', id: null },
    ],
    namespaces: [{ title: 'INFERENCE_PRICING_CACHE', id: 'ea2442c2ee744decbad3d1ca03fce728' }],
  });
});
