import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  loadReleaseDirectory,
  normalizeReleasePrefix,
  parseMacUpdateFeed,
  releaseContentType,
  sha512File,
  verifyFeedArtifact,
} from '../../desktop/scripts/release-lib.mjs';
import { purgeCloudflareUrls, verifyPublicReleaseArtifactHash } from '../../desktop/scripts/release-cache.mjs';

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

const liveFeedText = await remoteText(`${prefix}/latest-mac.yml`);
const liveFeed = liveFeedText ? parseMacUpdateFeed(liveFeedText) : undefined;
if (liveFeed && compareVersions(liveFeed.version, release.feed.version) > 0) {
  throw new Error(`Refusing to replace Sideline ${liveFeed.version} with older ${release.feed.version}`);
}

if (liveFeed?.version === release.feed.version) {
  for (const file of liveFeed.files) {
    await verifyPublicReleaseArtifactHash({ expectedHash: file.sha512, url: publicUrl(file.url) });
  }
  const liveDmg = liveFeed.files.find((file) => file.url.endsWith('.dmg'));
  if (!liveDmg) throw new Error('Committed Sideline update feed is missing its DMG');
  await verifyPublicReleaseArtifactHash({ expectedHash: liveDmg.sha512, url: publicUrl('Sideline.dmg') });
  console.log(`Sideline ${release.feed.version} is already published; verified its committed feed`);
} else {
  for (const artifact of release.artifacts) {
    if (!artifact.name.includes(release.feed.version)) throw new Error(`Refusing unversioned artifact ${artifact.name}`);
    const key = `${prefix}/${artifact.name}`;
    const [localHash, existingHash] = await Promise.all([sha512File(artifact.path), remoteSha512(key)]);
    if (existingHash !== localHash) {
      // No live manifest names this candidate version yet, so a mismatched key
      // is debris from an interrupted attempt rather than an immutable release.
      await put(
        artifact.name,
        artifact.path,
        'public, max-age=31536000, immutable',
        `attachment; filename="${basename(artifact.name)}"`,
      );
    }
    await verifyPublicReleaseArtifactHash({ expectedHash: localHash, url: publicUrl(artifact.name) });
  }

  const canonicalDmg = release.artifacts.find((artifact) => artifact.name.endsWith('.dmg'));
  if (!canonicalDmg) throw new Error('Sideline release is missing its DMG');
  const dmgHash = await sha512File(canonicalDmg.path);
  await put('Sideline.dmg', canonicalDmg.path, 'public, max-age=3600', 'attachment; filename="Sideline.dmg"');
  await purgeCloudflareUrls({ apiToken, zoneId, urls: [publicUrl('Sideline.dmg')] });
  await verifyPublicReleaseArtifactHash({ expectedHash: dmgHash, url: publicUrl('Sideline.dmg') });

  // The manifest is the commit point and moves only after every byte it names,
  // plus the recovery installer, is publicly readable with the expected hash.
  await put('latest-mac.yml', release.manifestPath, 'no-cache, no-store, must-revalidate');
  await purgeCloudflareUrls({ apiToken, zoneId, urls: [publicUrl('latest-mac.yml')] });
  const feedHash = await sha512File(release.manifestPath);
  await verifyPublicReleaseArtifactHash({ expectedHash: feedHash, url: publicUrl('latest-mac.yml') });
  console.log(`Published Sideline ${release.feed.version} at ${publicUrl('latest-mac.yml')}`);
}
