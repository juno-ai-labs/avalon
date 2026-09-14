import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPairedQueues,
  assertSingleConsumerPerQueue,
  configuredQueues,
  createAccountQueue,
  ensureRequiredQueues,
  listAccountQueues,
  queuesFromWrangler,
} from './ensure-cloudflare-queues.mjs';
import { stripJsonComments } from './wrangler-config.mjs';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};

const created = (queue_name) => Response.json({ success: true, result: { queue_name } });
const refused = (status, code, message) => Response.json(
  { success: false, errors: [{ code, message }] },
  { status },
);

/**
 * A Cloudflare account double: `GET` lists what `names` holds, `POST` records
 * the request, runs `onCreate` and, when that answers with a success body, adds
 * the name to the listing so a later `GET` sees it — the one thing a real
 * account does that a canned response cannot. `onList` overrides the listing.
 *
 * It records rather than throws on an unexpected create: a throw would land in
 * the script's own catch, which re-lists and may decide the queue exists after
 * all, so `created` being empty is the assertion that nothing was created.
 */
function accountDouble(names, onCreate = () => assert.fail('unexpected create'), onList) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    if (init.method === 'POST') {
      const request = { url: String(input), headers: init.headers, body: JSON.parse(init.body) };
      requests.push(request);
      const response = await onCreate(request);
      if (response.ok) names.push(request.body.queue_name);
      return response;
    }
    if (onList) return onList(String(input));
    return Response.json({ success: true, result: names.map((queue_name) => ({ queue_name })) });
  };
  return { fetchImpl, created: requests };
}

