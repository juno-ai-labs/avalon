import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { compareVersions } from './release-lib.mjs';

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function plainFileName(value, label) {
  const name = requiredString(value, label);
  if (basename(name) !== name || name === '.' || name === '..' || /[\\/?#]/u.test(name)) {
    throw new Error(`${label} must be a plain file name`);
  }
  return name;
}

function releasePrefix(value) {
  const prefix = requiredString(value, 'Release prefix').replace(/^\/+|\/+$/gu, '');
  if (prefix.split('/').some((part) => !/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(part))) {
    throw new Error(`Invalid release prefix: ${value}`);
  }
  return prefix;
}

function downloadOrigin(value) {
  const url = new URL(requiredString(value, 'Release base URL'));
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Release base URL must be an HTTPS origin');
  }
  return url.origin;
}

// The commit the release was built from. The planner uses it as a watermark —
// desktop changes after it are unreleased — so it has to be an exact object
// name, not a ref that can later point somewhere else.
function releaseCommit(value) {
  const commit = requiredString(value, 'Release commit');
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('Release commit must be a full lowercase commit SHA');
  }
  return commit;
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function createChecksumManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('At least one release artifact is required for SHA256SUMS');
  }
  const seen = new Set();
  const rows = entries.map(({ name, sha256 }) => {
    const fileName = plainFileName(name, 'Release artifact');
    if (seen.has(fileName)) throw new Error(`Duplicate release artifact: ${fileName}`);
    seen.add(fileName);
    return { name: fileName, sha256: digest(sha256, `${fileName} digest`) };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return `${rows.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n')}\n`;
}

export function createPublishedSiteReleaseConfig(current, options) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('Site release configuration is invalid');
  }
  const version = requiredString(options.version, 'Release version');
  const currentVersion = requiredString(current.version, 'Configured release version');
  if (compareVersions(currentVersion, version) > 0) {
    throw new Error(`Refusing to roll site release back from ${currentVersion} to ${version}`);
  }
  const names = options.artifactNames.map((name) => plainFileName(name, 'Release artifact'));
  const dmg = names.filter((name) => name.endsWith('.dmg'));
  const zip = names.filter((name) => name.endsWith('.zip'));
  const blockmaps = names.filter((name) => name.endsWith('.blockmap')).sort();
  if (dmg.length !== 1 || zip.length !== 1) {
    throw new Error(`Expected one DMG and one ZIP; found ${dmg.length} DMG and ${zip.length} ZIP`);
  }
  for (const artifact of [dmg[0], zip[0]]) {
    if (!artifact.includes(version)) throw new Error(`Unversioned release artifact: ${artifact}`);
    if (!blockmaps.includes(`${artifact}.blockmap`)) {
      throw new Error(`Missing release blockmap for ${artifact}`);
    }
  }
  const checksums = plainFileName(options.checksumsFile ?? 'SHA256SUMS', 'Checksums file');
  const latest = plainFileName(options.latestFile ?? 'latest-mac.yml', 'Latest metadata file');
  const canonicalDmg = plainFileName(options.canonicalDmgFile ?? 'Rally.dmg', 'Canonical DMG file');
  if (!canonicalDmg.endsWith('.dmg') || canonicalDmg === dmg[0]) {
    throw new Error('Canonical DMG must be a distinct DMG file name');
  }
  const prefix = releasePrefix(options.prefix);
  const bucket = requiredString(options.bucket, 'Release bucket');
  const downloadBaseUrl = downloadOrigin(options.downloadBaseUrl);
  const hashes = Object.fromEntries(Object.entries(options.sha256).map(([name, value]) => [
    plainFileName(name, 'SHA-256 artifact'),
    digest(value, `${name} digest`),
  ]));
  for (const name of [...names, checksums]) {
    if (!hashes[name]) throw new Error(`Missing SHA-256 digest for ${name}`);
  }
  if (!hashes[canonicalDmg] || hashes[canonicalDmg] !== hashes[dmg[0]]) {
    throw new Error('Canonical DMG SHA-256 digest must match the versioned DMG');
  }
  const publishedAt = requiredString(options.publishedAt, 'Publication timestamp');
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('Publication timestamp is invalid');
  const commit = options.commit === undefined ? undefined : releaseCommit(options.commit);
  const objectKey = (name) => `${prefix}/${name}`;
  const config = {
    ...current,
    published: true,
    version,
    platform: typeof current.platform === 'string' ? current.platform : 'macOS',
    architecture: typeof current.architecture === 'string' ? current.architecture : 'Apple silicon',
    downloadBaseUrl,
    bucket,
    prefix,
    files: {
      dmg: dmg[0],
      canonicalDmg,
      zip: zip[0],
      blockmaps,
      checksums,
      latest,
    },
    objects: {
      dmg: objectKey(dmg[0]),
      canonicalDmg: objectKey(canonicalDmg),
      zip: objectKey(zip[0]),
      blockmaps: blockmaps.map(objectKey),
      checksums: `${prefix}/${version}/${checksums}`,
      latest: objectKey(latest),
    },
    sha256: hashes,
    publishedAt,
  };
  // Carrying the previous release's commit forward would be worse than having
  // none: the planner would measure new work against a release it did not
  // describe. An absent watermark makes the planner fail open and release.
  if (commit) config.commit = commit;
  else delete config.commit;
  return config;
}

export async function readSiteReleaseConfig(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Site release configuration must be a regular file: ${path}`);
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeSiteReleaseConfigAtomically(path, config) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Site release configuration must be a regular file: ${path}`);
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: metadata.mode & 0o777,
      flag: 'wx',
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
