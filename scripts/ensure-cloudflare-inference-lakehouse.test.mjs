import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CLOUDFLARE_GET_MAX_ATTEMPTS,
  ensureCloudflareLakehouses,
  ensureInferenceLakehouse,
  loadAnalyticsLakehouseManifest,
  loadInferenceLakehouseManifest,
  materializePinnedLakehouseWranglerConfigs,
  parseLakehouseMode,
} from './ensure-cloudflare-inference-lakehouse.mjs';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};
const tenAttemptRetryDelays = [
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  8_000,
  8_000,
  8_000,
  8_000,
];
const userTokenId = 'a'.repeat(32);
const accountTokenId = 'b'.repeat(32);
const checkedInManifests = await Promise.all([
  loadInferenceLakehouseManifest(),
  loadAnalyticsLakehouseManifest(),
]);
const checkedInStreamIdByName = new Map(checkedInManifests.map((manifest) => [
  manifest.regions.global.stream,
  manifest.regions.global.streamId,
]));
function accountDouble({
  tokenOwner = 'account',
  createdStreamIdByName = checkedInStreamIdByName,
} = {}) {
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
    const path = url.pathname
      .replace('/client/v4/accounts/test-account', '')
      .replace('/client/v4', '');
    const method = init.method ?? 'GET';
    const request = {
      method,
      path,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    requests.push(request);

    if (path === '/user/tokens/verify') {
      return success({
        id: tokenOwner === 'user' ? tokenId : userTokenId,
        status: 'active',
      });
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
        const pinnedStreamId = kind === 'streams'
          ? createdStreamIdByName.get(request.body.name)
          : undefined;
        const generatedId = (nextId++).toString(16).padStart(32, '0');
        const entity = { id: pinnedStreamId ?? generatedId, ...request.body };
        store.set(entity.id, entity);
        return success(entity);
      }
      const name = url.searchParams.get('name');
      // Cloudflare documents Pipeline list name filters as case-insensitive
      // substring matches; production applies its own exact-name check.
      return success([...store.values()].filter((entity) =>
        !name || entity.name.toLowerCase().includes(name.toLowerCase())));
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

test('transient Cloudflare GET failures recover before the ten-attempt ceiling', async () => {
  const account = accountDouble();
  const retryDelays = [];
  const retryLogs = [];
  let streamListAttempts = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if ((init.method ?? 'GET') === 'GET'
      && url.pathname.endsWith('/pipelines/v1/streams')
      && streamListAttempts++ < 2) {
      return Response.json(
        { success: false, errors: [{ code: 500, message: 'Internal Server Error' }] },
        { status: 500, headers: { 'cf-ray': `retry-ray-${streamListAttempts}` } },
      );
    }
    return account.fetchImpl(input, init);
  };

  await ensureInferenceLakehouse({
    environment,
    fetchImpl,
    log: (message) => retryLogs.push(message),
    randomImpl: () => 0,
    waitImpl: async (milliseconds) => retryDelays.push(milliseconds),
  });

  assert.equal(CLOUDFLARE_GET_MAX_ATTEMPTS, 10);
  assert.equal(streamListAttempts, 3);
  assert.deepEqual(retryDelays, [500, 1_000]);
  const retryMessages = retryLogs.filter((message) => message.includes('retrying'));
  assert.match(retryMessages[0], /cf-ray: retry-ray-1.*retrying attempt 2\/10 in 500 ms/u);
  assert.match(retryMessages[1], /cf-ray: retry-ray-2.*retrying attempt 3\/10 in 1000 ms/u);
});

test('Cloudflare retry directives and Retry-After override GET status defaults', async () => {
  const account = accountDouble();
  const retryDelays = [];
  let streamListAttempts = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if ((init.method ?? 'GET') === 'GET'
      && url.pathname.endsWith('/pipelines/v1/streams')) {
      streamListAttempts += 1;
      if (streamListAttempts === 1) {
        return Response.json(
          { success: false, errors: [{ code: 400, message: 'retry this read' }] },
          {
            status: 400,
            headers: {
              'retry-after': '1.5',
              'x-should-retry': 'true',
            },
          },
        );
      }
      return Response.json(
        { success: false, errors: [{ code: 500, message: 'do not retry this read' }] },
        {
          status: 500,
          headers: {
            'cf-ray': 'provider-stopped-retry-ray',
            'x-should-retry': 'false',
          },
        },
      );
    }
    return account.fetchImpl(input, init);
  };

  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl,
      log: () => {},
      randomImpl: () => 0,
      waitImpl: async (milliseconds) => retryDelays.push(milliseconds),
    }),
    /HTTP 500.*cf-ray: provider-stopped-retry-ray/u,
  );
  assert.equal(streamListAttempts, 2);
  assert.deepEqual(retryDelays, [1_500]);
});

