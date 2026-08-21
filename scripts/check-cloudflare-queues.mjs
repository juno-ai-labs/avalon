/**
 * Prove every Queue the Wrangler files declare actually exists.
 *
 * Wrangler is a deployment tool, not a provisioner. It applies a consumer's
 * settings — batch size, batch timeout, retries — on every deploy, so those are
 * already infrastructure-as-code and drift back on the next release. What it
 * does not do is create the queue a producer binding names: that fails the
 * deploy. This is the same gap `check-cloudflare-r2-buckets.mjs` covers for R2,
 * and the same answer: the Wrangler file stays the single source of truth, and
 * this preflight turns "did somebody remember to create it" into a checked
 * invariant that runs before any deployment.
 *
 * A dead-letter queue is the exception. Cloudflare creates one named in a
 * consumer's `dead_letter_queue` if it does not exist yet, so a missing one is
 * reported rather than failed — failing there would be reimplementing something
 * the platform already does, and would block the first deploy of a fresh
 * environment for no reason.
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

/** Every queue name the account holds, following Cloudflare's pagination. */
export async function listAccountQueues({ accountId, token, fetchImpl }) {
  const names = new Set();
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
    for (const queue of results) names.add(queue.queue_name);
    if (results.length < 100) break;
  }
  return names;
}

export async function checkRequiredQueues(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const accountId = required('CLOUDFLARE_ACCOUNT_ID', environment);
  const token = required('CLOUDFLARE_API_TOKEN', environment);
  const declared = options.queues ?? await configuredQueues();
  const present = await listAccountQueues({ accountId, token, fetchImpl });

  const missing = declared.required.filter((queue) => !present.has(queue.name));
  if (missing.length > 0) {
    // Name the command rather than the problem: this runs in a deploy pipeline,
    // and the next thing the reader wants is the fix.
    const commands = [...new Set(missing.map((queue) => queue.name))]
      .map((name) => `  wrangler queues create ${name}`)
      .join('\n');
    throw new Error(
      `Missing Cloudflare Queue(s) for ${missing.map((q) => `${q.surface}/${q.role}`).join(', ')}.`
      + ` Create them before deploying:\n${commands}`,
    );
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
  await checkRequiredQueues();
}
