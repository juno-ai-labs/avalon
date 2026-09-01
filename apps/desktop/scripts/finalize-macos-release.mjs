import { spawn } from 'node:child_process';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notarytoolCredentialArgs } from './apple-notarization.mjs';
import { writeBlockmap } from './blockmap.mjs';
import { RALLY_APPLE_TEAM_ID, sha512File } from './release-lib.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function run(command, args, { capture = false } = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: desktopDirectory,
      env: process.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else {
        reject(
          new Error(
            `${command} failed with ${signal ?? `status ${String(code)}`}\n${stderr || stdout}`.trim(),
          ),
        );
      }
    });
  });
}

export function selectDeveloperIdIdentity(identityOutput, qualifier = '') {
  const identities = [...identityOutput.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"/gmu)]
    .map((match) => ({ hash: match[1].toUpperCase(), name: match[2] }))
    .filter(
      (identity) => identity.name.startsWith('Developer ID Application:')
        && identity.name.endsWith(`(${RALLY_APPLE_TEAM_ID})`),
    );
  const requested = qualifier
    .trim()
    .replace(/^Developer ID Application:\s*/u, '');
  const matching = requested
    ? identities.filter(
      (identity) => identity.hash === requested.toUpperCase()
        || identity.name === `Developer ID Application: ${requested}`
        || identity.name.includes(requested),
    )
    : identities;
  if (matching.length !== 1) {
    throw new Error(
      `Expected exactly one Developer ID Application identity for team ${RALLY_APPLE_TEAM_ID}`
        + `${requested ? ` matching CSC_NAME=${requested}` : ''}; found ${matching.length}`,
    );
  }
  return matching[0];
}

function releaseDate(environment = process.env) {
  if (environment.RALLY_RELEASE_DATE) {
    const date = new Date(environment.RALLY_RELEASE_DATE);
    if (Number.isNaN(date.valueOf())) throw new Error('RALLY_RELEASE_DATE must be an ISO-8601 date');
    return date.toISOString();
  }
  if (environment.SOURCE_DATE_EPOCH) {
    const seconds = Number(environment.SOURCE_DATE_EPOCH);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new Error('SOURCE_DATE_EPOCH must be a positive integer number of seconds');
    }
    return new Date(seconds * 1_000).toISOString();
  }
  return new Date().toISOString();
}

export function macFeedYaml({ version, files, date }) {
  for (const [label, value] of Object.entries({ version, date })) {
    if (!value || typeof value !== 'string' || value.includes('\n')) {
      throw new Error(`Invalid ${label} for latest-mac.yml`);
    }
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('latest-mac.yml must contain at least one file');
  }
  const names = new Set();
  for (const file of files) {
    if (
      !file
      || typeof file.url !== 'string'
      || !file.url
      || file.url !== basename(file.url)
      || file.url.includes('\n')
      || typeof file.sha512 !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(file.sha512)
      || !Number.isSafeInteger(file.size)
      || file.size <= 0
    ) {
      throw new Error('Invalid file entry for latest-mac.yml');
    }
    if (names.has(file.url)) throw new Error(`Duplicate latest-mac.yml file ${file.url}`);
    names.add(file.url);
  }
  const [primary] = files;
  if (!primary.url.endsWith('.zip')) throw new Error('latest-mac.yml must be ZIP-primary');
  return [
    '# rally-workspace-handoff-version: 2',
    `version: ${JSON.stringify(version)}`,
    'files:',
    ...files.flatMap((file) => [
      `  - url: ${JSON.stringify(file.url)}`,
      `    sha512: ${JSON.stringify(file.sha512)}`,
      `    size: ${file.size}`,
    ]),
    `path: ${JSON.stringify(primary.url)}`,
    `sha512: ${JSON.stringify(primary.sha512)}`,
    `releaseDate: ${JSON.stringify(date)}`,
    '',
  ].join('\n');
}

