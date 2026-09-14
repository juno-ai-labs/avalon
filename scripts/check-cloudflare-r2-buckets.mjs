import { configuredRegions } from "./regions.mjs";
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u;
const regionalConfigs = configuredRegions.flatMap((region) => ['', 'artifacts.'].map((service) => ({
  region, path: join(repositoryDirectory, `apps/api/wrangler.${service}${region}.jsonc`),
})));

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to check Cloudflare R2 resources`);
  return value;
}

function stringField(source, field, requiredField = true) {
  const value = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, 'u').exec(source)?.[1];
  if (!value && requiredField) throw new Error(`R2 binding is missing ${field}`);
  return value;
}

export function r2BucketsFromWrangler(source, region) {
  const block = /"r2_buckets"\s*:\s*\[(?<body>[^\]]*)\]/u.exec(source)?.groups?.body;
  if (!block) throw new Error(`${region} Wrangler config is missing r2_buckets`);
  const objects = [...block.matchAll(/\{(?<body>[^{}]+)\}/gu)];
  if (objects.length === 0) throw new Error(`${region} Wrangler config has no R2 bindings`);
  return objects.map((match) => {
    const binding = stringField(match.groups.body, 'binding');
    const name = stringField(match.groups.body, 'bucket_name');
    const jurisdiction = stringField(match.groups.body, 'jurisdiction', false) ?? 'default';
    if (!SAFE_BUCKET.test(name)) throw new Error(`Unsafe R2 bucket name in ${region}/${binding}`);
    if (jurisdiction !== 'default' && jurisdiction !== 'eu') {
      throw new Error(`Unsupported R2 jurisdiction in ${region}/${binding}: ${jurisdiction}`);
    }
    return { region, binding, name, jurisdiction };
  });
}

export async function configuredR2Buckets() {
  const buckets = [];
  // Deduplicated on the whole tuple, not on the bucket name: the artifact
  // Workers bind the same buckets as the API Worker, so an identical binding
  // collapses — but one that differs in `jurisdiction` stays a separate row and
  // gets checked against the jurisdiction it actually names. Keying on the name
  // alone would let a correct binding mask a wrong one.
  const seen = new Set();
  for (const config of regionalConfigs) {
    for (const bucket of r2BucketsFromWrangler(await readFile(config.path, 'utf8'), config.region)) {
      const key = `${bucket.region}/${bucket.binding}/${bucket.name}/${bucket.jurisdiction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buckets.push(bucket);
    }
  }
  return buckets;
}

export async function checkRequiredR2Buckets(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const accountId = required('CLOUDFLARE_ACCOUNT_ID', environment);
  const token = required('CLOUDFLARE_API_TOKEN', environment);
  const buckets = options.buckets ?? await configuredR2Buckets();
  for (const bucket of buckets) {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${bucket.name}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(bucket.jurisdiction === 'eu' ? { 'cf-r2-jurisdiction': 'eu' } : {}),
        },
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true || body.result?.name !== bucket.name) {
      throw new Error(
        `${bucket.region}/${bucket.binding} requires R2 bucket ${bucket.name} (${bucket.jurisdiction}); Cloudflare returned HTTP ${response.status}`,
      );
    }
    log(`Required R2 bucket present: ${bucket.region}/${bucket.binding} -> ${bucket.name} (${bucket.jurisdiction})`);
  }
  return buckets;
}

if (isEntryPoint(import.meta.url)) {
  await checkRequiredR2Buckets();
}