test('persistent Cloudflare GET failures surface the final Ray ID after ten attempts', async () => {
  const retryDelays = [];
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return Response.json(
      { success: false, errors: [{ code: 500, message: 'Internal Server Error' }] },
      { status: 500, headers: { 'cf-ray': `persistent-ray-${attempts}` } },
    );
  };

  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl,
      log: () => {},
      randomImpl: () => 0,
      waitImpl: async (milliseconds) => retryDelays.push(milliseconds),
    }),
    /HTTP 500.*cf-ray: persistent-ray-10/u,
  );
  assert.equal(attempts, 10);
  assert.deepEqual(retryDelays, tenAttemptRetryDelays);
});

test('connection failures get exactly ten total attempts', async () => {
  const retryDelays = [];
  const retryLogs = [];
  let attempts = 0;

  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError('connection failed');
      },
      log: (message) => retryLogs.push(message),
      randomImpl: () => 0,
      waitImpl: async (milliseconds) => retryDelays.push(milliseconds),
    }),
    /connection failed/u,
  );

  assert.equal(attempts, 10);
  assert.deepEqual(retryDelays, tenAttemptRetryDelays);
  assert.equal(retryLogs.length, 9);
  assert.match(retryLogs.at(-1), /retrying attempt 10\/10 in 8000 ms/u);
});

test('mutating Cloudflare requests are never retried', async () => {
  const account = accountDouble();
  const retryDelays = [];
  let bucketCreateAttempts = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (init.method === 'POST' && url.pathname.endsWith('/r2/buckets')) {
      bucketCreateAttempts += 1;
      return Response.json(
        { success: false, errors: [{ code: 500, message: 'Internal Server Error' }] },
        { status: 500 },
      );
    }
    return account.fetchImpl(input, init);
  };

  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl,
      log: () => {},
      randomImpl: () => 0,
      waitImpl: async (milliseconds) => retryDelays.push(milliseconds),
    }),
    /Cloudflare POST .*\/r2\/buckets failed with HTTP 500/u,
  );
  assert.equal(bucketCreateAttempts, 1);
  assert.deepEqual(retryDelays, []);
});

test('an empty account creates every stream before one reviewed pin update completes reconciliation', async () => {
  const account = accountDouble({ createdStreamIdByName: new Map() });
  const manifests = await Promise.all([
    loadInferenceLakehouseManifest(),
    loadAnalyticsLakehouseManifest(),
  ]);
  await assert.rejects(
    ensureCloudflareLakehouses({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
      manifests,
    }),
    (error) => {
      assert.match(error.message, /avalon_global_inference_lakehouse_stream/u);
      assert.match(error.message, /avalon_global_analytics_events_lakehouse_stream/u);
      for (const stream of account.entities.streams.values()) {
        assert.match(error.message, new RegExp(stream.id, 'u'));
      }
      return true;
    },
  );
  assert.equal(account.entities.streams.size, 2);
  assert.equal(account.entities.sinks.size, 0);
  assert.equal(account.entities.pipelines.size, 0);
  assert.equal(account.buckets.size, 0);
  assert.equal(account.catalogs.size, 0);
  assert.deepEqual(
    account.requests.filter((request) =>
      request.method === 'POST' && request.path.startsWith('/pipelines/v1/'))
      .map((request) => request.path),
    ['/pipelines/v1/streams', '/pipelines/v1/streams'],
  );

  const streamIdByName = new Map([...account.entities.streams.values()].map((stream) => [
    stream.name,
    stream.id,
  ]));
  const migratedManifests = manifests.map((manifest) => ({
    ...manifest,
    regions: {
      ...manifest.regions,
      global: {
        ...manifest.regions.global,
        streamId: streamIdByName.get(manifest.regions.global.stream),
      },
    },
  }));
  await ensureCloudflareLakehouses({
    environment,
    fetchImpl: account.fetchImpl,
    log: () => {},
    manifests: migratedManifests,
  });
  const createsAfterReconciliation = account.requests.filter((request) => request.method === 'POST');
  assert.equal(createsAfterReconciliation.length, 10);
  assert.deepEqual([...account.buckets].sort(), [
    'avalon-global-analytics-events-lakehouse',
    'avalon-global-inference-lakehouse',
  ]);
  assert.deepEqual([...account.catalogs.keys()].sort(), [
    'avalon-global-analytics-events-lakehouse',
    'avalon-global-inference-lakehouse',
  ]);
  assert.equal(account.entities.sinks.size, 2);
  assert.equal(account.entities.pipelines.size, 2);
  for (const sink of account.entities.sinks.values()) {
    assert.equal(Object.hasOwn(sink.config, 'account_id'), false);
    assert.equal(sink.config.token, environment.CLOUDFLARE_API_TOKEN);
  }
  assert.equal(account.requests.some((request) => request.path.includes('avalon-eu-')), false);

  await ensureCloudflareLakehouses({
    environment,
    fetchImpl: account.fetchImpl,
    log: () => {},
    manifests: migratedManifests,
  });
  assert.equal(
    account.requests.filter((request) => request.method === 'POST').length,
    createsAfterReconciliation.length,
  );
});

