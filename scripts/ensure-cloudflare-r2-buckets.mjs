import { configuredRegions } from "./regions.mjs";
/**
 * Make every R2 bucket the Wrangler files declare exist, creating any that do not.
 *
 * Wrangler will not create the bucket a binding names; a deploy that adds one
 * fails, and the browser host's build archive needs its bucket before it
 * deploys at all. The Wrangler files stay the single source of truth: this
 * reads every declared bucket, looks each one up, and creates whichever are
 * missing, in the jurisdiction its binding names. Nothing about a bucket is a
 * manual step, so a fresh account (an open-source deployment included) is set
 * up by its first release.
 *
 * It used to only check and fail, as the queue preflight once did
 * (`ensure-cloudflare-queues.mjs` records why that changed). `--check` keeps
 * that read-only form for a laptop: it reports what a deploy would create and
 * fails if anything is missing, without creating it.
 *
 * Only the name and jurisdiction are provisioned. A location hint, storage
 * class, lifecycle rule or CORS policy is not in the Wrangler file, so it is
 * not set here; the buckets that need one (docs/runbook.md) stay explicit.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u;
/** Cloudflare's "Authentication error": the token lacks the permission. */
const PERMISSION_ERROR_CODE = 10000;

/**
 * Every Wrangler file whose buckets a deploy may create. `apps/release-retention`
 * is left out on purpose: its archive bucket needs a location hint and the
 * Infrequent Access storage class (docs/runbook.md), which a binding cannot
 * express, so creating it here would create it wrong.
 */
const bucketConfigs = [
  ...configuredRegions.flatMap((region) => ['', 'artifacts.'].map((service) => ({
    surface: `api-${service}${region}`, path: join(repositoryDirectory, `apps/api/wrangler.${service}${region}.jsonc`),
  }))),
  { surface: 'browser', path: join(repositoryDirectory, 'apps/browser/wrangler.jsonc') },
];

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to ensure Cloudflare R2 buckets exist`);
  return value;
}

function assertSafe(surface, binding, name) {
  if (typeof name !== 'string' || !SAFE_BUCKET.test(name)) {
    throw new Error(`Unsafe R2 bucket name in ${surface}/${binding}: ${String(name)}`);
  }
  return name;
}

/** The buckets one Wrangler file declares. */
export function r2BucketsFromWrangler(source, surface) {
  return (parseWranglerConfig(source).r2_buckets ?? []).map((binding) => {
    const name = assertSafe(surface, binding.binding, binding.bucket_name);
    const jurisdiction = binding.jurisdiction ?? 'default';
    if (jurisdiction !== 'default' && jurisdiction !== 'eu') {
      throw new Error(`Unsupported R2 jurisdiction in ${surface}/${binding.binding}: ${jurisdiction}`);
    }
    return { surface, binding: binding.binding, name, jurisdiction };
  });
}

export async function configuredR2Buckets() {
  const buckets = [];
  // Deduplicated on the whole tuple, not on the bucket name: the artifact
  // Workers bind the same buckets as the API Worker, so an identical binding
  // collapses, but one that differs in `jurisdiction` stays a separate row and
  // is ensured in the jurisdiction it actually names.
  const seen = new Set();
  for (const config of bucketConfigs) {
    for (const bucket of r2BucketsFromWrangler(await readFile(config.path, 'utf8'), config.surface)) {
      const key = `${bucket.name}/${bucket.jurisdiction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buckets.push(bucket);
    }
  }
  return buckets;
}

