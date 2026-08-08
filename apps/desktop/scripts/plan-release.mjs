#!/usr/bin/env node
// Decides whether a push to the default branch should release the desktop app,
// and under which tag. Emits GitHub Actions step outputs.
//
// Releases are keyed to the workspace version rather than to individual
// commits, because every published payload is immutable under v<version>: the
// same version can only ever be released once. A push therefore releases only
// when it *changes* the version, which makes the version bump the deliberate
// "ship this" signal and leaves ordinary merges to accumulate in the cycle.
//
// Tag pushes and manual dispatches keep their original meaning and always
// release the tag they name.

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReleaseTag } from './release-lib.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');

export function planRelease({
  eventName,
  refName,
  inputTag,
  headSha,
  rootVersion,
  desktopVersion,
  previousVersion,
  tagExists,
}) {
  if (eventName === 'workflow_dispatch') {
    if (!inputTag) throw new Error('A manual release dispatch must name an existing tag');
    return { shouldRelease: true, tag: inputTag, ref: inputTag, createTag: false, reason: `dispatched ${inputTag}` };
  }

  if (refName?.startsWith('v') && eventName === 'push' && inputTag === undefined) {
    // A tag push names its own release and the tag already exists.
    return { shouldRelease: true, tag: refName, ref: refName, createTag: false, reason: `tag push ${refName}` };
  }

  // Branch push: the workspace version is the candidate release.
  const tag = `v${rootVersion}`;
  assertReleaseTag(tag, rootVersion, desktopVersion);

  if (tagExists) {
    return { shouldRelease: false, tag, ref: headSha, createTag: false, reason: `${tag} is already released` };
  }
  if (previousVersion === rootVersion) {
    return {
      shouldRelease: false,
      tag,
      ref: headSha,
      createTag: false,
      reason: `version unchanged at ${rootVersion}; bump it to release`,
    };
  }
  return {
    shouldRelease: true,
    tag,
    ref: headSha,
    createTag: true,
    reason: `version bumped ${previousVersion ?? '(unknown)'} to ${rootVersion}`,
  };
}

function git(...args) {
  return execFileSync('/usr/bin/git', args, {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function versionAtCommit(commit) {
  try {
    return JSON.parse(git('show', `${commit}:package.json`)).version;
  } catch {
    return undefined;
  }
}

function tagExistsLocally(tag) {
  try {
    git('rev-parse', '-q', '--verify', `refs/tags/${tag}`);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const refName = process.env.GITHUB_REF_NAME;
  const headSha = process.env.GITHUB_SHA;
  const inputTag = process.env.RELEASE_INPUT_TAG || undefined;
  // The push payload's `before` spans every commit in the push, so a version
  // bump is still detected when several commits land at once. It is unset or
  // all-zeroes for a new branch, where the first parent is the best available
  // comparison point.
  const before = process.env.GITHUB_EVENT_BEFORE;
  const previousCommit = before && !/^0+$/u.test(before) ? before : `${headSha}^`;

  const [rootPackage, desktopPackage] = await Promise.all([
    readFile(resolve(repositoryDirectory, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(desktopDirectory, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  const isBranchPush = eventName === 'push' && !refName?.startsWith('v');
  const plan = planRelease({
    eventName,
    refName,
    inputTag,
    headSha,
    rootVersion: rootPackage.version,
    desktopVersion: desktopPackage.version,
    previousVersion: isBranchPush ? versionAtCommit(previousCommit) : undefined,
    tagExists: isBranchPush ? tagExistsLocally(`v${rootPackage.version}`) : false,
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