test('explicit reconciliation provisions both Global catalogs', async () => {
  const account = accountDouble();
  const outputDirectory = await mkdtemp(join(tmpdir(), 'avalon-reconcile-no-bindings-test-'));
  try {
    const result = await ensureCloudflareLakehouses({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
      outputDirectory,
    });
    assert.deepEqual([...account.buckets].sort(), [
      'avalon-global-analytics-events-lakehouse',
      'avalon-global-inference-lakehouse',
    ]);
    assert.deepEqual([...account.catalogs.keys()].sort(), [
      'avalon-global-analytics-events-lakehouse',
      'avalon-global-inference-lakehouse',
    ]);
    assert.equal(account.entities.streams.size, 2);
    assert.equal(account.entities.sinks.size, 2);
    assert.equal(account.entities.pipelines.size, 2);
    assert.equal(result.provisioned[1].manifest.binding, 'ANALYTICS_LAKEHOUSE');
    assert.equal((await loadAnalyticsLakehouseManifest()).table, 'analytics_events');
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('ordinary deploys materialize pinned bindings without a Cloudflare request', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'avalon-pinned-bindings-test-'));
  const originalFetch = globalThis.fetch;
  let cloudflareRequests = 0;
  globalThis.fetch = async () => {
    cloudflareRequests += 1;
    throw new Error('materialization must not make a network request');
  };
  try {
    const result = await materializePinnedLakehouseWranglerConfigs({ outputDirectory });
    const globalConfig = JSON.parse(await readFile(result.configs.global, 'utf8'));
    const euConfig = JSON.parse(await readFile(result.configs.eu, 'utf8'));

    assert.deepEqual(globalConfig.pipelines, checkedInManifests.map((manifest) => ({
      binding: manifest.binding,
      stream: manifest.regions.global.streamId,
    })));
    assert.equal(Object.hasOwn(euConfig, 'pipelines'), false);
    assert.deepEqual(
      result.manifests.map((manifest) => manifest.regions.global.streamId),
      globalConfig.pipelines.map(({ stream }) => stream),
    );
    assert.equal(cloudflareRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('duplicate pinned stream IDs fail before config writes or Cloudflare requests', async () => {
  const manifests = await Promise.all([
    loadInferenceLakehouseManifest(),
    loadAnalyticsLakehouseManifest(),
  ]);
  const duplicateId = manifests[0].regions.global.streamId;
  const duplicateManifests = manifests.map((manifest) => ({
    ...manifest,
    regions: {
      ...manifest.regions,
      global: { ...manifest.regions.global, streamId: duplicateId },
    },
  }));
  const originalFetch = globalThis.fetch;
  const outputDirectory = await mkdtemp(join(tmpdir(), 'avalon-duplicate-pins-test-'));
  let cloudflareRequests = 0;
  const unexpectedFetch = async () => {
    cloudflareRequests += 1;
    throw new Error('duplicate validation must not make a network request');
  };
  globalThis.fetch = unexpectedFetch;
  try {
    await assert.rejects(
      materializePinnedLakehouseWranglerConfigs({
        manifests: duplicateManifests,
        outputDirectory,
      }),
      /must not share pinned Pipeline stream ID/u,
    );
    await assert.rejects(
      ensureCloudflareLakehouses({
        environment,
        fetchImpl: unexpectedFetch,
        manifests: duplicateManifests,
        outputDirectory,
      }),
      /must not share pinned Pipeline stream ID/u,
    );
    assert.deepEqual(await readdir(outputDirectory), []);
    assert.equal(cloudflareRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('the CLI accepts exactly one known lakehouse mode', () => {
  for (const mode of ['--check', '--materialize-bindings', '--reconcile']) {
    assert.equal(parseLakehouseMode([mode]), mode);
  }
  for (const arguments_ of [
    [],
    ['--check', '--reconcile'],
    ['--materialize-bindings', '--materialize-bindings'],
    ['--materialize-bindings', '--unknown'],
    ['--unknown'],
  ]) {
    assert.throws(
      () => parseLakehouseMode(arguments_),
      /Choose exactly one lakehouse mode/u,
    );
  }
});

test('existing Pipeline resources are verified from list responses without detail reads', async () => {
  const account = accountDouble();
  await ensureCloudflareLakehouses({
    environment,
    fetchImpl: account.fetchImpl,
    log: () => {},
  });
  const requestCountBeforeVerification = account.requests.length;

  const result = await ensureCloudflareLakehouses({
    environment,
    fetchImpl: account.fetchImpl,
    log: () => {},
  });

  const verificationRequests = account.requests.slice(requestCountBeforeVerification);
  const pipelineReads = verificationRequests.filter((request) =>
    request.method === 'GET' && request.path.startsWith('/pipelines/v1/'));
  assert.deepEqual(pipelineReads.map((request) => request.path), [
    '/pipelines/v1/streams',
    '/pipelines/v1/sinks',
    '/pipelines/v1/pipelines',
    '/pipelines/v1/streams',
    '/pipelines/v1/sinks',
    '/pipelines/v1/pipelines',
  ]);
  assert.equal(
    pipelineReads.some((request) =>
      /^\/pipelines\/v1\/(?:streams|sinks|pipelines)\/[^/]+$/u.test(request.path)),
    false,
  );
  assert.equal(verificationRequests.some((request) => request.method === 'POST'), false);
  assert.ok(result.provisioned.every(({ resources }) =>
    account.entities.streams.has(resources.global.stream.id)));
});

test('Pipeline list lookup ignores partial names and rejects exact duplicates', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const stream = [...account.entities.streams.values()][0];
  account.entities.streams.set('partial-name-stream', {
    ...stream,
    id: 'partial-name-stream',
    name: `${stream.name}_other`,
  });

  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });

  account.entities.streams.set('duplicate-name-stream', {
    ...stream,
    id: 'duplicate-name-stream',
  });
  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    new RegExp(`duplicate streams named ${stream.name}`, 'u'),
  );
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
    /Missing lakehouse Pipeline stream: avalon_global_inference_lakehouse_stream/u,
  );
  assert.equal(account.requests.some((request) => request.method === 'POST'), false);
});

test('the manifest rejects an EU analytical resource set', async () => {
  const manifest = await loadInferenceLakehouseManifest();
  const account = accountDouble();
  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
      manifest: {
        ...manifest,
        regions: {
          ...manifest.regions,
          eu: {
            ...manifest.regions.global,
            bucket: 'avalon-eu-inference-lakehouse',
          },
        },
      },
    }),
    /must provision Global only/u,
  );
  assert.equal(account.requests.length, 0);
});

