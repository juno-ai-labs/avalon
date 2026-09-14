import { configuredRegions } from "./regions.mjs";
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
 * It used to stop and print the `wrangler queues create` command instead, and
 * the changelog in docs/durable-object-migration-tracking.md records why that
 * changed. `--check` keeps that read-only form for a laptop: it reports what a
 * deploy would create and fails if anything is missing, without creating it.
 *
 * Two things are still refused rather than provisioned. A queue that only one
 * side of the Wrangler files names — a producer with no consumer anywhere, or
 * the reverse — is a typo, and creating it would ship a queue nothing drains,
 * where the dead-letter signal that is this platform's monitoring can never
 * fire. And a dead-letter queue is left to Cloudflare, which creates one named
 * in a consumer's `dead_letter_queue` on first deploy; creating it here would
 * reimplement the platform.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_QUEUE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u;
/** Cloudflare's "Authentication error": the token lacks the permission. */
const PERMISSION_ERROR_CODE = 10000;
const LISTING_PAGE_LIMIT = 20;
const LISTING_PAGE_SIZE = 100;

/** Every Wrangler file that binds a queue, and the surface each one deploys. */
const queueConfigs = [
  ...configuredRegions.map((region) => ({ surface: `api-${region}`, path: join(repositoryDirectory, `apps/api/wrangler.${region}.jsonc`) })),
  {
    surface: 'migration-tracker',
    path: join(repositoryDirectory, 'apps/migration-tracker/wrangler.jsonc'),
  },
  { surface: 'ace', path: join(repositoryDirectory, 'apps/ace/wrangler.jsonc') },
];

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to ensure Cloudflare Queue resources exist`);
  return value;
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
    const role = `producer:${producer.binding ?? 'unknown'}`;
    required.push({ surface, role, name: assertSafe(surface, role, producer.queue) });
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

/**
 * Every required queue must be named by a producer somewhere and a consumer
 * somewhere, across all the Wrangler files together — a per-region queue pairs
 * inside one file, the shared report queue pairs across three. A name on only
 * one side is a misspelling, and the deploy that attached it would go green
 * while the real queue backed up behind no consumer, or messages went into a
 * queue nothing drains. This is the failure the old fail-and-name-it gate
 * caught by accident; now it is caught on purpose, before any create.
 */
export function assertPairedQueues(required) {
  const roles = new Map();
  for (const queue of required) {
    const sides = roles.get(queue.name) ?? { producers: [], consumers: [] };
    (queue.role === 'consumer' ? sides.consumers : sides.producers).push(`${queue.surface}/${queue.role}`);
    roles.set(queue.name, sides);
  }
  const unpaired = [...roles]
    .filter(([, sides]) => sides.producers.length === 0 || sides.consumers.length === 0)
    .map(([name, sides]) => sides.producers.length === 0
      ? `${name} has consumer ${sides.consumers.join(', ')} but no producer`
      : `${name} has producer ${sides.producers.join(', ')} but no consumer`);
  if (unpaired.length > 0) {
    throw new Error(
      'Every queue a Wrangler file declares must be named by both a producer and a consumer.'
      + ` Check the spelling of:\n${unpaired.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}

/**
 * A queue may be consumed by exactly one Worker.
 *
 * That is a Cloudflare limit rather than a convention, and it is the one shape
 * of "declared in the wrong file" that `assertPairedQueues` cannot see: two
 * consumers pair just as well as one. Nothing local refuses it — Wrangler
 * accepts the file, and the create above succeeds — so the failure surfaces at
 * the *second* deployment, after the first has already shipped and attached
 * itself. A regional queue pasted into both regional files is the way to get
 * there, and it is a plausible edit rather than a hypothetical one.
 */
export function assertSingleConsumerPerQueue(required) {
  const consumers = new Map();
  for (const queue of required) {
    if (queue.role !== 'consumer') continue;
    consumers.set(queue.name, [...(consumers.get(queue.name) ?? []), queue.surface]);
  }
  const shared = [...consumers]
    .filter(([, surfaces]) => surfaces.length > 1)
    .map(([name, surfaces]) => `  ${name} is consumed by ${surfaces.join(' and ')}`);
  if (shared.length > 0) {
    throw new Error(
      'Cloudflare allows one consumer per queue, and these have more than one.'
      + ` Split the queue, or move the consumer to the Worker that owns the work:\n${shared.join('\n')}`,
    );
  }
}

