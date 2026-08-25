import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureInferenceLakehouse,
  loadInferenceLakehouseManifest,
} from './ensure-cloudflare-inference-lakehouse.mjs';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};
const userTokenId = 'a'.repeat(32);
const accountTokenId = 'b'.repeat(32);
const expectedR2SecretAccessKey = [
  '4c5dc9b7', '708905f7', '7f5e5d16', '316b5dfb',
  '425e68cb', '326dcd55', 'a860e90a', '7707031e',
].join('');

function accountDouble({ tokenOwner = 'user' } = {}) {
  const buckets = new Set();
  const catalogs = new Map();
  const entities = {
    streams: new Map(),
    sinks: new Map(),
    pipelines: new Map(),
  };
  const requests = [];
  let nextId = 1;
  let tokenId = tokenOwner === 'account' ? accountTokenId : userTokenId;

  const success = (result) => Response.json({ success: true, result });
  const missing = (code = 10006) => Response.json(
    { success: false, errors: [{ code, message: 'missing' }] },
    { status: 404 },
  );
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/client/v4/accounts/test-account', '');
    const method = init.method ?? 'GET';
    const request = {
      method,
      path,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    requests.push(request);

    if (url.pathname === '/client/v4/user/tokens/verify') {
      return success({ id: userTokenId, status: 'active' });
    }
    if (path === '/tokens/verify') {
      if (tokenOwner === 'user') {
        return Response.json(
          { success: false, errors: [{ code: 1000, message: 'user-owned token' }] },
          { status: 403 },
        );
      }
      return success({ id: tokenId, status: 'active' });
    }

    if (path === '/r2/buckets' && method === 'POST') {
      buckets.add(request.body.name);
      return success({ name: request.body.name });
    }
    const bucketMatch = path.match(/^\/r2\/buckets\/([^/]+)$/u);
    if (bucketMatch) {
      return buckets.has(bucketMatch[1]) ? success({ name: bucketMatch[1] }) : missing();
    }

    const catalogMatch = path.match(/^\/r2-catalog\/([^/]+)(\/enable)?$/u);
    if (catalogMatch) {
      const bucket = catalogMatch[1];
      if (catalogMatch[2] && method === 'POST') {
        catalogs.set(bucket, { name: `warehouse_${bucket}`, status: 'active' });
        return success(catalogs.get(bucket));
      }
      return catalogs.has(bucket) ? success(catalogs.get(bucket)) : missing(40401);
    }

    const entityMatch = path.match(/^\/pipelines\/v1\/(streams|sinks|pipelines)(?:\/([^/]+))?$/u);
    if (entityMatch) {
      const [, kind, id] = entityMatch;
      const store = entities[kind];
      if (id) return store.has(id) ? success(store.get(id)) : missing();
      if (method === 'POST') {
        const entity = { id: `${kind}-${nextId++}`, ...request.body };
        store.set(entity.id, entity);
        return success(entity);
      }
      const name = url.searchParams.get('name');
      return success([...store.values()].filter((entity) => !name || entity.name === name));
    }
    assert.fail(`unexpected Cloudflare request: ${method} ${path}`);
  };

  return {
    buckets,
    catalogs,
    entities,
    requests,
    fetchImpl,
    setTokenId(value) {
      tokenId = value;
    },
  };
}

