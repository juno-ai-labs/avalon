/**
 * Make every Queue the Wrangler files declare exist, creating any that do not.
 *
 * Wrangler is a deployment tool, not a provisioner. It applies a consumer's
 * settings — batch size, batch timeout, retries — on every deploy, so those are
 * already infrastructure-as-code and drift back on the next release. What it
 * does not do is create the queue a producer binding names: that fails the
 * deploy. The Wrangler file stays the single source of truth, and this preflight
 * closes the one gap the platform leaves: it reads every declared queue, lists
 * the account, and creates whichever are missing before anything deploys. A
 * release that adds a binding provisions its own queue on the way out; nothing
 * about a queue is done by hand.
 *
 * It used to stop and print the `wrangler queues create` command instead. That
 * turned every release that added a binding into a failed deploy plus a manual
 * step — the one thing a pipeline exists to remove — and blocked five merges in
 * an afternoon the first time it fired for real. The changelog in
 * docs/durable-object-migration-tracking.md records the change.
 *
 * A dead-letter queue is the exception. Cloudflare creates one named in a
 * consumer's `dead_letter_queue` if it does not exist yet, so it is reported
 * rather than created — creating it here would be reimplementing something the
 * platform already does.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_QUEUE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u;

/** Every Wrangler file that binds a queue, and the surface each one deploys. */
const queueConfigs = [
  { surface: 'api-global', path: join(repositoryDirectory, 'apps/api/wrangler.global.jsonc') },
  { surface: 'api-eu', path: join(repositoryDirectory, 'apps/api/wrangler.eu.jsonc') },
  {
    surface: 'migration-tracker',
    path: join(repositoryDirectory, 'apps/migration-tracker/wrangler.jsonc'),
  },
];

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to check Cloudflare Queue resources`);
  return value;
}

/**
 * Strip JSONC comments without touching string contents.
 *
 * A regex cannot do this: these files contain `https://` inside `vars`, and a
 * naive `//` strip would truncate every one of them. Tracking the string state
 * is the whole difference between a parser and a corruption.
 */
export function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
        output += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (character === '\\') {
        output += next ?? '';
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += character;
  }

  // Wrangler files are hand-edited, so a trailing comma before a closer is
  // ordinary there and fatal to JSON.parse.
  return output.replace(/,(\s*[}\]])/gu, '$1');
}

export function parseWranglerConfig(source) {
  return JSON.parse(stripJsonComments(source));
}

function assertSafe(surface, role, name) {
  if (typeof name !== 'string' || !SAFE_QUEUE.test(name)) {
    throw new Error(`Unsafe queue name in ${surface}/${role}: ${String(name)}`);
  }
  return name;
}

/**
 * The queues one Wrangler file declares.
 *
 * `required` must exist before that surface deploys; `createdOnDeploy` is the
 * dead-letter set, which Cloudflare provisions on first deploy.
 */
export function queuesFromWrangler(source, surface) {
  const config = parseWranglerConfig(source);
  const queues = config.queues ?? {};
  const required = [];
  const createdOnDeploy = [];

  for (const producer of queues.producers ?? []) {
    required.push({
      surface,
      role: `producer:${producer.binding ?? 'unknown'}`,
      name: assertSafe(surface, `producer:${producer.binding}`, producer.queue),
    });
  }
  for (const consumer of queues.consumers ?? []) {
    required.push({
      surface,
      role: 'consumer',
      name: assertSafe(surface, 'consumer', consumer.queue),
    });
    if (consumer.dead_letter_queue !== undefined) {
      createdOnDeploy.push({
        surface,
        role: 'dead_letter_queue',
        name: assertSafe(surface, 'dead_letter_queue', consumer.dead_letter_queue),
      });
    }
  }

  return { required, createdOnDeploy };
}

export async function configuredQueues() {
  const required = [];
  const createdOnDeploy = [];
  for (const config of queueConfigs) {
    const declared = queuesFromWrangler(await readFile(config.path, 'utf8'), config.surface);
    required.push(...declared.required);
    createdOnDeploy.push(...declared.createdOnDeploy);
  }
  return { required, createdOnDeploy };
}

function queuesUrl(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/queues`;
}

/** Every queue name the account holds, following Cloudflare's pagination. */
export async function listAccountQueues({ accountId, token, fetchImpl }) {
  const names = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetchImpl(
      `${queuesUrl(accountId)}?page=${page}&per_page=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) {
      throw new Error(`Listing Cloudflare Queues failed with HTTP ${response.status}`);
    }
    const results = body.result ?? [];
    for (const queue of results) names.add(queue.queue_name);
    if (results.length < 100) break;
  }
  return names;
}

/**
 * Create one queue, the same call `wrangler queues create` makes. The name is
 * the only setting: batch size, retries, and the dead-letter reference belong
 * to the consumer, and Wrangler applies those on every deploy.
 */
export async function createAccountQueue({ accountId, token, fetchImpl, name }) {
  const response = await fetchImpl(queuesUrl(accountId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue_name: name }),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.success === true) return;

  const detail = (body?.errors ?? [])
    .map((error) => `${error.message} [code: ${error.code}]`)
    .join('; ');
  // Name the likely cause rather than the status: this runs in a deploy
  // pipeline, and the next thing the reader wants is the fix. Code 10000 on a
  // create is what a token without Queues Edit returns; the same token can
  // still list, so the preflight gets this far before it finds out.
  const hint = response.status === 403
    ? ' The token must hold Queues Edit on the account; docs/runbook.md lists the required permissions.'
    : '';
  throw new Error(
    `Creating Cloudflare Queue ${name} failed with HTTP ${response.status}`
    + `${detail ? `: ${detail}` : ''}.${hint}`,
  );
}

export async function ensureRequiredQueues(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const accountId = required('CLOUDFLARE_ACCOUNT_ID', environment);
  const token = required('CLOUDFLARE_API_TOKEN', environment);
  const declared = options.queues ?? await configuredQueues();
  const account = { accountId, token, fetchImpl };
  const present = await listAccountQueues(account);

  const missing = [...new Set(
    declared.required.filter((queue) => !present.has(queue.name)).map((queue) => queue.name),
  )];
  for (const name of missing) {
    try {
      await createAccountQueue({ ...account, name });
      log(`Created Queue ${name}`);
    } catch (error) {
      // Two deployments can run this at once — the API and the migration
      // tracker both declare `avalon-migration-reports` — and the loser's
      // create is refused as a duplicate. What matters is that the queue
      // exists, so look again before failing: if it is there now, somebody
      // else made it and this run is done.
      const now = await listAccountQueues(account);
      if (!now.has(name)) throw error;
      log(`Queue ${name} was created by a concurrent deployment`);
    }
    present.add(name);
  }

  for (const queue of declared.required) {
    log(`Required Queue present: ${queue.surface}/${queue.role} -> ${queue.name}`);
  }
  for (const queue of declared.createdOnDeploy) {
    log(present.has(queue.name)
      ? `Dead-letter Queue present: ${queue.surface} -> ${queue.name}`
      : `Dead-letter Queue ${queue.name} will be created on first deploy of ${queue.surface}`);
  }
  return declared;
}

if (isEntryPoint(import.meta.url)) {
  await ensureRequiredQueues();
}