function queuesUrl(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/queues`;
}

/** `HTTP 403: Authentication error [code: 10000]` — the status plus what Cloudflare said. */
function describeFailure(response, body) {
  const detail = (body?.errors ?? [])
    .map((error) => `${error.message} [code: ${error.code}]`)
    .join('; ');
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}

function permissionRefused(response, body) {
  return response.status === 401 || response.status === 403
    || (body?.errors ?? []).some((error) => error.code === PERMISSION_ERROR_CODE);
}

/** Every queue name the account holds, following Cloudflare's pagination. */
export async function listAccountQueues({ accountId, token, fetchImpl }) {
  const names = new Set();
  for (let page = 1; page <= LISTING_PAGE_LIMIT; page += 1) {
    const response = await fetchImpl(
      `${queuesUrl(accountId)}?page=${page}&per_page=${LISTING_PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) {
      throw new Error(`Listing Cloudflare Queues failed with ${describeFailure(response, body)}.`);
    }
    const results = body.result ?? [];
    for (const queue of results) names.add(queue.queue_name);
    if (results.length < LISTING_PAGE_SIZE) return names;
  }
  // A listing that stops here is incomplete, and an incomplete listing would
  // make this script try to create queues that already exist. Say so rather
  // than report a failure that reads as a platform bug.
  throw new Error(
    `Listing Cloudflare Queues stopped after ${LISTING_PAGE_LIMIT} pages`
    + ` (${LISTING_PAGE_LIMIT * LISTING_PAGE_SIZE} queues) without reaching the end; raise LISTING_PAGE_LIMIT.`,
  );
}

class QueueCreateError extends Error {
  constructor(message, { permission = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'QueueCreateError';
    this.permission = permission;
  }
}

/**
 * Create one queue, the same call `wrangler queues create` makes. The name is
 * the only setting: batch size, retries, and the dead-letter reference belong
 * to the consumer, and Wrangler applies those on every deploy.
 */
export async function createAccountQueue({ accountId, token, fetchImpl, name }) {
  // Validate where the mutation happens, not only where the config is parsed:
  // a caller that builds its own list must not be able to post an arbitrary
  // string at the account.
  assertSafe('create', 'queue', name);
  let response;
  try {
    response = await fetchImpl(queuesUrl(accountId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue_name: name }),
    });
  } catch (cause) {
    throw new QueueCreateError(`Creating Cloudflare Queue ${name} failed: ${cause.message}`, { cause });
  }
  const body = await response.json().catch(() => null);
  if (response.ok && body?.success === true) return;

  // Name the likely cause rather than the status: this runs in a deploy
  // pipeline, and the next thing the reader wants is the fix. Code 10000 on a
  // create is what a token without Queues Edit returns; the same token can
  // still list, so the preflight gets this far before it finds out.
  const permission = permissionRefused(response, body);
  const hint = permission
    ? ' The token must hold Queues Edit on the account; docs/runbook.md lists the required permissions.'
    : '';
  throw new QueueCreateError(
    `Creating Cloudflare Queue ${name} failed with ${describeFailure(response, body)}.${hint}`,
    { permission },
  );
}

/**
 * Options: `create: false` is `--check` — report what a deploy would create and
 * fail if anything is missing, without touching the account.
 */
export async function ensureRequiredQueues(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const create = options.create ?? true;
  const accountId = required('CLOUDFLARE_ACCOUNT_ID', environment);
  const token = required('CLOUDFLARE_API_TOKEN', environment);
  const declared = options.queues ?? await configuredQueues();
  assertPairedQueues(declared.required);
  assertSingleConsumerPerQueue(declared.required);
  const account = { accountId, token, fetchImpl };
  const present = await listAccountQueues(account);

  const missing = [...new Set(
    declared.required.filter((queue) => !present.has(queue.name)).map((queue) => queue.name),
  )];
  if (!create && missing.length > 0) {
    throw new Error(
      `Missing Cloudflare Queue(s): ${missing.join(', ')}. The deployment creates them;`
      + ' to create them now, run `pnpm cloudflare:queues:ensure`.',
    );
  }

  const created = new Set();
  for (const name of missing) {
    try {
      await createAccountQueue({ ...account, name });
      log(`Created Queue ${name}`);
    } catch (error) {
      // A refused permission is never a race, and it must surface: the other
      // deployment winning the race on this name would otherwise hide a token
      // that can no longer create until the next release that needs it to.
      if (error.permission) throw error;
      // Two deployments can run this at once — the API and the migration
      // tracker both declare `avalon-migration-reports` — and the loser's
      // create is refused as a duplicate. What matters is that the queue
      // exists, so look again before failing: if it is there now, somebody
      // else made it and this run is done. The outcome is checked rather than
      // Cloudflare's duplicate-name error code, which is undocumented surface.
      let now;
      try {
        now = await listAccountQueues(account);
      } catch {
        throw error;
      }
      if (!now.has(name)) throw error;
      log(`Queue ${name} exists after this run's create was refused (${error.message}); a concurrent deployment created it`);
    }
    created.add(name);
  }

  for (const queue of declared.required) {
    log(`Required Queue ${created.has(queue.name) ? 'created' : 'present'}: ${queue.surface}/${queue.role} -> ${queue.name}`);
  }
  for (const queue of declared.createdOnDeploy) {
    log(present.has(queue.name)
      ? `Dead-letter Queue present: ${queue.surface} -> ${queue.name}`
      : `Dead-letter Queue ${queue.name} will be created on first deploy of ${queue.surface}`);
  }
  return declared;
}

if (isEntryPoint(import.meta.url)) {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((flag) => flag !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. The only flag is --check.`);
  await ensureRequiredQueues({ create: !flags.includes('--check') });
}