/**
 * electron-builder writes latest-mac.yml after afterAllArtifactBuild returns.
 * This must therefore run only after the electron-builder process exits, once
 * its update-info writer can no longer restore the pre-staple DMG metadata.
 */
export async function writeFinalMacFeed(outputDirectory, version, environment = process.env) {
  const names = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const zipNames = names.filter((name) => name.endsWith('.zip'));
  const dmgNames = names.filter((name) => name.endsWith('.dmg'));
  if (zipNames.length !== 1 || dmgNames.length !== 1) {
    throw new Error(`Expected exactly one final ZIP and DMG; found ${zipNames.length} ZIP and ${dmgNames.length} DMG`);
  }
  const artifactNames = [zipNames[0], dmgNames[0]];
  for (const name of artifactNames) {
    if (!name.includes(version) || !name.includes('arm64')) {
      throw new Error(`Release artifact must include version ${version} and architecture arm64: ${name}`);
    }
  }
  const files = await Promise.all(artifactNames.map(async (url) => {
    const path = join(outputDirectory, url);
    const [sha512, metadata] = await Promise.all([sha512File(path), stat(path)]);
    return { url, sha512, size: metadata.size };
  }));
  const feedPath = join(outputDirectory, 'latest-mac.yml');
  const temporaryFeedPath = join(outputDirectory, `.latest-mac.${process.pid}.tmp`);
  await writeFile(temporaryFeedPath, macFeedYaml({
    version,
    files,
    date: releaseDate(environment),
  }));
  await rename(temporaryFeedPath, feedPath);
  return { feedPath, files };
}

export default async function finalizeMacosRelease(buildResult) {
  const artifactPaths = [...new Set(buildResult.artifactPaths.map((path) => resolve(path)))];
  const dmgPaths = artifactPaths.filter((path) => path.endsWith('.dmg'));
  const zipPaths = artifactPaths.filter((path) => path.endsWith('.zip'));
  if (dmgPaths.length === 0 && zipPaths.length === 0) return [];
  if (process.platform !== 'darwin') throw new Error('macOS release finalization must run on macOS');
  if (dmgPaths.length !== 1 || zipPaths.length !== 1) {
    throw new Error(`Expected exactly one DMG and one ZIP; found ${dmgPaths.length} DMG and ${zipPaths.length} ZIP`);
  }

  const [dmgPath] = dmgPaths;
  const [zipPath] = zipPaths;
  if (dirname(dmgPath) !== dirname(zipPath)) throw new Error('Release ZIP and DMG must share one output directory');
  const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'));
  const version = packageJson.version;
  for (const artifactPath of [dmgPath, zipPath]) {
    const name = basename(artifactPath);
    if (!name.includes(version) || !name.includes('arm64')) {
      throw new Error(`Release artifact must include version ${version} and architecture arm64: ${name}`);
    }
  }

  const identityResult = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    capture: true,
  });
  const identity = selectDeveloperIdIdentity(
    `${identityResult.stdout}\n${identityResult.stderr}`,
    process.env.CSC_NAME,
  );
  console.log(`Signing final DMG with ${identity.name}`);
  await run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity.hash, dmgPath]);
  await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', dmgPath]);

  const credentials = notarytoolCredentialArgs(process.env);
  await run('/usr/bin/xcrun', [
    'notarytool',
    'submit',
    dmgPath,
    ...credentials,
    '--wait',
    '--timeout',
    '30m',
    '--output-format',
    'json',
  ]);
  await run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);

  // Signing and stapling mutate the disk image. Differential metadata and the
  // update feed must therefore be generated from the final release bytes.
  const [dmgInfo, zipInfo] = await Promise.all([
    writeBlockmap(dmgPath),
    writeBlockmap(zipPath),
  ]);
  const zipMetadata = await stat(zipPath);
  if (zipInfo.size !== zipMetadata.size) throw new Error('ZIP blockmap size does not match final ZIP bytes');

  console.log(
    `Finalized ${basename(dmgPath)} (${dmgInfo.size} bytes) and final-byte differential metadata`,
  );
  return [];
}
