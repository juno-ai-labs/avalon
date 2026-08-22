/**
 * Prove a deployed `avalon-migration-tracker` is actually wired up.
 *
 * A Wrangler deploy reports success once the script uploads, which says nothing
 * about the two things this Worker exists to do. So this checks both, against
 * the live account rather than against the config that was just applied:
 *
 * - **The queue consumer is attached, with the settings the repo declares.**
 *   This is the one that matters: a tracker that deploys without becoming a
 *   consumer of `avalon-migration-reports` looks healthy from every angle while
 *   reports pile up unread until they age out. The settings are compared too,
 *   because the batch size is what makes a single registry object affordable —
 *   a consumer silently attached at Cloudflare's default of 10 would work and
 *   cost ten times the writes.
 *
 * - **The site refuses an unauthenticated request.** From a runner with no
 *   Access cookie, a `2xx` means the fleet's schema state is being served to
 *   anyone who asks, which is a worse outcome than being down. A redirect to
 *   the Access login or the Worker's own `403` are both correct; `5xx` or a
 *   connection failure means the deploy is broken.
 *
 *   This one retries. Wrangler returns as soon as the script uploads, and on a
 *   deploy that provisions a *new* custom domain the route and its DNS record
 *   are not resolvable for some seconds afterwards. The first run of this check
 *   in CI failed for exactly that reason, one second after a deploy that was
 *   entirely correct — so a single attempt reports "the deploy is broken" when
 *   what it has actually measured is its own impatience.
 *
 *   Two conditions are treated as "not settled yet": a connection failure, and
 *   a `5xx`. They are the same phenomenon one layer apart — the name not
 *   resolving, and the route resolving to an edge that does not have the Worker
 *   yet. A `2xx`, `3xx`, or `4xx` is an answer and ends the loop immediately,
 *   so the security finding a `2xx` represents is never delayed.
 *
 * The expectations come from `apps/migration-tracker/wrangler.jsonc`, so this
 * cannot drift from what the deploy applies — there is no second copy of the
 * batch size here to keep in step.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWranglerConfig } from './wrangler-config.mjs';
import { isEntryPoint } from './entry-point.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKER_WRANGLER = join(repositoryDirectory, 'apps/migration-tracker/wrangler.jsonc');

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to check the migration tracker deployment`);
  return value;
}

/**
 * What the Wrangler file says the deployed consumer should look like.
 *
 * `max_batch_timeout` is declared in seconds and reported by the API in
 * milliseconds, which is the one unit conversion in this file and the reason it
 * is done here rather than inline at the comparison.
 */
export function expectedTrackerConsumer(wranglerSource) {
  const config = parseWranglerConfig(wranglerSource);
  const consumer = config.queues?.consumers?.[0];
  if (!consumer) throw new Error('The migration tracker Wrangler file declares no queue consumer');
  return {
    script: config.name,
    hostname: config.routes?.[0]?.pattern ?? null,
    queue: consumer.queue,
    deadLetterQueue: consumer.dead_letter_queue ?? null,
    batchSize: consumer.max_batch_size,
    maxRetries: consumer.max_retries,
    maxWaitTimeMs: consumer.max_batch_timeout * 1_000,
  };
}

/** One queue by name, following Cloudflare's pagination. */
export async function findQueue({ accountId, token, fetchImpl, queueName }) {
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`
      + `/queues?page=${page}&per_page=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) {
      throw new Error(`Listing Cloudflare Queues failed with HTTP ${response.status}`);
    }
    const results = body.result ?? [];
    const match = results.find((queue) => queue.queue_name === queueName);
    if (match) return match;
    if (results.length < 100) break;
  }
  return null;
}

/** Every way the live consumer disagrees with the Wrangler file. */
export function consumerProblems(expected, queue) {
  if (!queue) return [`the queue ${expected.queue} does not exist in this account`];
  const consumer = (queue.consumers ?? []).find((entry) => entry.script === expected.script);
  if (!consumer) {
    const others = (queue.consumers ?? []).map((entry) => entry.script).join(', ') || 'none';
    return [
      `${expected.script} is not a consumer of ${expected.queue}`
      + ` (attached consumers: ${others}).`
      + ' Reports will accumulate unread until they age out of the queue.',
    ];
  }

  const problems = [];
  const compare = (label, actual, wanted) => {
    if (actual !== wanted) problems.push(`${label} is ${String(actual)}, expected ${String(wanted)}`);
  };
  compare('dead_letter_queue', consumer.dead_letter_queue ?? null, expected.deadLetterQueue);
  compare('batch_size', consumer.settings?.batch_size, expected.batchSize);
  compare('max_retries', consumer.settings?.max_retries, expected.maxRetries);
  compare('max_wait_time_ms', consumer.settings?.max_wait_time_ms, expected.maxWaitTimeMs);
  return problems;
}

/**
 * Whether an unauthenticated response is the refusal it has to be.
 *
 * Deliberately not a list of "good" statuses: a `2xx` is the failure worth
 * catching, and it is the only one that would otherwise read as success.
 */
export function siteProblems(status) {
  if (status >= 200 && status < 300) {
    return [
      `the site answered HTTP ${status} to a request carrying no Access assertion,`
      + ' which means the fleet\'s migration state is being served unauthenticated',
    ];
  }
  if (status >= 500) return [`the site answered HTTP ${status}, so the Worker is not serving`];
  return [];
}