function bucketsUrl(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets`;
}

function headers(token, bucket) {
  return { Authorization: `Bearer ${token}`, ...(bucket.jurisdiction === 'eu' ? { 'cf-r2-jurisdiction': 'eu' } : {}) };
}

/** `HTTP 403: Authentication error [code: 10000]`: the status plus what Cloudflare said. */
function describeFailure(response, body) {
  const detail = (body?.errors ?? []).map((error) => `${error.message} [code: ${error.code}]`).join('; ');
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}

function permissionRefused(response, body) {
  return response.status === 401 || response.status === 403
    || (body?.errors ?? []).some((error) => error.code === PERMISSION_ERROR_CODE);
}

/** Whether the bucket exists. Any answer but found or not-found is a failure, never "missing". */
export async function bucketExists({ accountId, token, fetchImpl }, bucket) {
  const response = await fetchImpl(`${bucketsUrl(accountId)}/${bucket.name}`, { headers: headers(token, bucket) });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.success === true && body.result?.name === bucket.name) return true;
  if (response.status === 404) return false;
  const hint = permissionRefused(response, body) ? ' The token must hold Workers R2 Storage Edit; docs/runbook.md lists the required permissions.' : '';
  throw new Error(`Looking up R2 bucket ${bucket.name} (${bucket.jurisdiction}) failed with ${describeFailure(response, body)}.${hint}`);
}

class BucketCreateError extends Error {
  constructor(message, { permission = false } = {}) {
    super(message);
    this.name = 'BucketCreateError';
    this.permission = permission;
  }
}

/** Create one bucket, the same call `wrangler r2 bucket create` makes. */
export async function createBucket({ accountId, token, fetchImpl }, bucket) {
  // Validate where the mutation happens: a caller that builds its own list
  // must not be able to post an arbitrary name at the account.
  assertSafe('create', bucket.binding, bucket.name);
  const response = await fetchImpl(bucketsUrl(accountId), {
    method: 'POST',
    headers: { ...headers(token, bucket), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: bucket.name }),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.success === true) return;
  const permission = permissionRefused(response, body);
  const hint = permission ? ' The token must hold Workers R2 Storage Edit; docs/runbook.md lists the required permissions.' : '';
  throw new BucketCreateError(`Creating R2 bucket ${bucket.name} (${bucket.jurisdiction}) failed with ${describeFailure(response, body)}.${hint}`, { permission });
}

/**
 * Options: `create: false` is `--check`: report what a deploy would create and
 * fail if anything is missing, without touching the account.
 */
export async function ensureRequiredR2Buckets(options = {}) {
  const environment = options.environment ?? process.env;
  const log = options.log ?? console.log;
  const create = options.create ?? true;
  const account = {
    accountId: required('CLOUDFLARE_ACCOUNT_ID', environment),
    token: required('CLOUDFLARE_API_TOKEN', environment),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
  const buckets = options.buckets ?? await configuredR2Buckets();
  const missing = [];
  for (const bucket of buckets) if (!await bucketExists(account, bucket)) missing.push(bucket);
  if (!create && missing.length > 0) {
    throw new Error(`Missing R2 bucket(s): ${missing.map((bucket) => `${bucket.name} (${bucket.jurisdiction})`).join(', ')}.`
      + ' The deployment creates them; to create them now, run `pnpm cloudflare:r2:ensure`.');
  }
  for (const bucket of missing) {
    try {
      await createBucket(account, bucket);
      log(`Created R2 bucket ${bucket.name} (${bucket.jurisdiction}) for ${bucket.surface}/${bucket.binding}`);
    } catch (error) {
      // A refused permission must surface, never pass as a race.
      if (error.permission) throw error;
      // The API and browser deployments can run this at once, and the loser's
      // create is refused as a duplicate. What matters is that the bucket
      // exists, so look again before failing.
      if (!await bucketExists(account, bucket).catch(() => false)) throw error;
      log(`R2 bucket ${bucket.name} exists after this run's create was refused (${error.message}); a concurrent deployment created it`);
    }
  }
  for (const bucket of buckets) {
    if (!missing.includes(bucket)) log(`Required R2 bucket present: ${bucket.surface}/${bucket.binding} -> ${bucket.name} (${bucket.jurisdiction})`);
  }
  return buckets;
}

if (isEntryPoint(import.meta.url)) {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((flag) => flag !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. The only flag is --check.`);
  await ensureRequiredR2Buckets({ create: !flags.includes('--check') });
}