test('an empty account is fully provisioned by one idempotent deploy preflight', async () => {
  const account = accountDouble();
  const outputDirectory = await mkdtemp(join(tmpdir(), 'avalon-lakehouse-test-'));
  try {
    const first = await ensureInferenceLakehouse({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
      materializeBindings: true,
      outputDirectory,
    });
    const createsAfterFirstRun = account.requests.filter((request) => request.method === 'POST');
    assert.equal(createsAfterFirstRun.length, 9);
    assert.deepEqual([...account.buckets].sort(), [
      'avalon-eu-inference-lakehouse',
      'avalon-global-inference-lakehouse',
    ]);
    assert.equal(account.entities.streams.size, 2);
    assert.equal(account.entities.sinks.size, 2);
    assert.equal(account.entities.pipelines.size, 2);

    assert.deepEqual([...account.catalogs.keys()], ['avalon-global-inference-lakehouse']);
    const euSink = [...account.entities.sinks.values()].find((sink) => sink.type === 'r2');
    assert.match(
      euSink.name,
      /^avalon_eu_inference_lakehouse_sink_credential_[a-f0-9]{64}$/u,
    );
    assert.equal(euSink.name.includes(userTokenId), false);
    assert.deepEqual(euSink, {
      id: euSink.id,
      name: euSink.name,
      type: 'r2',
      format: { type: 'parquet', compression: 'zstd' },
      config: {
        bucket: 'avalon-eu-inference-lakehouse',
        jurisdiction: 'eu',
        path: 'avalon/llm_inference',
        partitioning: { time_pattern: 'year=%Y/month=%m/day=%d/hour=%H' },
        credentials: {
          access_key_id: userTokenId,
          secret_access_key: expectedR2SecretAccessKey,
        },
        rolling_policy: { interval_seconds: 300 },
      },
    });
    const globalSink = [...account.entities.sinks.values()].find((sink) =>
      sink.type === 'r2_data_catalog');
    assert.equal(Object.hasOwn(globalSink.config, 'account_id'), false);

    const euResourceRequests = account.requests.filter((request) =>
      request.path.includes('avalon-eu-inference-lakehouse'));
    assert.ok(euResourceRequests.length > 0);
    assert.ok(euResourceRequests.every((request) => request.headers['cf-r2-jurisdiction'] === 'eu'));
    const globalResourceRequests = account.requests.filter((request) =>
      request.path.includes('avalon-global-inference-lakehouse'));
    assert.ok(globalResourceRequests.every((request) => request.headers['cf-r2-jurisdiction'] === undefined));

    const euConfig = JSON.parse(await readFile(first.configs.eu, 'utf8'));
    const globalConfig = JSON.parse(await readFile(first.configs.global, 'utf8'));
    assert.deepEqual(euConfig.pipelines, [{
      binding: 'INFERENCE_LAKEHOUSE',
      stream: first.resources.eu.stream.id,
    }]);
    assert.deepEqual(globalConfig.pipelines, [{
      binding: 'INFERENCE_LAKEHOUSE',
      stream: first.resources.global.stream.id,
    }]);
    assert.equal(euConfig.name, 'avalon-api-eu');
    assert.equal(globalConfig.name, 'avalon-api-global');

    await ensureInferenceLakehouse({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
    });
    assert.equal(account.requests.filter((request) => request.method === 'POST').length, createsAfterFirstRun.length);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('--check reports missing infrastructure without creating any resource', async () => {
  const account = accountDouble();
  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
      create: false,
    }),
    /Missing inference lakehouse R2 bucket: eu\/avalon-eu-inference-lakehouse/u,
  );
  assert.equal(account.requests.some((request) => request.method === 'POST'), false);
});

test('immutable stream drift stops deployment instead of silently splitting the schema', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const manifest = await loadInferenceLakehouseManifest();
  const euStream = [...account.entities.streams.values()].find((stream) =>
    stream.name === manifest.regions.eu.stream);
  euStream.schema = { fields: euStream.schema.fields.slice(0, -1) };

  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /schema drifted; Pipeline stream schemas are immutable/u,
  );
});

test('account-owned deployment tokens provision the direct R2 sink without a user token', async () => {
  const account = accountDouble({ tokenOwner: 'account' });
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const euSink = [...account.entities.sinks.values()].find((sink) => sink.type === 'r2');
  assert.equal(euSink.config.credentials.access_key_id, accountTokenId);
  assert.equal(account.requests[0].path, '/tokens/verify');
  assert.equal(account.requests.some((request) => request.path === '/user/tokens/verify'), false);
});

test('immutable EU sink drift stops deployment', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const euSink = [...account.entities.sinks.values()].find((sink) => sink.type === 'r2');
  euSink.config.jurisdiction = 'default';

  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /destination or rolling policy drifted; sinks are immutable/u,
  );

  euSink.config.jurisdiction = 'eu';
  euSink.config.account_id = 'different-account';
  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /destination or rolling policy drifted; sinks are immutable/u,
  );
});

test('deployment credential replacement stops before creating conflicting immutable sinks', async () => {
  const account = accountDouble({ tokenOwner: 'account' });
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  account.setTokenId('c'.repeat(32));

  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /uses a different deployment credential; sinks are immutable/u,
  );
  assert.equal(account.entities.sinks.size, 2);
});

test('the deploy provisions bindings before migration or Worker deployment', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  const provision = workflow.indexOf('Ensure both regional inference lakehouses and materialize bindings');
  const migrations = workflow.indexOf('List the pending remote migrations for EU');
  const deploy = workflow.indexOf('Deploy the EU Worker');
  assert.ok(provision > 0 && provision < migrations && migrations < deploy);
  assert.match(workflow, /wrangler deploy --config \.wrangler\.inference\.eu\.json/u);
  assert.match(workflow, /wrangler deploy --config \.wrangler\.inference\.global\.json/u);
});
