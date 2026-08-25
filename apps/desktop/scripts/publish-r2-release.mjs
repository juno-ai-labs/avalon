import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  assertNextReleaseVersion,
  compareVersions,
  loadReleaseDirectory,
  normalizeReleasePrefix,
  parseMacUpdateFeed,
  reconcileImmutableReleaseObject,
  releaseContentType,
  sha512File,
  verifyFeedArtifact,
} from './release-lib.mjs';
import {
  purgeAndVerifyImmutableReleaseUrls,
  purgeCloudflareUrls,
  verifyPublicReleaseArtifactHash,
} from './release-cache.mjs';
import {
  createChecksumManifest,
  createPublishedSiteReleaseConfig,
  readSiteReleaseConfig,
  sha256File,
  writeSiteReleaseConfigAtomically,
} from './site-release-config.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const defaultReleaseDirectory = join(desktopDirectory, 'release/release');
const defaultSiteConfigPath = join(repositoryDirectory, 'apps/site/release.config.json');
const canonicalDmgName = 'Avalon.dmg';
const checksumsName = 'SHA256SUMS';
const latestManifestName = 'latest-mac.yml';

function parseArguments(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // pnpm forwards its conventional argument separator to nested workspace
    // scripts. Treat it as syntax rather than a publisher argument so the
    // documented root command can safely delegate to this script.
    if (argument === '--') continue;
    if (argument === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (
      argument === '--confirm'
      || argument === '--release-dir'
      || argument === '--site-config'
      || argument === '--commit'
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      result[argument.slice(2).replaceAll('-', '_')] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown release publisher argument: ${argument}`);
    if (result.release_dir) throw new Error(`Unexpected extra release directory: ${argument}`);
    result.release_dir = argument;
  }
  return result;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before publishing a desktop release`);
  return value;
}

function configured(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Set ${name} before publishing a desktop release`);
  }
  return value.trim();
}

function normalizeObjectName(name) {
  const parts = name.split('/');
  if (parts.some((part) => !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(part))) {
    throw new Error(`Invalid release object name: ${name}`);
  }
  return parts.join('/');
}

const arguments_ = parseArguments(process.argv.slice(2));
const releaseDirectory = resolve(arguments_.release_dir ?? defaultReleaseDirectory);
const siteConfigPath = resolve(arguments_.site_config ?? defaultSiteConfigPath);
const currentSiteConfig = await readSiteReleaseConfig(siteConfigPath);
// The commit this release was built from, recorded so the planner can tell
// later desktop work apart from work that already shipped. A publish run
// outside the pipeline may not know it; the record then carries no watermark
// and the next plan fails open rather than measuring against the wrong commit.
const releaseCommit = arguments_.commit ?? (process.env.AVALON_RELEASE_COMMIT?.trim() || undefined);
const bucket = configured('AVALON_RELEASE_R2_BUCKET', currentSiteConfig.bucket);
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) {
  throw new Error(`Invalid R2 release bucket: ${bucket}`);
}
const prefix = normalizeReleasePrefix(configured('AVALON_RELEASE_PREFIX', currentSiteConfig.prefix));
const baseUrl = new URL(configured('AVALON_RELEASE_BASE_URL', currentSiteConfig.downloadBaseUrl));
if (
  baseUrl.protocol !== 'https:'
  || baseUrl.username
  || baseUrl.password
  || baseUrl.search
  || baseUrl.hash
  || (baseUrl.pathname !== '/' && baseUrl.pathname !== '')
) {
  throw new Error('AVALON_RELEASE_BASE_URL must be an HTTPS origin');
}

const release = await loadReleaseDirectory(releaseDirectory);
await verifyFeedArtifact(release);
for (const artifact of release.artifacts) {
  if (!artifact.name.includes(release.feed.version)) {
    throw new Error(`Refusing to publish unversioned artifact ${artifact.name}`);
  }
}
const confirmation = arguments_.confirm ?? process.env.AVALON_RELEASE_PUBLISH_CONFIRM?.trim();
if (!arguments_.dryRun && confirmation !== release.feed.version) {
  throw new Error(`Pass --confirm ${release.feed.version} to publish this release`);
}

if (arguments_.dryRun && compareVersions(currentSiteConfig.version, release.feed.version) < 0) {
  assertNextReleaseVersion(currentSiteConfig.version, release.feed.version);
}

const accountId = arguments_.dryRun ? process.env.CLOUDFLARE_ACCOUNT_ID?.trim() : required('CLOUDFLARE_ACCOUNT_ID');
const apiToken = arguments_.dryRun ? process.env.CLOUDFLARE_API_TOKEN?.trim() : required('CLOUDFLARE_API_TOKEN');
const zoneId = arguments_.dryRun ? process.env.CLOUDFLARE_ZONE_ID?.trim() : required('CLOUDFLARE_ZONE_ID');
const wranglerEnvironment = {
  ...process.env,
  ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  ...(apiToken ? { CLOUDFLARE_API_TOKEN: apiToken } : {}),
};

async function runCapture(command, args, environment = process.env) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryDirectory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

function wranglerArgs(command, objectPath, ...args) {
  return ['--filter', '@avalon/api', 'exec', 'wrangler', 'r2', 'object', command, objectPath, '--remote', ...args];
}

async function getR2Object(key, destination) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`
    + `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  if (!response.ok || !response.body) {
    const body = (await response.text()).slice(0, 1_000);
    throw new Error(
      `Could not inspect r2://${bucket}/${key}; Cloudflare returned HTTP ${response.status}: ${body}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { mode: 0o600 }),
  );
  return true;
}

