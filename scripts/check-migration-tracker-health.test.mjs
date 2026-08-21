import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkMigrationTrackerHealth,
  consumerProblems,
  expectedTrackerConsumer,
  findQueue,
  siteProblems,
} from './check-migration-tracker-health.mjs';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};

const EXPECTED = {
  script: 'avalon-migration-tracker',
  hostname: null,
  queue: 'avalon-migration-reports',
  deadLetterQueue: 'avalon-migration-reports-dead-letter',
  batchSize: 100,
  maxRetries: 5,
  maxWaitTimeMs: 10_000,
};

function attached(overrides = {}) {
  return {
    queue_name: 'avalon-migration-reports',
    consumers: [{
      script: 'avalon-migration-tracker',
      type: 'worker',
      dead_letter_queue: 'avalon-migration-reports-dead-letter',
      settings: { batch_size: 100, max_retries: 5, max_wait_time_ms: 10_000 },
      ...overrides,
    }],
  };
}

function queueListing(queues) {
  return async () => Response.json({ success: true, result: queues });
}

test('reads the expectation from the tracker Wrangler file rather than restating it', () => {
  const expected = expectedTrackerConsumer(`{
    "name": "avalon-migration-tracker",
    "routes": [{ "pattern": "migrations.internal.rallywith.ai", "custom_domain": true }],
    "queues": {
      "consumers": [{
        "queue": "avalon-migration-reports",
        // The batch size is the whole reason a single registry object is affordable.
        "max_batch_size": 100,
        "max_batch_timeout": 10,
        "max_retries": 5,
        "dead_letter_queue": "avalon-migration-reports-dead-letter"
      }]
    }
  }`);

  assert.deepEqual(expected, {
    script: 'avalon-migration-tracker',
    hostname: 'migrations.internal.rallywith.ai',
    queue: 'avalon-migration-reports',
    deadLetterQueue: 'avalon-migration-reports-dead-letter',
    batchSize: 100,
    maxRetries: 5,
    // Declared in seconds, reported by the API in milliseconds.
    maxWaitTimeMs: 10_000,
  });
});

test('accepts a consumer that matches the declared configuration', () => {
  assert.deepEqual(consumerProblems(EXPECTED, attached()), []);
});

test('reports the tracker deploying without becoming a consumer', () => {
  const problems = consumerProblems(EXPECTED, { queue_name: 'avalon-migration-reports', consumers: [] });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a consumer of avalon-migration-reports/u);
  assert.match(problems[0], /accumulate unread/u);
});

test('reports a consumer silently attached at a different batch size', () => {
  // The failure this exists for: Cloudflare's default of 10 works, and costs
  // ten times the registry writes the design is budgeted for.
  const problems = consumerProblems(EXPECTED, attached({
    settings: { batch_size: 10, max_retries: 5, max_wait_time_ms: 10_000 },
  }));

  assert.deepEqual(problems, ['batch_size is 10, expected 100']);
});

test('reports a consumer wired to the wrong dead-letter queue', () => {
  const problems = consumerProblems(EXPECTED, attached({ dead_letter_queue: 'somewhere-else' }));

  assert.deepEqual(problems, ['dead_letter_queue is somewhere-else, expected avalon-migration-reports-dead-letter']);
});

test('reports a queue that does not exist at all', () => {
  assert.match(consumerProblems(EXPECTED, null)[0], /does not exist in this account/u);
});

test('treats an unauthenticated 200 as the failure, not as success', () => {
  assert.deepEqual(siteProblems(302), []);
  assert.deepEqual(siteProblems(403), []);
  assert.equal(siteProblems(200).length, 1);
  assert.match(siteProblems(200)[0], /served unauthenticated/u);
  assert.match(siteProblems(500)[0], /not serving/u);
});

test('finds the queue across pages rather than reading only the first', async () => {
  const pages = [];
  const fetchImpl = async (input) => {
    const page = Number(new URL(input).searchParams.get('page'));
    pages.push(page);
    const result = page === 1
      ? Array.from({ length: 100 }, (unused, index) => ({ queue_name: `filler-${index}` }))
      : [attached()];
    return Response.json({ success: true, result });
  };

  const queue = await findQueue({
    accountId: 'a',
    token: 't',
    fetchImpl,
    queueName: 'avalon-migration-reports',
  });

  assert.equal(queue.queue_name, 'avalon-migration-reports');
  assert.deepEqual(pages, [1, 2]);
});