/**
 * How long to keep asking the hostname before believing it is not there.
 *
 * Linear rather than exponential, because the thing being waited on is DNS and
 * route propagation for a domain that was just created — a few seconds in the
 * ordinary case — not an overloaded service that needs backing off.
 *
 * The per-attempt timeout is what makes the budget a wall-clock bound rather
 * than a wish. `fetch` with no signal does not time out on any useful scale: a
 * connection that is accepted and then never answered leaves it pending for
 * undici's default five minutes, so six attempts could occupy half an hour —
 * past this workflow's twenty-minute cap, holding a serialized concurrency
 * group and blocking the next release behind a check that was supposed to take
 * a minute. Verified against a socket that accepts and stays silent.
 *
 * Worst case is therefore 6 × 10s of requests plus 4+8+12+16+20s of waiting:
 * two minutes, whatever the far end does.
 */
const SITE_ATTEMPTS = 6;
const SITE_RETRY_BASE_MS = 4_000;
const SITE_ATTEMPT_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFailure(error) {
  if (error?.name === "TimeoutError") return `no response within ${SITE_ATTEMPT_TIMEOUT_MS / 1_000}s`;
  return String(error?.message ?? error);
}

/**
 * Ask the hostname until it settles, or until the attempts run out.
 *
 * "Settled" means a response below `5xx`. A connection failure and a `5xx` are
 * both retried, for the same reason: immediately after a deploy they mean the
 * name or the Worker has not reached this edge yet. Every other response is an
 * answer and returns at once — a `2xx` is the security failure this check
 * exists to catch, and delaying it by a minute would be exactly backwards.
 *
 * On exhaustion the last `5xx` is returned rather than a synthetic failure, so
 * a Worker that is genuinely throwing is reported as the status it served
 * instead of as an unreachable host.
 */
async function reachSite(url, fetchImpl, { attempts, timeoutMs, wait, log }) {
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let outcome;
    try {
      const response = await fetchImpl(url, {
        // `manual` on purpose: Access answers with a 302 to its login page, and
        // following it would report the identity provider's health rather than
        // this Worker's.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status < 500) return response;
      lastResponse = response;
      lastError = null;
      outcome = `answered HTTP ${response.status}`;
    } catch (error) {
      lastError = error;
      lastResponse = null;
      outcome = `not reachable (${describeFailure(error)})`;
    }

    if (attempt === attempts) break;
    const delay = SITE_RETRY_BASE_MS * attempt;
    log(
      `${url} ${outcome} on attempt ${attempt}/${attempts};`
      + ` the route or the Worker may not have propagated yet, retrying in ${delay / 1_000}s`,
    );
    await wait(delay);
  }

  // Giving up is logged as loudly as waiting was. `checkRegion` in
  // `check-regional-health.mjs` does the same, and without it the job output
  // shows five "retrying" lines and then a bare failure, with nothing saying
  // the budget was spent rather than the attempt abandoned early.
  log(`${url} never settled after ${attempts} attempts`);
  return lastResponse ?? { status: 0, error: lastError };
}

/**
 * Run both checks and throw with everything that is wrong, or return the
 * expectation that was verified.
 *
 * Every dependency is injectable so the suite can drive this without a network
 * or real timers:
 *
 * - `environment` — where the Cloudflare credentials are read from.
 * - `fetchImpl` — used for both the Queues API and the site request.
 * - `expected` — skips reading `wrangler.jsonc`, for tests that want a fixture.
 * - `siteAttempts` / `siteTimeoutMs` / `wait` — the retry budget. Tests shrink
 *   the timeout and no-op the wait so the loop runs at full speed.
 * - `log` — collected by tests to assert on what an operator would read.
 */
export async function checkMigrationTrackerHealth(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const accountId = required('CLOUDFLARE_ACCOUNT_ID', environment);
  const token = required('CLOUDFLARE_API_TOKEN', environment);
  const expected = options.expected
    ?? expectedTrackerConsumer(await readFile(TRACKER_WRANGLER, 'utf8'));

  const queue = await findQueue({ accountId, token, fetchImpl, queueName: expected.queue });
  const problems = consumerProblems(expected, queue);
  if (problems.length === 0) {
    log(`Queue consumer attached: ${expected.queue} -> ${expected.script}`);
    log(
      `Consumer settings match the Wrangler file: batch_size=${expected.batchSize},`
      + ` max_retries=${expected.maxRetries}, max_wait_time_ms=${expected.maxWaitTimeMs},`
      + ` dead_letter_queue=${expected.deadLetterQueue}`,
    );
  }

  if (expected.hostname) {
    const url = `https://${expected.hostname}/`;
    const response = await reachSite(url, fetchImpl, {
      attempts: options.siteAttempts ?? SITE_ATTEMPTS,
      timeoutMs: options.siteTimeoutMs ?? SITE_ATTEMPT_TIMEOUT_MS,
      wait: options.wait ?? sleep,
      log,
    });
    if (response.status === 0) {
      problems.push(`${url} could not be reached: ${describeFailure(response.error)}`);
    } else {
      const siteIssues = siteProblems(response.status);
      problems.push(...siteIssues);
      if (siteIssues.length === 0) {
        log(`Site refuses an unauthenticated request: ${url} answered HTTP ${response.status}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`The migration tracker deployment is not healthy:\n  ${problems.join('\n  ')}`);
  }
  return expected;
}

if (isEntryPoint(import.meta.url)) {
  await checkMigrationTrackerHealth();
}
