#!/usr/bin/env node
// Decides whether a push to the default branch should release the desktop app,
// and under which version. Emits GitHub Actions step outputs.
//
// Nobody bumps a version by hand. The release record in
// apps/site/release.config.json holds the last published version *and the
// commit it was built from*, and that commit is the watermark: if anything
// affecting the desktop app has landed on main since it, the next minor is due
// and the pipeline stamps it onto the manifests itself (apply-release-version
// .mjs), commits that bump, and builds it.
//
// The watermark replaces the older version-ahead-of-record gate, which made the
// bump the release trigger. That gate was correct but silent in the failure
// case everyone actually hit: a merge that changed the desktop app and forgot
// the bump did not release, and — because the workflow is unfiltered by path —
// looked exactly like a merge that had nothing to ship. Desktop work then piled
// up on main until some later change happened to carry a bump.
//
// So the path filter that used to be absent now lives here, where it can be
// tested and where it decides the release rather than the workflow trigger:
// DESKTOP_RELEASE_PATHS lists what actually goes into the built app. A docs or
// Worker-only merge changes nothing a user could install and does not spend a
// 90-minute signed, notarized macOS build.
//
// It also closes the loop the pipeline's own commits would otherwise create.
// The release writes two commits back to main — the version bump (which becomes
// the new watermark, so it is never re-examined) and the recorded release
// config (which touches apps/site/release.config.json only, and so matches
// nothing here). Neither can trigger a release, and neither could anyway:
// GITHUB_TOKEN pushes do not start workflow runs.
//
// Tags are an artifact of a release, never an input: nothing here reads them,
// and nothing triggers on them. Keeping the decision on durable committed state
// also survives run collapse — the concurrency group keeps only the newest
// pending run, so a rule derived from a single push's diff could see its run
// discarded and skip forever.
//
// A manual dispatch names an existing tag and replays that release.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nextReleaseVersion } from './release-lib.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');

// What ends up inside the installed application, plus the workspace manifests
// that determine how it is built. A trailing slash matches a directory.
//
// Deliberately absent: docs, the Workers under apps/api, the landing site, the
// retention Worker, repository-root tooling under scripts/, and the CI and
// deployment workflows. None of them change a byte a user installs.
export const DESKTOP_RELEASE_PATHS = [
  'apps/desktop/',
  'packages/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.github/workflows/release-desktop-macos.yml',
];

export function affectsDesktopRelease(path) {
  return DESKTOP_RELEASE_PATHS.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

export function planRelease({
  eventName,
  inputTag,
  headSha,
  publishedVersion,
  releasedCommit,
  changedPaths,
}) {
  if (eventName === 'workflow_dispatch') {
    if (!inputTag) throw new Error('A manual release dispatch must name an existing tag');
    return {
      shouldRelease: true,
      version: inputTag.replace(/^v/u, ''),
      tag: inputTag,
      ref: inputTag,
      createTag: false,
      reason: `dispatched ${inputTag}`,
    };
  }

  // Branch push: the next minor after the published record is the candidate.
  const version = nextReleaseVersion(publishedVersion);
  const tag = `v${version}`;
  const base = { version, tag, ref: headSha };
  const release = (reason) => ({ ...base, shouldRelease: true, createTag: true, reason });
  const skip = (reason) => ({ ...base, shouldRelease: false, createTag: false, reason });

  // Both unknown-watermark cases fail open. Releasing a version that had
  // nothing new in it wastes a build; skipping one that did retires desktop
  // work silently, which is the failure this planner exists to prevent.
  if (!releasedCommit) {
    return release(`no released commit is recorded, so ${version} ships the current tree`);
  }
  if (changedPaths === null) {
    return release(`the recorded release commit is unreachable, so ${version} ships the current tree`);
  }

  const affecting = changedPaths.filter((path) => affectsDesktopRelease(path));
  const short = releasedCommit.slice(0, 7);
  if (affecting.length === 0) {
    return skip(
      changedPaths.length === 0
        ? `nothing has landed since the released commit ${short}`
        : `none of the ${changedPaths.length} paths changed since ${short} affect the desktop app`,
    );
  }
  return release(`${affecting.length} desktop path(s) changed since ${short}: ${affecting.slice(0, 5).join(', ')}`);
}

// Returns null when the watermark is not reachable in this checkout — a
// force-push or a pruned commit — which the planner treats as unknown.
export function changedPathsSince(releasedCommit, headSha) {
  try {
    const output = execFileSync(
      '/usr/bin/git',
      ['diff', '--name-only', `${releasedCommit}..${headSha}`],
      { cwd: repositoryDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const headSha = process.env.GITHUB_SHA;
  const inputTag = process.env.RELEASE_INPUT_TAG || undefined;

  const siteRelease = await readFile(resolve(repositoryDirectory, 'apps/site/release.config.json'), 'utf8')
    .then(JSON.parse);
  const releasedCommit = typeof siteRelease.commit === 'string' ? siteRelease.commit : undefined;

  const plan = planRelease({
    eventName,
    inputTag,
    headSha,
    publishedVersion: siteRelease.version,
    releasedCommit,
    changedPaths: releasedCommit && eventName !== 'workflow_dispatch'
      ? changedPathsSince(releasedCommit, headSha)
      : [],
  });

  console.log(`Release plan: ${plan.shouldRelease ? 'release' : 'skip'} — ${plan.reason}`);
  const output = [
    `should_release=${plan.shouldRelease}`,
    `version=${plan.version}`,
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