const reportQueue = {
  required: [
    { surface: 'api-enterprise', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' },
  ],
  createdOnDeploy: [],
};

// Editing this list is the review step for what a deployment provisions in
// the Cloudflare account: every new binding changes it on purpose.
test('the queue inventory comes from every Wrangler file that binds one', async () => {
  const { required, createdOnDeploy } = await configuredQueues();

  assert.deepEqual(required, [
    { surface: 'api-global', role: 'producer:ACTIVITY_QUEUE', name: 'avalon-global-activities' },
    { surface: 'api-global', role: 'producer:INFERENCE_LAKEHOUSE_QUEUE', name: 'avalon-global-inference-lakehouse' },
    { surface: 'api-global', role: 'producer:ANALYTICS_LAKEHOUSE_QUEUE', name: 'avalon-global-analytics-events-lakehouse' },
    { surface: 'api-global', role: 'producer:ACCESS_REVOCATION_QUEUE', name: 'avalon-global-access-revocations' },
    { surface: 'api-global', role: 'producer:PUSH_DELIVERY_QUEUE', name: 'avalon-global-push-deliveries' },
    { surface: 'api-global', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-activities' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-inference-lakehouse' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-analytics-events-lakehouse' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-access-revocations' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-push-deliveries' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-product-feature-flags' },
    { surface: 'api-global', role: 'consumer', name: 'avalon-global-migration-commands' },
    { surface: 'migration-tracker', role: 'producer:GLOBAL_MIGRATION_COMMAND_QUEUE', name: 'avalon-global-migration-commands' },
    { surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' },
    { surface: 'ace', role: 'producer:PRODUCT_FLAG_CHANGE_QUEUE', name: 'avalon-product-feature-flag-changes' },
    { surface: 'ace', role: 'producer:GLOBAL_PRODUCT_FLAG_QUEUE', name: 'avalon-global-product-feature-flags' },
    { surface: 'ace', role: 'consumer', name: 'avalon-product-feature-flag-changes' },
  ]);
  assert.deepEqual(createdOnDeploy.map((queue) => queue.name), [
    'avalon-global-activities-dead-letter',
    'avalon-global-inference-lakehouse-dead-letter',
    'avalon-global-analytics-events-lakehouse-dead-letter',
    'avalon-global-access-revocations-dead-letter',
    'avalon-global-push-deliveries-dead-letter',
    'avalon-global-product-feature-flags-dead-letter',
    'avalon-global-migration-commands-dead-letter',
    'avalon-migration-reports-dead-letter',
    'avalon-product-feature-flag-changes-dead-letter',
  ]);
});

test('against an empty account, exactly the queues the Wrangler files require are created, once each', async () => {
  const account = accountDouble([], (request) => created(request.body.queue_name));

  await ensureRequiredQueues({ environment, log: () => {}, fetchImpl: account.fetchImpl });

  // Fourteen names from twenty-nine bindings; no dead-letter queue among them.
  assert.deepEqual(account.created.map((request) => request.body.queue_name), [
    'avalon-global-activities',
    'avalon-global-inference-lakehouse',
    'avalon-global-analytics-events-lakehouse',
    'avalon-global-access-revocations',
    'avalon-global-push-deliveries',
    'avalon-migration-reports',
    'avalon-global-product-feature-flags',
    'avalon-global-migration-commands',
    'avalon-product-feature-flag-changes',
  ]);
});

test('creates nothing and reports each queue when the account holds every one', async () => {
  const lines = [];
  const { required, createdOnDeploy } = await configuredQueues();
  const account = accountDouble([
    ...required.map((queue) => queue.name),
    ...createdOnDeploy.map((queue) => queue.name),
  ]);

  await ensureRequiredQueues({ environment, log: (line) => lines.push(line), fetchImpl: account.fetchImpl });

  assert.deepEqual(account.created, []);
  assert.ok(lines.includes('Required Queue present: api-global/producer:MIGRATION_REPORT_QUEUE -> avalon-migration-reports'));
  assert.ok(lines.includes('Required Queue present: migration-tracker/consumer -> avalon-migration-reports'));
  assert.ok(lines.includes('Dead-letter Queue present: api-global -> avalon-global-activities-dead-letter'));
});

test('creates a queue a binding names that the account does not hold', async () => {
  const lines = [];
  const account = accountDouble(['avalon-enterprise-activities'], (request) => created(request.body.queue_name));

  await ensureRequiredQueues({
    environment, log: (line) => lines.push(line), queues: reportQueue, fetchImpl: account.fetchImpl,
  });

  // One queue, two bindings: it is created once, by name, with the token.
  assert.equal(account.created.length, 1);
  assert.equal(account.created[0].url, 'https://api.cloudflare.com/client/v4/accounts/test-account/queues');
  assert.deepEqual(account.created[0].body, { queue_name: 'avalon-migration-reports' });
  assert.equal(account.created[0].headers.Authorization, 'Bearer test-token');
  assert.equal(account.created[0].headers['Content-Type'], 'application/json');
  assert.ok(lines.includes('Created Queue avalon-migration-reports'));
  assert.ok(lines.includes('Required Queue created: migration-tracker/consumer -> avalon-migration-reports'));
});

test('--check reports what a deploy would create and fails without creating it', async () => {
  const account = accountDouble(['avalon-enterprise-activities']);

  await assert.rejects(
    ensureRequiredQueues({
      environment, log: () => {}, queues: reportQueue, fetchImpl: account.fetchImpl, create: false,
    }),
    /Missing Cloudflare Queue\(s\): avalon-migration-reports\. The deployment creates them/u,
  );
  assert.deepEqual(account.created, []);
});

test('refuses a queue only one side names, before anything is created', async () => {
  const account = accountDouble([]);

  await assert.rejects(
    ensureRequiredQueues({
      environment,
      log: () => {},
      queues: {
        required: [
          { surface: 'api-enterprise', role: 'producer:ACCESS_REVOCATION_QUEUE', name: 'avalon-enterprise-access-revocaitons' },
          { surface: 'api-enterprise', role: 'consumer', name: 'avalon-enterprise-access-revocations' },
        ],
        createdOnDeploy: [],
      },
      fetchImpl: account.fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /avalon-enterprise-access-revocaitons has producer api-enterprise\/producer:ACCESS_REVOCATION_QUEUE but no consumer/u);
      assert.match(error.message, /avalon-enterprise-access-revocations has consumer api-enterprise\/consumer but no producer/u);
      return true;
    },
  );
  assert.deepEqual(account.created, []);
});

test('a queue pairs across Wrangler files, not only within one', async () => {
  const { required } = await configuredQueues();
  assert.doesNotThrow(() => assertPairedQueues(required));
});

test('fails naming the permission when the token is refused a create', async () => {
  const account = accountDouble([], () => refused(403, 10000, 'Authentication error'));

  await assert.rejects(
    ensureRequiredQueues({ environment, log: () => {}, queues: reportQueue, fetchImpl: account.fetchImpl }),
    (error) => {
      assert.match(error.message, /avalon-migration-reports/u);
      assert.match(error.message, /HTTP 403: Authentication error \[code: 10000\]/u);
      assert.match(error.message, /Queues Edit/u);
      return true;
    },
  );
});

test('a refused permission is never taken for a concurrent creation, even when the queue then exists', async () => {
  const names = [];
  const account = accountDouble(names, () => {
    names.push('avalon-migration-reports');
    return refused(403, 10000, 'Authentication error');
  });

  await assert.rejects(
    ensureRequiredQueues({ environment, log: () => {}, queues: reportQueue, fetchImpl: account.fetchImpl }),
    /Queues Edit/u,
  );
});

test('a failure other than permission does not claim the permission is missing', async () => {
  const account = accountDouble([], () => refused(500, 1000, 'internal error'));

  await assert.rejects(
    ensureRequiredQueues({ environment, log: () => {}, queues: reportQueue, fetchImpl: account.fetchImpl }),
    (error) => {
      assert.match(error.message, /avalon-migration-reports failed with HTTP 500: internal error \[code: 1000\]\./u);
      assert.doesNotMatch(error.message, /Queues Edit/u);
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
    return refused(400, 11009, 'queue already exists');
  });

  await ensureRequiredQueues({
    environment, log: (line) => lines.push(line), queues: reportQueue, fetchImpl: account.fetchImpl,
  });

  assert.ok(lines.some((line) => line.startsWith('Queue avalon-migration-reports exists after this run\'s create was refused (')
    && line.includes('queue already exists [code: 11009]')
    && line.endsWith('a concurrent deployment created it')));
});

test('keeps the create error when the listing after a refused create fails too', async () => {
  let listings = 0;
  const account = accountDouble(
    [],
    () => refused(409, 11009, 'queue already exists'),
    () => {
      listings += 1;
      return listings === 1
        ? Response.json({ success: true, result: [] })
        : Response.json({ success: false, errors: [{ code: 7000, message: 'upstream' }] }, { status: 502 });
    },
  );

  await assert.rejects(
    ensureRequiredQueues({ environment, log: () => {}, queues: reportQueue, fetchImpl: account.fetchImpl }),
    /Creating Cloudflare Queue avalon-migration-reports failed with HTTP 409: queue already exists \[code: 11009\]\./u,
  );
});

test('a create whose request never reaches Cloudflare names the queue', async () => {
  const account = accountDouble([], () => { throw new TypeError('fetch failed'); });

  await assert.rejects(
    ensureRequiredQueues({ environment, log: () => {}, queues: reportQueue, fetchImpl: account.fetchImpl }),
    /Creating Cloudflare Queue avalon-migration-reports failed: fetch failed/u,
  );
});

test('does not create a dead-letter queue, which the deploy creates', async () => {
  const lines = [];
  const account = accountDouble(['avalon-migration-reports']);

  await ensureRequiredQueues({
    environment,
    log: (line) => lines.push(line),
    queues: {
      required: reportQueue.required,
      createdOnDeploy: [{ surface: 'migration-tracker', role: 'dead_letter_queue', name: 'avalon-migration-reports-dead-letter' }],
    },
    fetchImpl: account.fetchImpl,
  });

  assert.deepEqual(account.created, []);
  assert.ok(lines.includes('Dead-letter Queue avalon-migration-reports-dead-letter will be created on first deploy of migration-tracker'));
});

test('will not post a name that is not a plain Cloudflare identifier, whoever asks', async () => {
  const account = accountDouble([]);

  await assert.rejects(
    createAccountQueue({ ...environment, accountId: 'a', token: 't', fetchImpl: account.fetchImpl, name: '../../evil' }),
    /Unsafe queue name in create\/queue: \.\.\/\.\.\/evil/u,
  );
  assert.deepEqual(account.created, []);
});

test('fails without the account id or the token', async () => {
  await assert.rejects(
    ensureRequiredQueues({ environment: { CLOUDFLARE_API_TOKEN: 't' }, queues: reportQueue }),
    /CLOUDFLARE_ACCOUNT_ID is required/u,
  );
  await assert.rejects(
    ensureRequiredQueues({ environment: { CLOUDFLARE_ACCOUNT_ID: 'a' }, queues: reportQueue }),
    /CLOUDFLARE_API_TOKEN is required/u,
  );
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

  await ensureRequiredQueues({ environment, log: () => {}, queues: reportQueue, fetchImpl });

  assert.deepEqual(pages, [1, 2]);
});

test('a listing that never reaches its end fails rather than being treated as complete', async () => {
  const fetchImpl = async () => Response.json({
    success: true,
    result: Array.from({ length: 100 }, (unused, index) => ({ queue_name: `filler-${index}` })),
  });

  await assert.rejects(
    listAccountQueues({ accountId: 'a', token: 't', fetchImpl }),
    /stopped after 20 pages \(2000 queues\) without reaching the end/u,
  );
});

test('a listing Cloudflare refuses reports what it said, even on a 200', async () => {
  const fetchImpl = async () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] });

  await assert.rejects(
    listAccountQueues({ accountId: 'a', token: 't', fetchImpl }),
    /Listing Cloudflare Queues failed with HTTP 200: Authentication error \[code: 10000\]\./u,
  );
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

test('the declared queues each have exactly one consumer', async () => {
  const { required } = await configuredQueues();

  assert.doesNotThrow(() => assertSingleConsumerPerQueue(required));
});

test('refuses a queue consumed by two Workers', () => {
  // The shape a regional queue pasted into both regional files produces.
  // `assertPairedQueues` is content with it — both sides are named — so this is
  // the only thing standing between that edit and a half-completed release.
  assert.throws(
    () => assertSingleConsumerPerQueue([
      { surface: 'api-global', role: 'producer:COMMANDS', name: 'avalon-global-migration-commands' },
      { surface: 'api-global', role: 'consumer', name: 'avalon-global-migration-commands' },
      { surface: 'api-enterprise', role: 'consumer', name: 'avalon-global-migration-commands' },
    ]),
    /avalon-global-migration-commands is consumed by api-global and api-enterprise/u,
  );
});

test('allows the same queue produced by two Workers', () => {
  // `avalon-migration-reports` is exactly this: both API Workers produce it and
  // only the tracker consumes it. The limit is on consumers alone.
  assert.doesNotThrow(() => assertSingleConsumerPerQueue([
    { surface: 'api-global', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'api-enterprise', role: 'producer:MIGRATION_REPORT_QUEUE', name: 'avalon-migration-reports' },
    { surface: 'migration-tracker', role: 'consumer', name: 'avalon-migration-reports' },
  ]));
});
