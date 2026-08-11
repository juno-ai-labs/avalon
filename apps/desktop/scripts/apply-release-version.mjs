#!/usr/bin/env node
// Writes the version the planner chose into the workspace manifests, so the
// release the pipeline decided to cut is the version the artifacts declare.
//
// Versions are no longer bumped by hand in the change that ships. The planner
// derives the next version from the published record and this script stamps it
// onto `package.json` and `apps/desktop/package.json` immediately before the
// build, on the commit the release is cut from. Everything downstream —
// `validate-release-tag.mjs`, electron-builder's product version, the update
// feed — keeps reading the manifests, so they still have to agree with the tag.
//
// The rewrite is deliberately textual rather than a JSON round-trip: it edits
// the one top-level `version` line and then proves, by parsing both sides, that
// nothing else moved. A reformatting bump would churn the manifest and bury the
// one line that matters in a diff nobody can review.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { assertMinorReleaseVersion } from './release-lib.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');

// Two-space indentation is top level in both manifests; a nested `version`
// (a dependency's, say) is indented further and must never be touched.
const TOP_LEVEL_VERSION = /^ {2}"version": "(?<version>[^"]*)"(?<trailing>,?)$/mu;

export function applyManifestVersion(source, version) {
  const matches = source.match(new RegExp(TOP_LEVEL_VERSION, 'gmu')) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one top-level version field; found ${matches.length}`);
  }
  const updated = source.replace(TOP_LEVEL_VERSION, `  "version": "${version}"$<trailing>`);

  // The edit is only safe if it changed the version and nothing else.
  const before = JSON.parse(source);
  const after = JSON.parse(updated);
  if (after.version !== version) {
    throw new Error(`Rewriting the manifest version produced ${after.version}, not ${version}`);
  }
  const withoutVersion = (manifest) => JSON.stringify(Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'version'),
  ));
  if (withoutVersion(before) !== withoutVersion(after)) {
    throw new Error('Rewriting the manifest version changed another field');
  }
  return { text: updated, changed: updated !== source, previousVersion: before.version };
}

export async function applyReleaseVersion(version, paths) {
  assertMinorReleaseVersion(version);
  const results = [];
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    const result = applyManifestVersion(source, version);
    if (result.changed) await writeFile(path, result.text, 'utf8');
    results.push({ path, ...result });
  }
  return { version, changed: results.some((result) => result.changed), results };
}

async function main() {
  const version = process.argv[2] ?? process.env.RELEASE_VERSION?.replace(/^v/u, '');
  if (!version) throw new Error('Pass the release version or set RELEASE_VERSION');

  const outcome = await applyReleaseVersion(version, [
    resolve(repositoryDirectory, 'package.json'),
    resolve(desktopDirectory, 'package.json'),
  ]);
  for (const result of outcome.results) {
    const state = result.changed ? `${result.previousVersion} -> ${version}` : `already ${version}`;
    console.log(`${result.path}: ${state}`);
  }
  return outcome.changed;
}

if (isEntryPoint(import.meta.url)) {
  main()
    .then(async (changed) => {
      // A re-run after a release that failed past the bump finds the manifests
      // already stamped. That is a resumable state, not an error: the caller
      // skips the commit and builds the same version again.
      if (process.env.GITHUB_OUTPUT) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Applying the release version failed');
      process.exitCode = 1;
    });
}