test('passes and reports what it verified when the deployment is wired up', async () => {
  const lines = [];

  await checkMigrationTrackerHealth({
    environment,
    expected: EXPECTED,
    log: (line) => lines.push(line),
    fetchImpl: queueListing([attached()]),
  });

  assert.ok(lines.some((line) => line.includes('Queue consumer attached')));
  assert.ok(lines.some((line) => line.includes('batch_size=100')));
});

test('fails when the consumer is missing', async () => {
  await assert.rejects(
    checkMigrationTrackerHealth({
      environment,
      expected: EXPECTED,
      log: () => {},
      fetchImpl: queueListing([{ queue_name: 'avalon-migration-reports', consumers: [] }]),
    }),
    /is not a consumer of/u,
  );
});

test('checks the site only when the Wrangler file declares a hostname', async () => {
  const requested = [];
  const fetchImpl = async (input, init) => {
    requested.push(String(input));
    if (String(input).startsWith('https://migrations.')) {
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302 });
    }
    return Response.json({ success: true, result: [attached()] });
  };

  await checkMigrationTrackerHealth({
    environment,
    expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
    log: () => {},
    fetchImpl,
  });

  assert.ok(requested.includes('https://migrations.internal.rallywith.ai/'));
});

test('fails when the site serves the fleet to an unauthenticated caller', async () => {
  const fetchImpl = async (input) => (String(input).startsWith('https://migrations.')
    ? new Response('<h1>Objects</h1>', { status: 200 })
    : Response.json({ success: true, result: [attached()] }));

  await assert.rejects(
    checkMigrationTrackerHealth({
      environment,
      expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
      log: () => {},
      fetchImpl,
    }),
    /served unauthenticated/u,
  );
});

test('fails when the hostname cannot be reached at all', async () => {
  const fetchImpl = async (input) => {
    if (String(input).startsWith('https://migrations.')) throw new Error('ENOTFOUND');
    return Response.json({ success: true, result: [attached()] });
  };

  await assert.rejects(
    checkMigrationTrackerHealth({
      environment,
      expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
      log: () => {},
      fetchImpl,
      siteAttempts: 3,
      siteTimeoutMs: 50,
      wait: async () => {},
    }),
    /could not be reached/u,
  );
});

/**
 * The regression this retry exists for. Wrangler returns once the script
 * uploads, and a deploy that provisions a *new* custom domain leaves the route
 * unresolvable for some seconds after that — which is how the first CI run of
 * this check failed one second after an entirely correct deploy.
 */
test('waits for a route that is still propagating rather than calling it broken', async () => {
  let siteCalls = 0;
  const waits = [];
  const fetchImpl = async (input) => {
    if (!String(input).startsWith('https://migrations.')) {
      return Response.json({ success: true, result: [attached()] });
    }
    siteCalls += 1;
    if (siteCalls < 3) throw new TypeError('fetch failed');
    return new Response(null, { status: 302 });
  };

  const lines = [];
  await checkMigrationTrackerHealth({
    environment,
    expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
    log: (line) => lines.push(line),
    fetchImpl,
    siteAttempts: 6,
    siteTimeoutMs: 50,
    wait: async (ms) => { waits.push(ms); },
  });

  assert.equal(siteCalls, 3);
  // Linear, so a slow propagation is waited out rather than backed off from.
  assert.deepEqual(waits, [4_000, 8_000]);
  assert.ok(lines.some((line) => line.includes('not reachable (')));
  assert.ok(lines.some((line) => line.includes('answered HTTP 302')));
});

/**
 * The bound the retry budget claims. `fetch` with no signal does not time out on
 * any useful scale — a connection accepted and never answered stays pending for
 * undici's default five minutes — so six attempts could outlast the deploy
 * workflow's own timeout while holding its serialized concurrency group. The
 * signal is what turns "roughly two minutes" from a wish into a guarantee.
 */
