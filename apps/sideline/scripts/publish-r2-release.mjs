import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadReleaseDirectory,
  normalizeReleasePrefix,
  releaseContentType,
  verifyFeedArtifact,
} from '../../desktop/scripts/release-lib.mjs';
import {
  purgeCloudflarePrefix,
  verifyPublicReleaseArtifactHash,
} from '../../desktop/scripts/release-cache.mjs';
import { publishSidelineRelease } from './release-publication.mjs';

const sidelineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(sidelineDirectory, '../..');
const releaseDirectory = resolve(process.argv[2] ?? join(sidelineDirectory, 'release/release'));

function required(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`Set ${name} before publishing Sideline`);
  return value;
}

const bucket = required('SIDELINE_RELEASE_R2_BUCKET', process.env.RALLY_RELEASE_R2_BUCKET?.trim());
const prefix = normalizeReleasePrefix(required('SIDELINE_RELEASE_PREFIX', 'sideline/stable/darwin/arm64'));
const origin = new URL(required('SIDELINE_RELEASE_BASE_URL', 'https://downloads.rallywith.ai'));
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('SIDELINE_RELEASE_BASE_URL must be an HTTPS origin');
}
const accountId = required('CLOUDFLARE_ACCOUNT_ID');
const apiToken = required('CLOUDFLARE_API_TOKEN');
const zoneId = required('CLOUDFLARE_ZONE_ID');
const release = await loadReleaseDirectory(releaseDirectory);
await verifyFeedArtifact(release);

function publicUrl(name) {
  const parts = [...prefix.split('/'), ...name.split('/')];
  if (parts.some((part) => !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(part))) {
    throw new Error(`Invalid Sideline release object name: ${name}`);
  }
  return new URL(parts.map(encodeURIComponent).join('/'), origin).toString();
}

const channelPrefixUrl = new URL(`${prefix}/`, origin).toString();

function objectUrl(key) {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`
    + `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encoded}`;
}

async function getObjectResponse(key) {
  const response = await fetch(objectUrl(key), {
    headers: { authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok || !response.body) throw new Error(`Could not inspect r2://${bucket}/${key}: HTTP ${response.status}`);
  return response;
}

async function remoteSha512(key) {
  const response = await getObjectResponse(key);
  if (!response) return undefined;
  const hash = createHash('sha512');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('base64');
}

async function remoteText(key) {
  const response = await getObjectResponse(key);
  return response ? await response.text() : undefined;
}

async function run(command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repositoryDirectory, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${signal ?? `status ${String(code)}`}`));
    });
  });
}

async function put(name, path, cacheControl, disposition) {
  const key = `${prefix}/${name}`;
  const args = [
    '--filter', '@rally/api', 'exec', 'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`,
    '--remote', '--file', path, '--content-type', releaseContentType(name),
    '--cache-control', cacheControl, '--force',
  ];
  if (disposition) args.push('--content-disposition', disposition);
  await run('pnpm', args);
}

await publishSidelineRelease({
  bucket,
  prefix,
  publicUrl,
  purgeChannel: () => purgeCloudflarePrefix({ apiToken, zoneId, prefixUrl: channelPrefixUrl }),
  put,
  release,
  remoteSha512,
  remoteText,
  verifyPublic: verifyPublicReleaseArtifactHash,
});