async function getPublicObject(key, destination, verificationId) {
  const prefixWithSeparator = `${prefix}/`;
  if (!key.startsWith(prefixWithSeparator)) {
    throw new Error(`Release object is outside the public prefix: ${key}`);
  }
  const url = new URL(publicUrl(key.slice(prefixWithSeparator.length)));
  url.searchParams.set('avalon-release-verify', verificationId.slice(0, 24));
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  if (!response.ok || !response.body) {
    const body = (await response.text()).slice(0, 1_000);
    throw new Error(
      `Could not inspect ${url}; the public release domain returned HTTP ${response.status}: ${body}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { mode: 0o600 }),
  );
  return true;
}

async function putR2Object(key, source, { contentType, cacheControl, disposition }) {
  const args = wranglerArgs(
    'put',
    `${bucket}/${key}`,
    '--file',
    source,
    '--content-type',
    contentType,
    '--cache-control',
    cacheControl,
    '--force',
  );
  if (disposition) args.push('--content-disposition', disposition);
  const result = await runCapture('pnpm', args, wranglerEnvironment);
  if (result.code !== 0) {
    throw new Error(`Could not upload r2://${bucket}/${key}\n${result.stdout}\n${result.stderr}`.trim());
  }
}

function publicUrl(name) {
  const objectName = normalizeObjectName(name);
  const encodedPath = [...prefix.split('/'), ...objectName.split('/')].map(encodeURIComponent).join('/');
  return new URL(encodedPath, `${baseUrl.origin}/`).toString();
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function verifyPublicArtifact(name, expectedSize, verificationId, { cacheBust = true } = {}) {
  const url = new URL(publicUrl(name));
  if (cacheBust) url.searchParams.set('avalon-release-verify', verificationId.slice(0, 24));
  let failure = 'no response';
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const head = await fetch(url, {
        method: 'HEAD',
        ...(cacheBust ? { headers: { 'cache-control': 'no-cache' } } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const contentLength = head.headers.get('content-length');
      const hasIncorrectLength = contentLength !== null && Number(contentLength) !== expectedSize;
      if (!head.ok || hasIncorrectLength) {
        failure = `HEAD HTTP ${head.status}, content-length=${head.headers.get('content-length') ?? 'missing'}`;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const range = await fetch(url, {
        headers: {
          ...(cacheBust ? { 'cache-control': 'no-cache' } : {}),
          range: 'bytes=0-0',
        },
        signal: AbortSignal.timeout(30_000),
      });
      const contentRange = range.headers.get('content-range');
      if (range.status !== 206 || contentRange !== `bytes 0-0/${expectedSize}`) {
        await range.body?.cancel();
        failure = `Range HTTP ${range.status}, content-range=${contentRange ?? 'missing'}`;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const bytes = Buffer.from(await range.arrayBuffer());
      if (bytes.length === 1) return;
      failure = `Range response returned ${bytes.length} bytes`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await sleep(500 * 2 ** attempt);
  }
  throw new Error(`Public artifact verification failed for ${url}: ${failure}`);
}

async function verifyR2Hash(key, expectedHash, destination) {
  let found = false;
  let mismatched = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const readers = [
      () => getR2Object(key, destination),
      () => getPublicObject(key, destination, expectedHash),
    ];
    for (const read of readers) {
      await rm(destination, { force: true });
      if (await read()) {
        found = true;
        const actualHash = await sha512File(destination);
        if (actualHash === expectedHash) return;
        mismatched = true;
      }
    }
    if (attempt < 9) await sleep(Math.min(1_000 * 2 ** attempt, 30_000));
  }
  if (mismatched) {
    throw new Error(`Remote SHA-512 mismatch for r2://${bucket}/${key}`);
  }
  if (!found) {
    throw new Error(
      `Uploaded release object did not become readable from r2://${bucket}/${key} within the verification window`,
    );
  }
}

async function uploadImmutableArtifact(
  artifact,
  scratchDirectory,
  releaseIsCommitted,
  liveArtifactNames,
) {
  const objectName = normalizeObjectName(artifact.objectName ?? artifact.name);
  const key = `${prefix}/${objectName}`;
  const verificationPath = join(scratchDirectory, `verified-${objectName.replaceAll('/', '_')}`);
  const [localHash, metadata] = await Promise.all([sha512File(artifact.path), stat(artifact.path)]);
  const exists = await getR2Object(key, verificationPath);
  const existingHash = exists ? await sha512File(verificationPath) : undefined;
  const outcome = await reconcileImmutableReleaseObject({
    existingHash,
    localHash,
    releaseIsCommitted,
    objectLocation: `r2://${bucket}/${key}`,
    referencedByLiveManifest: liveArtifactNames.has(objectName),
    upload: async () => {
      await rm(verificationPath, { force: true });
      await putR2Object(key, artifact.path, {
        contentType: artifact.contentType ?? releaseContentType(artifact.name),
        cacheControl: 'public, max-age=31536000, immutable',
        disposition: `attachment; filename="${basename(artifact.name).replaceAll('"', '')}"`,
      });
    },
  });
  if (outcome === 'reused') {
    console.log(`Already published immutable artifact ${objectName}`);
  } else {
    await verifyR2Hash(key, localHash, verificationPath);
    console.log(
      outcome === 'replaced-orphan'
        ? `Replaced orphaned pre-manifest artifact ${objectName}`
        : `Uploaded immutable artifact ${objectName}`,
    );
  }
  await verifyPublicArtifact(objectName, metadata.size, localHash);
  return { name: objectName, expectedSize: metadata.size, verificationId: localHash };
}

async function purgePublicUrls(urls) {
  await purgeCloudflareUrls({ apiToken, urls, zoneId });
}

async function purgePublicUrl(url) {
  await purgePublicUrls([url]);
}

async function publishCanonicalDmg(versionedDmg, scratchDirectory) {
  const key = `${prefix}/${canonicalDmgName}`;
  const [localHash, metadata] = await Promise.all([
    sha512File(versionedDmg.path),
    stat(versionedDmg.path),
  ]);
  await putR2Object(key, versionedDmg.path, {
    contentType: releaseContentType(versionedDmg.name),
    cacheControl: 'public, max-age=86400',
    disposition: `attachment; filename="${canonicalDmgName}"`,
  });
  await verifyR2Hash(key, localHash, join(scratchDirectory, 'verified-Avalon.dmg'));
  await purgePublicUrl(publicUrl(canonicalDmgName));
  await verifyPublicArtifact(canonicalDmgName, metadata.size, localHash);
  console.log(`Promoted recovery installer ${publicUrl(canonicalDmgName)}`);
}

async function verifyPublicManifest(expectedBytes) {
  const url = publicUrl(latestManifestName);
  let failure = 'no response';
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(30_000),
      });
      const actual = Buffer.from(await response.arrayBuffer());
      if (response.ok && actual.equals(expectedBytes)) return;
      failure = `HTTP ${response.status}; manifest bytes did not match`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await sleep(500 * 2 ** attempt);
  }
  throw new Error(`Public manifest verification failed for ${url}: ${failure}`);
}

const scratchDirectory = await mkdtemp(join(tmpdir(), 'avalon-r2-release-'));
try {
  const artifactDigests = await Promise.all(release.artifacts.map(async (artifact) => ({
    name: artifact.name,
    sha256: await sha256File(artifact.path),
  })));
  const checksumsBody = createChecksumManifest(artifactDigests);
  const checksumsPath = join(scratchDirectory, checksumsName);
  await writeFile(checksumsPath, checksumsBody, 'utf8');
  const checksumsSha256 = await sha256File(checksumsPath);
  const checksumsArtifact = {
    name: checksumsName,
    objectName: `${release.feed.version}/${checksumsName}`,
    path: checksumsPath,
    contentType: 'text/plain; charset=utf-8',
  };
  const versionedDmg = release.artifacts.find((artifact) => artifact.name.endsWith('.dmg'));
  if (!versionedDmg) throw new Error('Release is missing its versioned DMG');
  const sha256 = Object.fromEntries(artifactDigests.map(({ name, sha256: hash }) => [name, hash]));
  sha256[checksumsName] = checksumsSha256;
  sha256[canonicalDmgName] = sha256[versionedDmg.name];
  const publicationOptions = {
    version: release.feed.version,
    artifactNames: release.artifacts.map(({ name }) => name),
    canonicalDmgFile: canonicalDmgName,
    checksumsFile: checksumsName,
    latestFile: latestManifestName,
    bucket,
    prefix,
    downloadBaseUrl: baseUrl.origin,
    sha256,
    commit: releaseCommit,
  };
  const proposedSiteConfig = createPublishedSiteReleaseConfig(currentSiteConfig, {
    ...publicationOptions,
    publishedAt: new Date().toISOString(),
  });

  releaseTransaction: {
  if (arguments_.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      releaseDirectory,
      siteConfigPath,
      immutableObjects: [
        ...release.artifacts.map(({ name }) => `${prefix}/${name}`),
        `${prefix}/${release.feed.version}/${checksumsName}`,
      ],
      immutableCachePurgeUrls: [
        ...release.artifacts.map(({ name }) => publicUrl(name)),
        publicUrl(`${release.feed.version}/${checksumsName}`),
      ],
      canonicalDmg: `${prefix}/${canonicalDmgName}`,
      latestManifest: `${prefix}/${latestManifestName}`,
      siteRelease: proposedSiteConfig,
    }, null, 2));
    break releaseTransaction;
  }

  const existingManifestPath = join(scratchDirectory, 'existing-latest-mac.yml');
  const hasManifest = await getR2Object(`${prefix}/${latestManifestName}`, existingManifestPath);
  let releaseIsCommitted = false;
  let liveArtifactNames = new Set();
  if (hasManifest) {
    const existingBytes = await readFile(existingManifestPath);
    const existingFeed = parseMacUpdateFeed(existingBytes.toString('utf8'));
    liveArtifactNames = new Set(existingFeed.files.map(({ url }) => url));
    const comparison = compareVersions(existingFeed.version, release.feed.version);
    if (comparison > 0) {
      throw new Error(
        `Refusing to roll ${prefix} back from ${existingFeed.version} to ${release.feed.version}`,
      );
    }
    if (comparison < 0) {
      assertNextReleaseVersion(existingFeed.version, release.feed.version);
    }
    if (comparison === 0 && !existingBytes.equals(release.manifestBytes)) {
      throw new Error(`Release ${release.feed.version} already has different latest-mac.yml bytes in R2`);
    }
    releaseIsCommitted = comparison === 0;
  } else if (compareVersions(currentSiteConfig.version, release.feed.version) < 0) {
    assertNextReleaseVersion(currentSiteConfig.version, release.feed.version);
  }

  // Each immutable payload is hash-verified through R2 and HEAD/Range-verified
  // through the public custom domain before either mutable channel pointer moves.
  const immutablePublicArtifacts = [];
  for (const artifact of release.artifacts) {
    immutablePublicArtifacts.push(
      await uploadImmutableArtifact(
        artifact,
        scratchDirectory,
        releaseIsCommitted,
        liveArtifactNames,
      ),
    );
  }
  immutablePublicArtifacts.push(
    await uploadImmutableArtifact(
      checksumsArtifact,
      scratchDirectory,
      releaseIsCommitted,
      liveArtifactNames,
    ),
  );

  // Query parameters bypass a stale negative cache entry but updater clients do
  // not use them. Purge every exact immutable URL as one fail-closed gate, then
  // verify the ordinary no-query URLs before either mutable channel pointer moves.
  await purgeAndVerifyImmutableReleaseUrls({
    artifacts: immutablePublicArtifacts.map((artifact) => ({
      ...artifact,
      url: publicUrl(artifact.name),
    })),
    purgeUrls: purgePublicUrls,
    verifyArtifact: async (artifact) => {
      await verifyPublicArtifact(
        artifact.name,
        artifact.expectedSize,
        artifact.verificationId,
        { cacheBust: false },
      );
      await verifyPublicReleaseArtifactHash({
        expectedHash: artifact.verificationId,
        url: artifact.url,
      });
    },
  });

  // Recovery downloads use this stable alias. It moves only after the matching
  // immutable DMG is verified, and before latest-mac.yml commits the channel.
  await publishCanonicalDmg(versionedDmg, scratchDirectory);

  // The update manifest is the R2 release commit point and must be the final
  // object upload. Landing-page state is activated only after it verifies.
  const manifestKey = `${prefix}/${latestManifestName}`;
  const localManifestPath = join(scratchDirectory, latestManifestName);
  await writeFile(localManifestPath, release.manifestBytes);
  await putR2Object(manifestKey, localManifestPath, {
    contentType: releaseContentType(latestManifestName),
    cacheControl: 'public, max-age=0, must-revalidate',
  });
  await purgePublicUrl(publicUrl(latestManifestName));
  await verifyPublicManifest(release.manifestBytes);

  const publishedSiteConfig = createPublishedSiteReleaseConfig(currentSiteConfig, {
    ...publicationOptions,
    publishedAt: new Date().toISOString(),
  });
  await writeSiteReleaseConfigAtomically(siteConfigPath, publishedSiteConfig);
  console.log(
    `Published Avalon ${release.feed.version}: immutable artifacts, recovery DMG, latest-mac.yml, then site activation`,
  );
  }
} finally {
  await rm(scratchDirectory, { recursive: true, force: true });
}
