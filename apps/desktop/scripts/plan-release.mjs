#!/usr/bin/env node
// Decides whether a push to the default branch should release the desktop app,
// and under which tag. Emits GitHub Actions step outputs.
//
// Releases are keyed to the workspace version rather than to individual
// commits, because every published payload is immutable under v<version>: the
// same version can only ever be released once. The gate compares the workspace
// version against the last one actually published, recorded in
// apps/site/release.config.json — the same record publish-r2-release.mjs reads
// to enforce release ordering. A merge whose version is ahead of the record
// ships it; every merge after that skips.
//
// Tags are an artifact of a release, never an input: nothing here reads them,
// and nothing triggers on them. The release record is the authority, which
// keeps the decision on durable committed state rather than on a push event —
// the concurrency group keeps only the newest pending run, so a rule derived
// from a single push's diff could see its run discarded and skip forever.
//
// A manual dispatch names an existing tag and replays that release.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReleaseTag, compareVersions } from './release-lib.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');

export function planRelease({
  eventName,
  inputTag,
  headSha,
  rootVersion,
  desktopVersion,
  publishedVersion,
}) {
  if (eventName === 'workflow_dispatch') {
    if (!inputTag) throw new Error('A manual release dispatch must name an existing tag');
    return { shouldRelease: true, tag: inputTag, ref: inputTag, createTag: false, reason: `dispatched ${inputTag}` };
  }

  // Branch push: the workspace version is the candidate release.
  const tag = `v${rootVersion}`;
  if (compareVersions(rootVersion, publishedVersion) <= 0) {
    return {
      shouldRelease: false,
      tag,
      ref: headSha,
      createTag: false,
      reason: `${rootVersion} is not ahead of the published ${publishedVersion}`,
    };
  }
  // Below the short-circuit on purpose: a violated invariant should redden the
  // merge that introduced it, not every subsequent merge. CI already enforces
  // this on the pull request, so here it is a backstop.
  assertReleaseTag(tag, rootVersion, desktopVersion);
  return {
    shouldRelease: true,
    tag,
    ref: headSha,
    createTag: true,
    reason: `${rootVersion} is ahead of the published ${publishedVersion}`,
  };
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const headSha = process.env.GITHUB_SHA;
  const inputTag = process.env.RELEASE_INPUT_TAG || undefined;

  const [rootPackage, desktopPackage, siteRelease] = await Promise.all([
    readFile(resolve(repositoryDirectory, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(desktopDirectory, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(repositoryDirectory, 'apps/site/release.config.json'), 'utf8').then(JSON.parse),
  ]);

  const plan = planRelease({
    eventName,
    inputTag,
    headSha,
    rootVersion: rootPackage.version,
    desktopVersion: desktopPackage.version,
    publishedVersion: siteRelease.version,
  });

  console.log(`Release plan: ${plan.shouldRelease ? 'release' : 'skip'} — ${plan.reason}`);
  const output = [
    `should_release=${plan.shouldRelease}`,
    `tag=${plan.tag}`,
    `ref=${plan.ref}`,
    `create_tag=${plan.createTag}`,
    `reason=${plan.reason}`,
  ].join('\n');
  console.log(output);
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(async (output) => {
      if (process.env.GITHUB_OUTPUT) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Release planning failed');
      process.exitCode = 1;
    });
}
