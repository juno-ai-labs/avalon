import { spawn } from 'node:child_process';
import { readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notarytoolCredentialArgs } from '../../desktop/scripts/apple-notarization.mjs';
import { writeBlockmap } from '../../desktop/scripts/blockmap.mjs';
import { selectDeveloperIdIdentity } from '../../desktop/scripts/finalize-macos-release.mjs';
import { sha512File } from '../../desktop/scripts/release-lib.mjs';

const sidelineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function run(command, args, { capture = false } = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: sidelineDirectory,
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
      else reject(new Error(`${command} failed with ${signal ?? `status ${String(code)}`}\n${stderr || stdout}`.trim()));
    });
  });
}

function releaseDate(environment = process.env) {
  if (environment.SOURCE_DATE_EPOCH) {
    const seconds = Number(environment.SOURCE_DATE_EPOCH);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new Error('SOURCE_DATE_EPOCH must be a positive integer number of seconds');
    }
    return new Date(seconds * 1_000).toISOString();
  }
  return new Date().toISOString();
}

export function sidelineMacFeedYaml({ version, files, date }) {
  if (!version || !date || version.includes('\n') || date.includes('\n')) {
    throw new Error('Sideline update feed metadata is invalid');
  }
  if (!Array.isArray(files) || files.length !== 2 || !files[0].url.endsWith('.zip')) {
    throw new Error('Sideline update feed must contain a primary ZIP and one DMG');
  }
  for (const file of files) {
    if (
      file.url !== basename(file.url)
      || file.url.includes('\n')
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(file.sha512)
      || !Number.isSafeInteger(file.size)
      || file.size <= 0
    ) throw new Error('Sideline update feed contains an invalid artifact');
  }
  return [
    `version: ${JSON.stringify(version)}`,
    'files:',
    ...files.flatMap((file) => [
      `  - url: ${JSON.stringify(file.url)}`,
      `    sha512: ${JSON.stringify(file.sha512)}`,
      `    size: ${file.size}`,
    ]),
    `path: ${JSON.stringify(files[0].url)}`,
    `sha512: ${JSON.stringify(files[0].sha512)}`,
    `releaseDate: ${JSON.stringify(date)}`,
    '',
  ].join('\n');
}

export async function writeSidelineMacFeed(outputDirectory, version, environment = process.env) {
  const names = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const zipNames = names.filter((name) => name.endsWith('.zip'));
  const dmgNames = names.filter((name) => name.endsWith('.dmg'));
  if (zipNames.length !== 1 || dmgNames.length !== 1) {
    throw new Error(`Expected exactly one final ZIP and DMG; found ${zipNames.length} ZIP and ${dmgNames.length} DMG`);
  }
  const files = await Promise.all([zipNames[0], dmgNames[0]].map(async (url) => {
    if (!url.includes(version) || !url.includes('arm64')) {
      throw new Error(`Sideline release artifact must include ${version} and arm64: ${url}`);
    }
    const path = join(outputDirectory, url);
    const [sha512, metadata] = await Promise.all([sha512File(path), stat(path)]);
    return { url, sha512, size: metadata.size };
  }));
  const feedPath = join(outputDirectory, 'latest-mac.yml');
  const temporaryPath = join(outputDirectory, `.latest-mac.${process.pid}.tmp`);
  await writeFile(temporaryPath, sidelineMacFeedYaml({ version, files, date: releaseDate(environment) }));
  await rename(temporaryPath, feedPath);
  return feedPath;
}

export default async function finalizeSidelineMacosRelease(buildResult) {
  const artifactPaths = [...new Set(buildResult.artifactPaths.map((path) => resolve(path)))];
  const dmgPaths = artifactPaths.filter((path) => path.endsWith('.dmg'));
  const zipPaths = artifactPaths.filter((path) => path.endsWith('.zip'));
  if (dmgPaths.length === 0 && zipPaths.length === 0) return [];
  if (process.platform !== 'darwin') throw new Error('Sideline macOS finalization must run on macOS');
  if (dmgPaths.length !== 1 || zipPaths.length !== 1) {
    throw new Error(`Expected one Sideline DMG and ZIP; found ${dmgPaths.length} DMG and ${zipPaths.length} ZIP`);
  }

  const identityResult = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true });
  const identity = selectDeveloperIdIdentity(
    `${identityResult.stdout}\n${identityResult.stderr}`,
    process.env.CSC_NAME,
  );
  const [dmgPath] = dmgPaths;
  await run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity.hash, dmgPath]);
  await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', dmgPath]);
  await run('/usr/bin/xcrun', [
    'notarytool', 'submit', dmgPath, ...notarytoolCredentialArgs(process.env),
    '--wait', '--timeout', '30m', '--output-format', 'json',
  ]);
  await run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
  await Promise.all([writeBlockmap(dmgPath), writeBlockmap(zipPaths[0])]);
  return [];
}