test('the manifest rejects an unsafe pinned stream ID before using Cloudflare', async () => {
  const manifest = await loadInferenceLakehouseManifest();
  const account = accountDouble();
  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
      manifest: {
        ...manifest,
        regions: {
          ...manifest.regions,
          global: {
            ...manifest.regions.global,
            streamId: 'not-a-stream-id',
          },
        },
      },
    }),
    /Unsafe global lakehouse stream ID/u,
  );
  assert.equal(account.requests.length, 0);
});

test('immutable stream drift stops deployment instead of silently splitting the schema', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const manifest = await loadInferenceLakehouseManifest();
  const globalStream = [...account.entities.streams.values()].find((stream) =>
    stream.name === manifest.regions.global.stream);
  globalStream.schema = { fields: globalStream.schema.fields.slice(0, -1) };

  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /schema drifted; Pipeline stream schemas are immutable/u,
  );
});

test('reconciliation rejects a stream whose ID differs from the pinned binding', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const stream = [...account.entities.streams.values()][0];
  account.entities.streams.clear();
  stream.id = 'f'.repeat(32);
  account.entities.streams.set(stream.id, stream);

  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /ID drifted from pinned deployment binding/u,
  );
});

test('account-owned deployment tokens provision the Global Catalog sink without a user token', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const globalSink = [...account.entities.sinks.values()].find((sink) =>
    sink.type === 'r2_data_catalog');
  assert.equal(globalSink.config.token, environment.CLOUDFLARE_API_TOKEN);
  assert.equal(account.requests[0].path, '/tokens/verify');
  assert.ok(
    !account.requests.some((request) => request.path === '/user/tokens/verify'),
    'account-owned provisioning must not consult the user verifier',
  );
});

