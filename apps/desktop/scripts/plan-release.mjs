#!/usr/bin/env node
// Decides whether a push to the default branch should release the desktop app,
// and under which version. Emits GitHub Actions step outputs.
//
// Nobody bumps a version by hand. The release record in
// apps/site/release.config.json holds the last published version *and the
// commit it was built from*, and that commit is the watermark: if anything has
// landed on main since it, the next minor is due and the pipeline stamps it
// onto the manifests itself (apply-release-version.mjs), commits that bump,
// and builds it.
//
// The workflow's `paths:` filter decides whether a push is release-worthy at
// all, so by the time this runs the push has already touched something the
// installed app is built from. What is left for the planner is the version and
// the durable half of the question: `paths:` sees only this push's diff, so it
// cannot tell whether the last release actually shipped. The watermark can, and
// it is what makes a re-run after a discarded or failed run pick up everything
// still unreleased rather than only the newest push's contents.
//
// It also closes the loop the pipeline's own commits would otherwise create.
// The release writes two commits back to main. The version bump becomes the new
// watermark, so it is the diff base rather than part of the diff. The recorded
// release config lands *after* that watermark, so it is always in the diff and
// has to be excluded by name — see RELEASE_RECORD_PATH. Neither could trigger a
// run anyway: the `paths:` filter excludes the record, and GITHUB_TOKEN pushes
// do not start workflow runs. Two independent guards on purpose, because a
// release publishes immutable payloads and a loop cannot be undone by hand.
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

import { isEntryPoint } from './entry-point.mjs';
import { nextReleaseVersion, parseReleaseTag } from './release-lib.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');

// The release's own bookkeeping, and the one path a diff from the watermark can
// contain without meaning there is work to ship.
//
// The watermark is the commit the release *built* — the version bump — but the
// record naming it lands as a later commit on main, so it is always in the diff
// that follows. Real history shows it exactly: `c3a547b "Record Rally 1.33.0
// release config"` has the recorded watermark `f4e66c6` as its direct parent.
// Without this, the diff is never empty, the skip below is dead code, and a
// re-planned release cuts an empty minor.
export const RELEASE_RECORD_PATH = 'apps/site/release.config.json';

export function planRelease({
  eventName,
  inputTag,
  headSha,
  publishedVersion,
  releasedCommit,
  changedPaths,
}) {
  if (eventName === 'workflow_dispatch') {
    if (!inputTag) throw new Error('A manual release dispatch must name the tag to replay');
    // Shape only. Whether the tag exists is settled by the checkout and by
    // validate-release-tag.mjs against the working tree, deliberately not here:
    // a dispatch is the break-glass path, and a planner that could wrongly
    // decide a tag is missing would block a release during an incident. A
    // malformed tag, by contrast, can never be valid, so rejecting it now keeps
    // a typo from claiming a 90-minute macOS runner to fail its own guard.
    const version = parseReleaseTag(inputTag);
    return {
      shouldRelease: true,
      version,
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

  const short = releasedCommit.slice(0, 7);
  const outstanding = changedPaths.filter((path) => path !== RELEASE_RECORD_PATH);
  if (outstanding.length === 0) {
    return skip(`nothing but the release record has landed since the released commit ${short}`);
  }
  return release(`${outstanding.length} path(s) changed since ${short}: ${outstanding.slice(0, 5).join(', ')}`);
}

// Returns null when the ref cannot be read — a pruned commit, or a file that
// does not exist at it — so every caller can fall back rather than fail.
function gitOutput(args) {
  try {
    return execFileSync('/usr/bin/git', args, {
      cwd: repositoryDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The commit a branch push is planned from.
 *
 * `actions/checkout` hands this job the commit that triggered the run, but a
 * run that waited in the release queue was triggered long before it got the
 * slot — and the release ahead of it pushes `Record Rally <version> release
 * config` to main as its last act. Planning from the trigger therefore reads a
 * record that predates a release which has already shipped, and cuts that
 * version a second time. Its tag is already pushed by then, so the run dies at
 * `git tag`, and the bump step's resume path cannot tell that apart from a
 * release that failed before publishing.
 *
 * Main's tip is also the commit the release job actually builds — its bump step
 * resets to `origin/main` on the same reasoning — so planning from it removes a
 * disagreement between the two rather than introducing one. An unreadable tip
 * falls back to the checkout, which is the behaviour this replaces.
 */
export function planningCommit(headSha, tipSha) {
  return tipSha ?? headSha;
}

// The release record as it stands at a commit, rather than in the working tree,
// so the plan reads the same state the release job will build against.
export function releaseRecordAt(commit) {
  const contents = gitOutput(['show', `${commit}:${RELEASE_RECORD_PATH}`]);
  if (contents === null) return null;
  try {
    return JSON.parse(contents);
  } catch {
    return null;
  }
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

  // A dispatch replays the tag it names, and nothing else bears on that plan, so
  // it reads no record at all. That is a property to hold rather than an
  // optimisation: a dispatch is the break-glass path, and the reasoning that
  // keeps planRelease from checking whether the tag exists — a planner that
  // could wrongly decide a tag is missing would block a release during an
  // incident — applies just as well to a record it never consults. Loading one
  // anyway would let a record that is missing or malformed at the checked-out
  // tag fail the plan step at exactly the wrong moment.
  if (eventName === 'workflow_dispatch') {
    return report(planRelease({ eventName, inputTag, headSha, changedPaths: [] }));
  }

  // A branch push plans from main's tip.
  const planFrom = planningCommit(headSha, gitOutput(['rev-parse', 'origin/main']));
  const siteRelease = releaseRecordAt(planFrom)
    ?? await readFile(resolve(repositoryDirectory, RELEASE_RECORD_PATH), 'utf8').then(JSON.parse);
  const releasedCommit = typeof siteRelease.commit === 'string' ? siteRelease.commit : undefined;

  return report(planRelease({
    eventName,
    inputTag,
    headSha: planFrom,
    publishedVersion: siteRelease.version,
    releasedCommit,
    changedPaths: releasedCommit ? changedPathsSince(releasedCommit, planFrom) : [],
  }));
}

function report(plan) {
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

// Guarded on identity rather than on how the path was spelled: this script is
// run out of a symlinked temporary directory by its own test, and on macOS
// every such directory is symlinked. See entry-point.mjs — a plan step that
// silently emits no outputs is worse here than one that fails.
if (isEntryPoint(import.meta.url)) {
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
