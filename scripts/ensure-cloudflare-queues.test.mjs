import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configuredQueues,
  ensureRequiredQueues,
  queuesFromWrangler,
  stripJsonComments,
} from './ensure-cloudflare-queues.mjs';

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

/**
 * A Cloudflare account double: `GET` lists what `names` holds, `POST` runs
 * `onCreate` and, when it answers with a success body, adds the name to the
 * listing so a later `GET` sees it — the one thing a real account does that a
 * canned response cannot.
 */
function accountDouble(names, onCreate) {
  const created = [];
  const fetchImpl = async (input, init = {}) => {
    if (init.method === 'POST') {
      const request = { url: String(input), headers: init.headers, body: JSON.parse(init.body) };
      created.push(request);
      const response = await onCreate(request);
      if (response.ok) names.push(request.body.queue_name);
      return response;
    }
    return queueListing(names)();
  };
  return { fetchImpl, created };
}

test('the queue inventory comes from every Wrangler file that binds one', async () => {
  const { required, createdOnDeploy } = await configuredQueues();

  assert.deepEqual(required, [
    { surface: 'api-global', role: 'producer:ACTIVITY_QUEUE', name: 'avalon-global-activities' },
    { surface: 'api-global', role: 'producer:ACCESS_REVOCATION_QUEUE', name: 'avalon-global-access-revocations' },
    { surface: 'api-global', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-activities' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-access-revocations' },
    { surface: 'api-eu', role: 'producer:ACTIVITY_QUEUE', name: 'avalon-eu-activities' },
    { surface: 'api-eu', role: 'producer:ACCESS_REVOCATION_QUEUE', name: 'avalon-eu-access-revocations' },
    { surface: 'api-eu', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'api-eu', role: 'consumer', name: 'avalon-eu-activities' },
    { surface: 'api-eu', role: 'consumer', name: 'avalon-eu-access-revocations' },
    { surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' },
  ]);
  assert.deepEqual(createdOnDeploy.map((queue) => queue.name), [
    'avalon-global-activities-dead-letter',
    'avalon-global-access-revocations-dead-letter',
    'avalon-eu-activities-dead-letter',
    'avalon-eu-access-revocations-dead-letter',
    'avalon-migration-reports-dead-letter',
  ]);
});

test('creates nothing and reports each queue when the account holds every one', async () => {
  const lines = [];
  const { required } = await configuredQueues();
  const account = accountDouble([
    ...required.map((queue) => queue.name),
    'avalon-global-activities-dead-letter',
    'avalon-global-access-revocations-dead-letter',
    'avalon-eu-activities-dead-letter',
    'avalon-eu-access-revocations-dead-letter',
    'avalon-migration-reports-dead-letter',
  ], () => assert.fail('nothing should be created'));

  await ensureRequiredQueues({ environment, log: (line) => lines.push(line), fetchImpl: account.fetchImpl });

  assert.deepEqual(account.created, []);
  assert.ok(lines.some((line) => line.includes('api-global/producer:MIGRATION_REPORT_QUEUE')));
  assert.ok(lines.some((line) => line.includes('migration-tracker/consumer')));
});

test('creates a queue a binding names that the account does not hold', async () => {
  const lines = [];
  const account = accountDouble(
    ['avalon-eu-activities'],
    () => Response.json({ success: true, result: { queue_name: 'avalon-migration-reports' } }),
  );

  await ensureRequiredQueues({
    environment,
    log: (line) => lines.push(line),
    queues: {
      required: [
        { surface: 'api-eu', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
        { surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' },
      ],
      createdOnDeploy: [],
    },
    fetchImpl: account.fetchImpl,
  });

  // One queue, two bindings: it is created once, by name, with the token.
  assert.equal(account.created.length, 1);
  assert.equal(account.created[0].url, 'https://api.cloudflare.com/client/v4/accounts/test-account/queues');
  assert.deepEqual(account.created[0].body, { queue_name: 'avalon-migration-reports' });
  assert.equal(account.created[0].headers.Authorization, 'Bearer test-token');
  assert.ok(lines.includes('Created Queue avalon-migration-reports'));
  assert.ok(lines.some((line) => line.includes('migration-tracker/consumer -> avalon-migration-reports')));
});

test('fails naming the permission when the token is refused a create', async () => {
  const account = accountDouble([], () => Response.json(
    { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    { status: 403 },
  ));

  await assert.rejects(
    ensureRequiredQueues({
      environment,
      log: () => {},
      queues: {
        required: [{ surface: 'api-eu', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' }],
        createdOnDeploy: [],
      },
      fetchImpl: account.fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /avalon-migration-reports/u);
      assert.match(error.message, /HTTP 403: Authentication error \[code: 10000\]/u);
      assert.match(error.message, /Queues Edit/u);
      return true;
    },
  );
});

test('passes when a refused create turns out to be a concurrent deployment creating the same queue', async () => {
  const lines = [];
  const names = [];
  const account = accountDouble(names, () => {
    // The other deployment won the race between this run's listing and its
    // create: the queue exists by the time Cloudflare answers.
    names.push('avalon-migration-reports');
    return Response.json(
      { success: false, errors: [{ code: 11009, message: 'queue already exists' }] },
      { status: 400 },
    );
  });

  await ensureRequiredQueues({
    environment,
    log: (line) => lines.push(line),
    queues: {
      required: [{ surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' }],
      createdOnDeploy: [],
    },
    fetchImpl: account.fetchImpl,
  });

  assert.ok(lines.includes('Queue avalon-migration-reports was created by a concurrent deployment'));
});

test('does not create a dead-letter queue, which the deploy creates', async () => {
  const lines = [];
  const account = accountDouble(['avalon-migration-reports'], () => assert.fail('nothing should be created'));

  await ensureRequiredQueues({
    environment,
    log: (line) => lines.push(line),
    queues: {
      required: [{ surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' }],
      createdOnDeploy: [{ surface: 'migration-tracker', role: 'dead_letter_queue', name: 'avalon-migration-reports-dead-letter' }],
    },
    fetchImpl: account.fetchImpl,
  });

  assert.deepEqual(account.created, []);
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

  await ensureRequiredQueues({
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