test('user-owned deployment tokens use the declared verifier and retain rotation protection', async () => {
  const account = accountDouble({ tokenOwner: 'user' });
  const manifest = {
    ...await loadInferenceLakehouseManifest(),
    deploymentTokenOwner: 'user',
  };
  await ensureInferenceLakehouse({
    environment,
    fetchImpl: account.fetchImpl,
    log: () => {},
    manifest,
  });
  const globalSink = [...account.entities.sinks.values()].find((sink) =>
    sink.type === 'r2_data_catalog');
  assert.equal(globalSink.config.token, environment.CLOUDFLARE_API_TOKEN);
  assert.equal(account.requests[0].path, '/user/tokens/verify');
  assert.ok(
    !account.requests.some((request) => request.path === '/tokens/verify'),
    'user-owned provisioning must not consult the account verifier',
  );

  account.setTokenId('c'.repeat(32));
  await assert.rejects(
    ensureInferenceLakehouse({
      environment,
      fetchImpl: account.fetchImpl,
      log: () => {},
      manifest,
    }),
    /uses a different deployment credential; sinks are immutable/u,
  );
});

test('immutable Global sink drift stops deployment', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const globalSink = [...account.entities.sinks.values()].find((sink) =>
    sink.type === 'r2_data_catalog');
  globalSink.config.namespace = 'drifted';

  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /destination or rolling policy drifted; sinks are immutable/u,
  );

  globalSink.config.namespace = 'avalon';
  globalSink.config.account_id = 'different-account';
  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /destination or rolling policy drifted; sinks are immutable/u,
  );
});

test('immutable Pipeline SQL drift stops deployment from the list response', async () => {
  const account = accountDouble();
  await ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} });
  const pipeline = [...account.entities.pipelines.values()][0];
  pipeline.sql = 'INSERT INTO another_sink SELECT * FROM another_stream;';

  await assert.rejects(
    ensureInferenceLakehouse({ environment, fetchImpl: account.fetchImpl, log: () => {} }),
    /SQL drifted from the checked-in lakehouse manifest/u,
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
  assert.equal(account.entities.sinks.size, 1);
});

test('the deploy materializes pinned bindings without reconciling Pipelines', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const materialize = workflow.indexOf('Materialize pinned Global lakehouse bindings');
  const migrations = workflow.indexOf('List the pending remote migrations for EU');
  const deploy = workflow.indexOf('Deploy the EU Worker');
  assert.ok(materialize > 0 && materialize < migrations && migrations < deploy);
  assert.match(
    workflow,
    /ensure-cloudflare-inference-lakehouse\.mjs --materialize-bindings/u,
  );
  assert.doesNotMatch(workflow, /ensure-cloudflare-inference-lakehouse\.mjs --reconcile/u);
  assert.match(workflow, /build:deployed:eu/u);
  assert.match(workflow, /build:deployed/u);
  assert.match(workflow, /--config "\$config"/u);
  assert.match(workflow, /\.wrangler\.lakehouses\.eu\.json/u);
  assert.match(workflow, /\.wrangler\.lakehouses\.global\.json/u);
  assert.match(packageJson.scripts['cloudflare:lakehouses:ensure'], /--reconcile$/u);
});
