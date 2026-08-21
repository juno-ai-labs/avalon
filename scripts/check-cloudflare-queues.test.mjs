import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkRequiredQueues,
  configuredQueues,
  queuesFromWrangler,
  stripJsonComments,
} from './check-cloudflare-queues.mjs';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};

function queueListing(names) {
  return async () => Response.json({
    success: true,
    result: names.map((queue_name) => ({ queue_name })),
  });
}

test('the queue inventory comes from every Wrangler file that binds one', async () => {
  const { required, createdOnDeploy } = await configuredQueues();

  assert.deepEqual(required, [
    { surface: 'api-global', role: 'producer:ACTIVITY_QUEUE', name: 'avalon-global-activities' },
    { surface: 'api-global', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-activities' },
    { surface: 'api-eu', role: 'producer:ACTIVITY_QUEUE', name: 'avalon-eu-activities' },
    { surface: 'api-eu', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'api-eu', role: 'consumer', name: 'avalon-eu-activities' },
    { surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' },
  ]);
  assert.deepEqual(createdOnDeploy.map((queue) => queue.name), [
    'avalon-global-activities-dead-letter',
    'avalon-eu-activities-dead-letter',
    'avalon-migration-reports-dead-letter',
  ]);
});

test('passes and reports each queue when the account holds every one', async () => {
  const lines = [];
  const { required } = await configuredQueues();

  await checkRequiredQueues({
    environment,
    log: (line) => lines.push(line),
    fetchImpl: queueListing([
      ...required.map((queue) => queue.name),
      'avalon-global-activities-dead-letter',
      'avalon-eu-activities-dead-letter',
      'avalon-migration-reports-dead-letter',
    ]),
  });

  assert.ok(lines.some((line) => line.includes('api-global/producer:MIGRATION_REPORT_QUEUE')));
  assert.ok(lines.some((line) => line.includes('migration-tracker/consumer')));
});

test('fails with the creation command when a producer queue is absent', async () => {
  await assert.rejects(
    checkRequiredQueues({
      environment,
      log: () => {},
      queues: {
        required: [{ surface: 'api-eu', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' }],
        createdOnDeploy: [],
      },
      fetchImpl: queueListing(['avalon-eu-activities']),
    }),
    (error) => {
      assert.match(error.message, /api-eu\/producer:MIGRATION_REPORT_QUEUE/u);
      assert.match(error.message, /wrangler queues create avalon-migration-reports/u);
      return true;
    },
  );
});

test('does not fail for a dead-letter queue, which the deploy creates', async () => {
  const lines = [];

  await checkRequiredQueues({
    environment,
    log: (line) => lines.push(line),
    queues: {
      required: [{ surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' }],
      createdOnDeploy: [{ surface: 'migration-tracker', role: 'dead_letter_queue', name: 'avalon-migration-reports-dead-letter' }],
    },
    fetchImpl: queueListing(['avalon-migration-reports']),
  });

  assert.ok(lines.some((line) => line.includes('will be created on first deploy')));
});

test('follows Cloudflare pagination rather than reading only the first page', async () => {
  const pages = [];
  const fetchImpl = async (input) => {
    const page = Number(new URL(input).searchParams.get('page'));
    pages.push(page);
    const names = page === 1
      ? Array.from({ length: 100 }, (unused, index) => `filler-${index}`)
      : ['avalon-migration-reports'];
    return Response.json({ success: true, result: names.map((queue_name) => ({ queue_name })) });
  };

  await checkRequiredQueues({
    environment,
    log: () => {},
    queues: {
      required: [{ surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' }],
      createdOnDeploy: [],
    },
    fetchImpl,
  });

  assert.deepEqual(pages, [1, 2]);
});

test('refuses a queue name that is not a plain Cloudflare identifier', () => {
  assert.throws(
    () => queuesFromWrangler(
      '{"queues":{"producers":[{"binding":"Q","queue":"../../evil"}]}}',
      'api-global',
    ),
    /Unsafe queue name in api-global\/producer:Q/u,
  );
});

test('strips comments without truncating a URL inside a string', () => {
  const source = `{
    // a leading comment
    "vars": { "PUBLIC_WEB_BASE_URL": "https://rallywith.ai" }, /* trailing */
    "queues": { "producers": [{ "binding": "Q", "queue": "avalon-migration-reports" }] },
  }`;

  const parsed = JSON.parse(stripJsonComments(source));

  // The whole reason this is a parser and not a regex: `//` appears inside the
  // URL, and a naive strip would cut the value in half.
  assert.equal(parsed.vars.PUBLIC_WEB_BASE_URL, 'https://rallywith.ai');
  assert.equal(parsed.queues.producers[0].queue, 'avalon-migration-reports');
});
