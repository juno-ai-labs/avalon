#!/usr/bin/env node
// Decides whether a push to the default branch should release the desktop app,
// and under which tag. Emits GitHub Actions step outputs.
//
// Releases are keyed to the workspace version rather than to individual
// commits, because every published payload is immutable under v<version>: the
// same version can only ever be released once. The existence of the tag is
// therefore the whole gate — any merge while the current version is unreleased
// ships it, exactly once, and every merge after that skips.
//
// Deliberately *not* keyed to "this push changed the version". The concurrency
// group keeps only the newest pending run, so a bump that merges while a
// release is in flight can have its run dropped by a later merge; a diff
// against that push's `before` would then see no change and skip forever,
// silently retiring the version. Tag existence is durable state and survives
// run collapse.
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
  if (tagExists) {
    return { shouldRelease: false, tag, ref: headSha, createTag: false, reason: `${tag} is already released` };
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
    reason: `${rootVersion} has not been released yet`,
  };
}

function git(...args) {
  return execFileSync('/usr/bin/git', args, {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
