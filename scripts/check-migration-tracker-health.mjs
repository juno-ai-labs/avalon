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
 * The expectations come from `apps/migration-tracker/wrangler.jsonc`, so this
 * cannot drift from what the deploy applies — there is no second copy of the
 * batch size here to keep in step.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWranglerConfig } from './check-cloudflare-queues.mjs';
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
    // `redirect: manual` on purpose: Access answers with a 302 to its login
    // page, and following it would report the identity provider's health
    // instead of this Worker's.
    const response = await fetchImpl(url, { redirect: 'manual' })
      .catch((error) => ({ status: 0, error }));
    if (response.status === 0) {
      problems.push(`${url} could not be reached: ${String(response.error)}`);
    } else {
      problems.push(...siteProblems(response.status));
      if (siteProblems(response.status).length === 0) {
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