test('bounds every attempt with a timeout signal rather than waiting forever', async () => {
  const signals = [];
  let siteCalls = 0;
  const fetchImpl = async (input, init) => {
    if (!String(input).startsWith('https://migrations.')) {
      return Response.json({ success: true, result: [attached()] });
    }
    siteCalls += 1;
    signals.push(init?.signal);
    if (siteCalls < 2) {
      // What an aborted request actually throws, so the retry path is exercised
      // by the real shape rather than a stand-in.
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    }
    return new Response(null, { status: 302 });
  };

  const lines = [];
  await checkMigrationTrackerHealth({
    environment,
    expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
    log: (line) => lines.push(line),
    fetchImpl,
    siteTimeoutMs: 50,
    wait: async () => {},
  });

  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  // The reason is named in the log, so a hung far end is distinguishable from a
  // refused connection when reading the job output.
  assert.ok(lines.some((line) => line.includes('no response within')));
});

/**
 * A route can resolve before the Worker has reached that edge, which is the
 * same propagation phenomenon one layer up from DNS. Retrying it is the whole
 * point of the change; not retrying it would mean the check waited for the name
 * and then failed the deploy the moment the name arrived.
 */
test('retries a 5xx, which is propagation one layer up from DNS', async () => {
  let siteCalls = 0;
  const waits = [];
  const fetchImpl = async (input) => {
    if (!String(input).startsWith('https://migrations.')) {
      return Response.json({ success: true, result: [attached()] });
    }
    siteCalls += 1;
    return siteCalls < 3
      ? new Response('bad gateway', { status: 502 })
      : new Response(null, { status: 302 });
  };

  const lines = [];
  await checkMigrationTrackerHealth({
    environment,
    expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
    log: (line) => lines.push(line),
    fetchImpl,
    siteTimeoutMs: 50,
    wait: async (ms) => { waits.push(ms); },
  });

  assert.equal(siteCalls, 3);
  assert.deepEqual(waits, [4_000, 8_000]);
  assert.ok(lines.some((line) => line.includes('answered HTTP 502')));
  assert.ok(lines.some((line) => line.includes('answered HTTP 302')));
});

test('says the budget was spent rather than failing silently', async () => {
  const lines = [];
  const fetchImpl = async (input) => {
    if (String(input).startsWith('https://migrations.')) throw new Error('ENOTFOUND');
    return Response.json({ success: true, result: [attached()] });
  };

  await assert.rejects(checkMigrationTrackerHealth({
    environment,
    expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
    log: (line) => lines.push(line),
    fetchImpl,
    siteAttempts: 3,
    siteTimeoutMs: 50,
    wait: async () => {},
  }), /could not be reached/u);

  // Without this the output is three "retrying" lines and then a bare failure,
  // with nothing distinguishing a spent budget from an abandoned attempt.
  assert.ok(lines.some((line) => line.includes('never settled after 3 attempts')));
});

test('reports an exhausted 5xx as the status it served, not as unreachable', async () => {
  const fetchImpl = async (input) => (String(input).startsWith('https://migrations.')
    ? new Response('worker threw', { status: 500 })
    : Response.json({ success: true, result: [attached()] }));

  await assert.rejects(
    checkMigrationTrackerHealth({
      environment,
      expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
      log: () => {},
      fetchImpl,
      siteAttempts: 3,
      siteTimeoutMs: 50,
      wait: async () => {},
    }),
    // A Worker that is genuinely throwing must not be reported as a missing
    // host: the two have completely different fixes.
    /answered HTTP 500, so the Worker is not serving/u,
  );
});

test('does not retry a route that answered, however wrong the answer', async () => {
  let siteCalls = 0;
  const fetchImpl = async (input) => {
    if (!String(input).startsWith('https://migrations.')) {
      return Response.json({ success: true, result: [attached()] });
    }
    siteCalls += 1;
    return new Response('<h1>Objects</h1>', { status: 200 });
  };

  await assert.rejects(
    checkMigrationTrackerHealth({
      environment,
      expected: { ...EXPECTED, hostname: 'migrations.internal.rallywith.ai' },
      log: () => {},
      fetchImpl,
      siteAttempts: 6,
      siteTimeoutMs: 50,
      wait: async () => { throw new Error('must not wait after a real response'); },
    }),
    /served unauthenticated/u,
  );
  // A response is an answer. Asking five more times would only delay the report.
  assert.equal(siteCalls, 1);
});

test('requires the credentials rather than reporting a vacuous pass', async () => {
  await assert.rejects(
    checkMigrationTrackerHealth({ environment: {}, log: () => {}, fetchImpl: queueListing([]) }),
    /CLOUDFLARE_ACCOUNT_ID is required/u,
  );
});
