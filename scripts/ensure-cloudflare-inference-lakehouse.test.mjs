import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertStreamsProvisioned,
  UNPROVISIONED_STREAM_ID,
} from './ensure-cloudflare-inference-lakehouse.mjs';

const manifest = (binding, streamId) => ({ binding, regions: { global: { streamId } } });

test('a deploy refuses a lakehouse whose stream has not been provisioned', () => {
  assert.throws(
    () => assertStreamsProvisioned([
      manifest('INFERENCE_LAKEHOUSE', '6d72907e685e47909e5bdd6e5f9063d6'),
      manifest('USAGE_LAKEHOUSE', UNPROVISIONED_STREAM_ID),
    ]),
    /USAGE_LAKEHOUSE has no provisioned global stream yet/u,
  );
});

test('a deploy accepts lakehouses whose streams are all pinned', () => {
  assert.doesNotThrow(() => assertStreamsProvisioned([
    manifest('INFERENCE_LAKEHOUSE', '6d72907e685e47909e5bdd6e5f9063d6'),
    manifest('USAGE_LAKEHOUSE', 'aa72907e685e47909e5bdd6e5f9063d6'),
  ]));
});
