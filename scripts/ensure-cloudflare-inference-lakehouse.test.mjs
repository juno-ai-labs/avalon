import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  accountFingerprint,
  deployLakehouseBindings,
  loadAnalyticsLakehouseManifest,
  loadEngineeringAuditLakehouseManifest,
  loadInferenceLakehouseManifest,
  loadUsageLakehouseManifest,
} from './ensure-cloudflare-inference-lakehouse.mjs';

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

/** The checked-in manifests, with the API Worker's pinned for `this-account`. */
async function checkedInManifests({ auditStreamId } = {}) {
  const pinnedAccount = accountFingerprint(environment.CLOUDFLARE_ACCOUNT_ID);
  const api = (await Promise.all([
    loadInferenceLakehouseManifest(), loadAnalyticsLakehouseManifest(), loadUsageLakehouseManifest(),
  ])).map((manifest) => ({ ...manifest, pinnedAccount }));
  const audit = await loadEngineeringAuditLakehouseManifest();
  if (auditStreamId) {
    audit.pinnedAccount = pinnedAccount;
    audit.regions = { global: { ...audit.regions.global, streamId: auditStreamId } };
  }
  return { api, audit };
}

async function deployInto(directory, manifests, reconciled) {
  return deployLakehouseBindings({
    environment, manifests, log: () => {}, writeManifests: false, outputDirectory: directory,
    fetchImpl: async () => { throw new Error('the pinned account needs no control-plane read'); },
    reconcile: async (options) => {
      reconciled.push(options.manifests.map(({ binding }) => binding));
      return { provisioned: options.manifests.map((manifest) => ({
        manifest: { ...manifest, regions: { global: { ...manifest.regions.global, streamId: 'a'.repeat(32) } } },
      })) };
    },
  });
}

test('provisions a new lakehouse in the pinned account, alone, and keeps another Worker\'s binding out of the API config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lakehouse-bindings-'));
  try {
    const { api, audit } = await checkedInManifests();
    const reconciled = [];
    const { manifests } = await deployInto(directory, [...api, audit], reconciled);

    assert.deepEqual(reconciled, [['ENGINEERING_AUDIT_LAKEHOUSE']]);
    assert.deepEqual(manifests.map(({ binding }) => binding), ['INFERENCE_LAKEHOUSE', 'ANALYTICS_LAKEHOUSE', 'USAGE_LAKEHOUSE']);
    const config = JSON.parse(await readFile(join(directory, '.wrangler.lakehouses.global.json'), 'utf8'));
    assert.deepEqual(config.pipelines.map(({ binding }) => binding), ['INFERENCE_LAKEHOUSE', 'ANALYTICS_LAKEHOUSE', 'USAGE_LAKEHOUSE']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconciles nothing once every lakehouse is pinned for this account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lakehouse-bindings-'));
  try {
    const { api, audit } = await checkedInManifests({ auditStreamId: 'b'.repeat(32) });
    const reconciled = [];
    await deployInto(directory, [...api, audit], reconciled);

    assert.deepEqual(reconciled, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
