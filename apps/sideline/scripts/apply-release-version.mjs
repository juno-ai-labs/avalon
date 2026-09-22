#!/usr/bin/env node
// Stamps the planner's patch version onto Sideline's manifest before the exact
// release commit is verified, signed, tagged, and published.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyManifestVersion } from '../../desktop/scripts/apply-release-version.mjs';
import { isEntryPoint } from '../../desktop/scripts/entry-point.mjs';
import { stableVersion } from './plan-release.mjs';

const sidelineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function applySidelineReleaseVersion(version, manifestPath) {
  stableVersion(version);
  const source = await readFile(manifestPath, 'utf8');
  const result = applyManifestVersion(source, version);
  if (result.changed) await writeFile(manifestPath, result.text, 'utf8');
  return result;
}

async function main() {
  const version = process.argv[2] ?? process.env.SIDELINE_RELEASE_VERSION;
  if (!version) throw new Error('Pass the Sideline release version or set SIDELINE_RELEASE_VERSION');
  const manifestPath = resolve(sidelineDirectory, 'package.json');
  const result = await applySidelineReleaseVersion(version, manifestPath);
  console.log(result.changed
    ? `Sideline ${result.previousVersion} -> ${version}`
    : `Sideline already declares ${version}`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Applying the Sideline release version failed');
    process.exitCode = 1;
  });
}
