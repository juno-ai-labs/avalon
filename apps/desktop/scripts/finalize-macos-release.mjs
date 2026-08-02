import { spawn } from 'node:child_process';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notarytoolCredentialArgs } from './apple-notarization.mjs';
import { writeBlockmap } from './blockmap.mjs';
import { AVALON_APPLE_TEAM_ID } from './release-lib.mjs';

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
        && identity.name.endsWith(`(${AVALON_APPLE_TEAM_ID})`),
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
      `Expected exactly one Developer ID Application identity for team ${AVALON_APPLE_TEAM_ID}`
        + `${requested ? ` matching CSC_NAME=${requested}` : ''}; found ${matching.length}`,
    );
  }
  return matching[0];
}

function releaseDate(environment = process.env) {
  if (environment.AVALON_RELEASE_DATE) {
    const date = new Date(environment.AVALON_RELEASE_DATE);
    if (Number.isNaN(date.valueOf())) throw new Error('AVALON_RELEASE_DATE must be an ISO-8601 date');
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

export function macFeedYaml({ version, zipName, sha512, size, date }) {
  for (const [label, value] of Object.entries({ version, zipName, sha512, date })) {
    if (!value || typeof value !== 'string' || value.includes('\n')) {
      throw new Error(`Invalid ${label} for latest-mac.yml`);
    }
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid ZIP size for latest-mac.yml');
  return [
    `version: ${JSON.stringify(version)}`,
    'files:',
    `  - url: ${JSON.stringify(zipName)}`,
    `    sha512: ${JSON.stringify(sha512)}`,
    `    size: ${size}`,
    `path: ${JSON.stringify(zipName)}`,
    `sha512: ${JSON.stringify(sha512)}`,
    `releaseDate: ${JSON.stringify(date)}`,
    '',
  ].join('\n');
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

  const outputDirectory = dirname(zipPath);
  const feedPath = join(outputDirectory, 'latest-mac.yml');
  const temporaryFeedPath = join(outputDirectory, `.latest-mac.${process.pid}.tmp`);
  await writeFile(
    temporaryFeedPath,
    macFeedYaml({
      version,
      zipName: basename(zipPath),
      sha512: zipInfo.sha512,
      size: zipInfo.size,
      date: releaseDate(),
    }),
  );
  await rename(temporaryFeedPath, feedPath);
  console.log(
    `Finalized ${basename(dmgPath)} (${dmgInfo.size} bytes) and ZIP-primary ${basename(feedPath)}`,
  );
  return [];
}
