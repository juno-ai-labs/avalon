import assert from 'node:assert/strict';
import test from 'node:test';

import { forceSubstreamAgentMigrations } from './force-substream-agent-migrations.mjs';

const accountId = 'account';
const environment = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'token' };
const objectId = (index) => index.toString(16).padStart(64, '0');

function response(result, resultInfo = undefined) {
  return new Response(JSON.stringify({ success: true, result, result_info: resultInfo }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fixtureFetch({
  globalObjects = [],
  enterpriseObjects = [],
  metrics = new Map(),
  jurisdictionByObjectId = new Map(),
} = {}) {
  const requests = [];
  const queues = [
    ['global', 'global-command', 'global-dead-letter'],
    ['enterprise', 'enterprise-command', 'enterprise-dead-letter'],
  ];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname.endsWith('/workers/durable_objects/namespaces')) {
      return response(queues.map(([region]) => ({
        id: `${region}-namespace`,
        class: 'AgentLoopDO',
        script: `avalon-api-${region}`,
      })), { page: 1, total_pages: 1 });
    }
    if (url.pathname.endsWith('/queues')) {
      return response(queues.flatMap(([region, command, deadLetter]) => [
        { queue_id: command, queue_name: `avalon-${region}-migration-commands` },
        { queue_id: deadLetter, queue_name: `avalon-${region}-migration-commands-dead-letter` },
      ]));
    }
    if (url.origin === 'http://jurisdiction-probe.test') {
      const { region, objectIds } = JSON.parse(init.body);
      const fallback = region === 'global' ? 'us' : 'eu';
      return new Response(JSON.stringify({ objects: objectIds.map((id) => ({
        objectId: id,
        jurisdiction: jurisdictionByObjectId.has(id)
          ? jurisdictionByObjectId.get(id)
          : fallback,
      })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const namespace = /namespaces\/(global|enterprise)-namespace\/objects$/u.exec(url.pathname)?.[1];
    if (namespace) {
      const ids = namespace === 'global' ? globalObjects : enterpriseObjects;
      return response(ids.map((id, index) => ({ id, hasStoredData: index !== ids.length - 1 })));
    }
    const queueMetric = /queues\/([^/]+)\/metrics$/u.exec(url.pathname)?.[1];
    if (queueMetric) {
      return response(metrics.get(queueMetric) ?? { backlog_count: 0, backlog_bytes: 0 });
    }
    if (/queues\/[^/]+\/messages\/batch$/u.test(url.pathname)) return response({});
    throw new Error(`Unexpected request ${url}`);
  };
  return { fetcher, requests };
}

test('dry-run inventories stored objects without sending migration commands', async () => {
  const fixture = fixtureFetch({ globalObjects: [objectId(1), objectId(2)] });
  const result = await forceSubstreamAgentMigrations({
    argv: ['--region=global'],
    environment,
    fetcher: fixture.fetcher,
    logger: { log() {} },
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.regions.global.storedObjects, 1);
  assert.equal(result.regions.global.eligibleObjects, null);
  assert.equal(fixture.requests.some(({ url }) => url.pathname.endsWith('/messages/batch')), false);
});

test('rejects a non-HTTP jurisdiction probe URL before inventory', async () => {
  await assert.rejects(forceSubstreamAgentMigrations({
    argv: ['--jurisdiction-probe-url=not-a-url'],
    environment,
    fetcher: async () => { throw new Error('inventory_must_not_run'); },
    logger: { log() {} },
  }), /jurisdiction-probe-url must be an HTTP URL/u);
});

test('apply batches only stored object ids and waits for the regional queue to drain', async () => {
  const stored = Array.from({ length: 101 }, (_, index) => objectId(index + 1));
  const fixture = fixtureFetch({ globalObjects: [...stored, objectId(999)] });
  const result = await forceSubstreamAgentMigrations({
    argv: [
      '--',
      '--apply',
      '--region=global',
      '--jurisdiction-probe-url=http://jurisdiction-probe.test',
    ],
    environment,
    fetcher: fixture.fetcher,
    wait: async () => {},
    logger: { log() {} },
  });

  const batches = fixture.requests.filter(({ url }) => url.pathname.endsWith('/messages/batch'));
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map(({ init }) => JSON.parse(init.body).messages.length), [100, 1]);
  const commands = batches.flatMap(({ init }) => JSON.parse(init.body).messages.map((message) => message.body));
  assert.deepEqual(commands.map((command) => command.objectId), stored);
  assert.equal(commands.every((command) => command.className === 'AgentLoopDO'), true);
  assert.equal(commands.every((command) => command.region === 'global'), true);
  assert.equal(new Set(commands.map((command) => command.runId)).size, 1);
  assert.equal(result.dispatched, 101);
});

test('apply fails when the dead-letter queue grows while commands drain', async () => {
  let deadLetterReads = 0;
  const fixture = fixtureFetch({
    globalObjects: [objectId(1), objectId(999)],
    metrics: new Map([
      ['global-dead-letter', { get backlog_count() { deadLetterReads += 1; return deadLetterReads > 1 ? 1 : 0; }, backlog_bytes: 0 }],
    ]),
  });

  await assert.rejects(
    forceSubstreamAgentMigrations({
      argv: [
        '--apply',
        '--region=global',
        '--jurisdiction-probe-url=http://jurisdiction-probe.test',
      ],
      environment,
      fetcher: fixture.fetcher,
      wait: async () => {},
      logger: { log() {} },
    }),
    /global_migration_dead_letter_increased/u,
  );
});

test('apply dispatches only ids in the regional Durable Object jurisdiction', async () => {
  const usObject = objectId(1);
  const unrestrictedObject = objectId(2);
  const fixture = fixtureFetch({
    globalObjects: [usObject, unrestrictedObject, objectId(999)],
    jurisdictionByObjectId: new Map([[unrestrictedObject, null]]),
  });
  const result = await forceSubstreamAgentMigrations({
    argv: [
      '--apply',
      '--region=global',
      '--jurisdiction-probe-url=http://jurisdiction-probe.test',
    ],
    environment,
    fetcher: fixture.fetcher,
    wait: async () => {},
    logger: { log() {} },
  });

  const batches = fixture.requests.filter(({ url }) => url.pathname.endsWith('/messages/batch'));
  const commands = batches.flatMap(({ init }) => JSON.parse(init.body).messages);
  assert.deepEqual(commands.map((message) => message.body.objectId), [usObject]);
  assert.equal(result.regions.global.storedObjects, 2);
  assert.equal(result.regions.global.eligibleObjects, 1);
  assert.equal(result.regions.global.skippedObjects, 1);
});

test('apply requires a jurisdiction probe before it can enqueue commands', async () => {
  await assert.rejects(
    forceSubstreamAgentMigrations({
      argv: ['--apply', '--region=global'],
      environment,
      fetcher: fixtureFetch().fetcher,
      logger: { log() {} },
    }),
    /--jurisdiction-probe-url is required/u,
  );
});

test('refuses an ambiguous regional AgentLoopDO namespace', async () => {
  const fixture = fixtureFetch();
  const fetcher = async (input, init) => {
    const url = new URL(input);
    if (!url.pathname.endsWith('/workers/durable_objects/namespaces')) {
      return fixture.fetcher(input, init);
    }
    return response([
      { id: 'one', class: 'AgentLoopDO', script: 'avalon-api-global' },
      { id: 'two', class: 'AgentLoopDO', script: 'avalon-api-global' },
    ], { page: 1, total_pages: 1 });
  };

  await assert.rejects(
    forceSubstreamAgentMigrations({
      argv: ['--region=global'],
      environment,
      fetcher,
      logger: { log() {} },
    }),
    /global_substream_agent_namespace_count_2/u,
  );
});
