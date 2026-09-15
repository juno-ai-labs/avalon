import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { isEntryPoint } from './entry-point.mjs';
import { normalizeReleasePrefix, parseMacUpdateFeed } from './release-lib.mjs';
import { purgeCloudflareUrls } from './release-cache.mjs';
import {
  R2ReleaseLockHeldError,
  createR2ReleaseLockClient,
  withR2ReleaseLock,
} from './release-r2-lock.mjs';
import {
  FASTER_RELEASE_MANIFEST,
  STABLE_CHANNEL_RECEIPT,
  STABLE_RELEASE_MANIFEST,
  decideStableChannelPromotion,
  encodeStableChannelReceipt,
  parseStableChannelReceipt,
} from './release-channels.mjs';

const releaseLockName = 'release-publish.lock';

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Set ${name} before promoting the Stable desktop channel`);
  return value;
}

function releaseOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('RALLY_RELEASE_BASE_URL must be an HTTPS origin');
  }
  return url.origin;
}

function isMissingObject(error) {
  return error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.$metadata?.httpStatusCode === 404;
}

async function readR2Object(client, bucket, key) {
  let response;
  try {
    response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw new Error(`Could not read r2://${bucket}/${key}`, { cause: error });
  }
  if (!response.Body) throw new Error(`R2 returned no body for r2://${bucket}/${key}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

async function writeR2Object(client, bucket, key, bytes, { cacheControl, contentType }) {
  await client.send(new PutObjectCommand({
    Body: bytes,
    Bucket: bucket,
    CacheControl: cacheControl,
    ContentType: contentType,
    Key: key,
  }));
}

function parseReceiptBytes(bytes) {
  if (!bytes) return undefined;
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Stable channel receipt is not valid JSON', { cause: error });
  }
  return parseStableChannelReceipt(value);
}

/**
 * Reconcile the newest Faster pointer into Stable. Faster itself is the durable
 * pending candidate, so no second queue or candidate receipt is required.
 */
export async function promoteScheduledStableChannel({
  fasterManifestBytes,
  now = Date.now,
  publishStableManifest,
  publishStableReceipt,
  stableManifestBytes,
  stableReceiptBytes,
}) {
  if (!stableManifestBytes && !fasterManifestBytes) {
    if (stableReceiptBytes) {
      throw new Error('Stable channel receipt exists without Stable and Faster manifests');
    }
    return { changed: false, reason: 'channels_absent' };
  }
  if (!stableManifestBytes || !fasterManifestBytes) {
    throw new Error('Stable and Faster manifests must either both exist or both be absent');
  }

  const stableFeed = parseMacUpdateFeed(stableManifestBytes.toString('utf8'));
  const fasterFeed = parseMacUpdateFeed(fasterManifestBytes.toString('utf8'));
  if (stableFeed.version === fasterFeed.version && !stableManifestBytes.equals(fasterManifestBytes)) {
    throw new Error(`Stable and Faster have different manifest bytes for Rally ${stableFeed.version}`);
  }
  const stableReceipt = parseReceiptBytes(stableReceiptBytes);
  const decision = decideStableChannelPromotion({
    candidateVersion: fasterFeed.version,
    stableVersion: stableFeed.version,
    receipt: stableReceipt,
    now: now(),
  });

  let nextReceipt = decision.receipt;
  if (decision.promote) {
    await publishStableManifest(fasterManifestBytes);
    // The interval begins only after the public Stable pointer is verified.
    nextReceipt = {
      version: fasterFeed.version,
      promotedAt: new Date(now()).toISOString(),
    };
  }
  if (!stableReceipt
    || nextReceipt.version !== stableReceipt.version
    || nextReceipt.promotedAt !== stableReceipt.promotedAt) {
    await publishStableReceipt(encodeStableChannelReceipt(nextReceipt));
  }
  return {
    changed: decision.promote || decision.reason === 'receipt_repaired',
    reason: decision.reason,
    stableVersion: nextReceipt.version,
  };
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function verifyPublicManifest({ expectedBytes, fetchImplementation, url }) {
  let failure = 'no response';
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(30_000),
      });
      const actual = Buffer.from(await response.arrayBuffer());
      if (response.ok && actual.equals(expectedBytes)) return;
      failure = `HTTP ${response.status}; manifest bytes did not match`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 6) await sleep(500 * 2 ** attempt);
  }
  throw new Error(`Public manifest verification failed for ${url}: ${failure}`);
}

export async function runScheduledStablePromotion({
  client,
  environment = process.env,
  fetchImplementation = fetch,
  now = Date.now,
}) {
  const bucket = required('RALLY_RELEASE_R2_BUCKET', environment);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error(`Invalid R2 release bucket: ${bucket}`);
  }
  const prefix = normalizeReleasePrefix(required('RALLY_RELEASE_PREFIX', environment));
  const origin = releaseOrigin(required('RALLY_RELEASE_BASE_URL', environment));
  const apiToken = required('CLOUDFLARE_API_TOKEN', environment);
  const zoneId = required('CLOUDFLARE_ZONE_ID', environment);
  const key = (name) => `${prefix}/${name}`;
  const publicStableUrl = new URL(
    [...prefix.split('/'), STABLE_RELEASE_MANIFEST].map(encodeURIComponent).join('/'),
    `${origin}/`,
  ).toString();

  const result = await promoteScheduledStableChannel({
    fasterManifestBytes: await readR2Object(client, bucket, key(FASTER_RELEASE_MANIFEST)),
    stableManifestBytes: await readR2Object(client, bucket, key(STABLE_RELEASE_MANIFEST)),
    stableReceiptBytes: await readR2Object(client, bucket, key(STABLE_CHANNEL_RECEIPT)),
    now,
    publishStableManifest: async (bytes) => {
      await writeR2Object(client, bucket, key(STABLE_RELEASE_MANIFEST), bytes, {
        cacheControl: 'public, max-age=0, must-revalidate',
        contentType: 'application/yaml; charset=utf-8',
      });
      await purgeCloudflareUrls({
        apiToken,
        fetchImplementation,
        urls: [publicStableUrl],
        zoneId,
      });
      await verifyPublicManifest({ expectedBytes: bytes, fetchImplementation, url: publicStableUrl });
    },
    publishStableReceipt: async (bytes) => {
      const receiptKey = key(STABLE_CHANNEL_RECEIPT);
      await writeR2Object(client, bucket, receiptKey, bytes, {
        cacheControl: 'no-store',
        contentType: 'application/json; charset=utf-8',
      });
      const stored = await readR2Object(client, bucket, receiptKey);
      if (!stored?.equals(bytes)) {
        throw new Error(`Stable channel receipt verification failed for r2://${bucket}/${receiptKey}`);
      }
    },
  });

  if (result.reason === 'channels_absent') {
    console.log('Stable promotion skipped: channel manifests have not been bootstrapped');
  } else if (result.reason === 'cooldown_elapsed') {
    console.log(`Promoted Stable to Rally ${result.stableVersion}`);
  } else if (result.reason === 'receipt_repaired') {
    console.log(`Repaired the Stable receipt for Rally ${result.stableVersion}; promotion remains delayed`);
  } else {
    console.log(`Kept Stable on Rally ${result.stableVersion} (${result.reason})`);
  }
  return result;
}

export async function main(environment = process.env) {
  const accountId = required('CLOUDFLARE_ACCOUNT_ID', environment);
  const apiToken = required('CLOUDFLARE_API_TOKEN', environment);
  const client = await createR2ReleaseLockClient({ accountId, apiToken });
  try {
    await withR2ReleaseLock({
      bucket: required('RALLY_RELEASE_R2_BUCKET', environment),
      client,
      key: `${normalizeReleasePrefix(required('RALLY_RELEASE_PREFIX', environment))}/${releaseLockName}`,
      operation: async () => await runScheduledStablePromotion({ client, environment }),
    });
  } catch (error) {
    if (error instanceof R2ReleaseLockHeldError) {
      console.log('Stable promotion deferred because a desktop release publisher is active');
      return;
    }
    throw error;
  } finally {
    client.destroy();
  }
}

if (isEntryPoint(import.meta.url)) {
  await main();
}
