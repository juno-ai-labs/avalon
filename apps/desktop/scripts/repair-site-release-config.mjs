#!/usr/bin/env node
// Rebuilds apps/site/release.config.json from the release that is actually
// live, without touching the build.
//
// The release writes that record as its second-to-last act. If the commit
// fails after publication — a push race that outlives its retries, a token
// expiring mid-run — the channel is live but `main` still names the previous
// version. Nothing recovers from that on its own: the next release reads the
// stale record through assertNextReleaseVersion and refuses, and re-running the
// release rebuilds artifacts whose bytes will not match the published ones, so
// the immutable-object guard rejects them.
//
// Everything needed is already public. latest-mac.yml names the version and its
// artifacts, the per-version SHA256SUMS carries their digests, and the two
// digests that manifest omits are derivable: its own, by hashing the bytes just
// fetched, and the canonical DMG's, which publication defines as identical to
// the versioned DMG.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublishedSiteReleaseConfig, writeSiteReleaseConfigAtomically } from './site-release-config.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const configPath = resolve(repositoryDirectory, 'apps/site/release.config.json');

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export function parseChecksumManifest(text) {
  const digests = {};
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const match = /^([a-f0-9]{64}) {2}(\S+)$/u.exec(line);
    if (!match) throw new Error(`Unreadable SHA256SUMS line: ${line.slice(0, 80)}`);
    if (digests[match[2]]) throw new Error(`Duplicate artifact in SHA256SUMS: ${match[2]}`);
    digests[match[2]] = match[1];
  }
  if (Object.keys(digests).length === 0) throw new Error('SHA256SUMS is empty');
  return digests;
}

export function versionFromManifest(manifestText) {
  const version = /^version:\s*["']?([^"'\s]+)["']?\s*$/mu.exec(manifestText)?.[1];
  if (!version || !SEMVER.test(version)) {
    throw new Error('Live release manifest does not declare a semantic version');
  }
  return version;
}

// The published DMG's size, used to check the canonical copy is the same file
// before inheriting its digest.
export function dmgSizeFromManifest(manifestText, version) {
  const pattern = new RegExp(
    `-\\s+url:\\s*["']?(Avalon-${version.replace(/\./gu, '\\.')}-mac-[^"'\\s]+\\.dmg)["']?[\\s\\S]*?size:\\s*(\\d+)`,
    'u',
  );
  const match = pattern.exec(manifestText);
  if (!match) throw new Error(`Live manifest does not describe a DMG for ${version}`);
  return { name: match[1], size: Number(match[2]) };
}

export function buildRepairOptions({ current, version, digests, checksumsDigest, publishedAt }) {
  const names = Object.keys(digests);
  const dmg = names.find((name) => name.endsWith('.dmg') && !name.endsWith('.blockmap'));
  if (!dmg) throw new Error('SHA256SUMS names no DMG');
  const canonicalDmgFile = current.files?.canonicalDmg ?? 'Avalon.dmg';
  const checksumsFile = current.files?.checksums ?? 'SHA256SUMS';
  return {
    version,
    artifactNames: names,
    // Publication writes the canonical DMG as a byte-identical copy of the
    // versioned one, so it carries the same digest by definition.
    sha256: { ...digests, [canonicalDmgFile]: digests[dmg], [checksumsFile]: checksumsDigest },
    checksumsFile,
    canonicalDmgFile,
    latestFile: current.files?.latest ?? 'latest-mac.yml',
    prefix: current.prefix,
    bucket: current.bucket,
    downloadBaseUrl: current.downloadBaseUrl,
    publishedAt,
  };
}

async function fetchText(url, label) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  const base = `${current.downloadBaseUrl}/${current.prefix}`;

  const manifestText = await fetchText(`${base}/${current.files.latest}`, 'Live release manifest');
  const version = versionFromManifest(manifestText);
  const publishedDmg = dmgSizeFromManifest(manifestText, version);

  const checksumsText = await fetchText(`${base}/${version}/${current.files.checksums}`, 'Live checksums');
  const digests = parseChecksumManifest(checksumsText);
  const checksumsDigest = createHash('sha256').update(checksumsText).digest('hex');

  // The canonical DMG inherits the versioned DMG's digest, so confirm it is the
  // same file rather than a leftover from an earlier release.
  const canonicalUrl = `${base}/${current.files.canonicalDmg}`;
  const head = await fetch(canonicalUrl, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
  if (!head.ok) throw new Error(`Canonical installer returned HTTP ${head.status}`);
  const canonicalSize = Number(head.headers.get('content-length'));
  if (canonicalSize !== publishedDmg.size) {
    throw new Error(
      `Canonical installer is ${canonicalSize} bytes but ${publishedDmg.name} is ${publishedDmg.size}; `
        + 'the channel is mid-promotion or inconsistent, so the record cannot be rebuilt safely.',
    );
  }
  const lastModified = head.headers.get('last-modified');
  const publishedAt = lastModified && Number.isFinite(Date.parse(lastModified))
    ? new Date(lastModified).toISOString()
    : new Date(Date.parse(current.publishedAt ?? 0) || Date.now()).toISOString();

  if (current.published === true && current.version === version) {
    console.log(`Release record already matches the live channel at ${version}; nothing to repair.`);
    return false;
  }

  // Reuses the publisher's own builder, so a repaired record is byte-identical
  // to one written by a successful release, and inherits its rollback guard.
  const repaired = createPublishedSiteReleaseConfig(current, buildRepairOptions({
    current,
    version,
    digests,
    checksumsDigest,
    publishedAt,
  }));
  await writeSiteReleaseConfigAtomically(configPath, repaired);
  console.log(`Repaired the release record: ${current.version} -> ${version} (published ${publishedAt}).`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((changed) => {
      if (process.env.GITHUB_OUTPUT) {
        return import('node:fs/promises').then(({ appendFile }) => (
          appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
        ));
      }
      return undefined;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Release record repair failed');
      process.exitCode = 1;
    });
}
