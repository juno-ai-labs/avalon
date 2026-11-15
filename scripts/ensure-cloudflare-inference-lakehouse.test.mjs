import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deployLakehouseBindings } from './ensure-cloudflare-inference-lakehouse.mjs';

const environment = { CLOUDFLARE_ACCOUNT_ID: 'this-account', CLOUDFLARE_API_TOKEN: 'token' };
// Every configured region pins the same stream, whatever its name.
const regions = new Proxy({}, { get: () => ({ stream: 'inference_global', streamId: 'production-stream' }) });
const manifests = [{ binding: 'INFERENCE_LAKEHOUSE', pinnedAccount: 'sha256:another-account', regions }];

test('refuses to adopt new stream IDs when the pinned streams exist in this account', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(new URL(url).pathname);
    return Response.json({ success: true, result: { id: 'production-stream', name: 'inference_global' } });
  };
  await assert.rejects(
    deployLakehouseBindings({ environment, manifests, fetchImpl, log: () => {}, writeManifests: false }),
    /exists in this account, but its pinnedAccount is for another account/u,
  );
  assert.deepEqual(requested, ['/client/v4/accounts/this-account/pipelines/v1/streams/production-stream']);
});
