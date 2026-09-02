import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_RECORD_PATH, planRelease, planningCommit } from './plan-release.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Resolved the way plan-release.mjs and validate-release-tag.mjs resolve it —
// by absolute path rather than through PATH. Those two run in this same macOS
// release job, so the path is already load-bearing there.
const GIT = '/usr/bin/git';
// Resolves to nothing, so `git show <sha>:<path>` cannot serve the record and
// the script is left with its working-tree fallback.
const UNRESOLVABLE_SHA = '0000000000000000000000000000000000000000';

const RELEASED = '1111111111111111111111111111111111111111';

const branchPush = (overrides = {}) => ({
  eventName: 'push',
  headSha: 'abc123',
  publishedVersion: '1.33.0',
  releasedCommit: RELEASED,
  releaseInputPaths: ['apps/desktop/src/main/index.ts'],
  ...overrides,
});

test('a branch push is planned from the tip, not from what triggered it', () => {
  // The trigger commit is what broke v1.49.0: it predates the record the
  // release ahead of this run pushed while this one waited for the queue slot,
  // so planning from it cut a version that had already shipped.
  assert.equal(planningCommit('trigger-sha', 'tip-sha'), 'tip-sha');
});

test('an unreadable tip falls back to the checkout rather than failing the plan', () => {
  // Same fail-open reasoning as an unknown watermark: a plan that cannot read
  // the tip should still cut a release, because skipping retires desktop work
  // silently and that is the failure this planner exists to prevent.
  assert.equal(planningCommit('trigger-sha', null), 'trigger-sha');
});

test('a dispatch plans without reading the release record at all', () => {
  // The property rather than the shape. A dispatch is the break-glass path, so
  // a record that cannot be read must not be able to fail it — the same reason
  // planRelease refuses to judge whether the named tag exists. Proved by running
  // the real script in a throwaway worktree with the record deleted and a commit
  // nothing resolves to, which leaves neither the git read nor the working-tree
  // fallback able to produce one. Before the dispatch returned early this exact
  // invocation exited 1 on ENOENT.
  const worktree = mkdtempSync(join(tmpdir(), 'plan-release-'));
  try {
    execFileSync(GIT, ['worktree', 'add', '--detach', worktree, 'HEAD'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    rmSync(join(worktree, RELEASE_RECORD_PATH));
    // The worktree is checked out at HEAD, so without this the test would run
    // the committed script rather than the one under test — and pass or fail on
    // the wrong code.
    cpSync(
      resolve(repositoryRoot, 'apps/desktop/scripts'),
      join(worktree, 'apps/desktop/scripts'),
      { recursive: true },
    );
    const run = (env) => execFileSync(
      process.execPath,
      [join(worktree, 'apps/desktop/scripts/plan-release.mjs')],
      { env: { ...process.env, GITHUB_OUTPUT: '', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const dispatched = run({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      RELEASE_INPUT_TAG: 'v9.9.0',
      GITHUB_SHA: UNRESOLVABLE_SHA,
    });
    assert.match(dispatched, /should_release=true/u);
    assert.match(dispatched, /tag=v9\.9\.0/u);
    assert.match(dispatched, /create_tag=false/u);

    // The control: the same tree still plans a branch push, which does read the
    // record — through git, where deleting the working-tree copy cannot reach
    // it. Without this the dispatch case could pass on a worktree too broken to
    // run anything. It passes a resolvable commit rather than the unresolvable
    // one so it holds wherever it runs: CI checks a pull request out at depth 1,
    // so `origin/main` does not exist there, and a push planned from an
    // unresolvable head would fall through to the deleted working-tree copy and
    // fail for a reason that has nothing to do with what is being tested.
    const resolvableSha = execFileSync(GIT, ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    assert.match(run({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: resolvableSha }), /should_release=/u);
  } finally {
    // Best effort, so a cleanup failure cannot replace whatever the test was
    // actually reporting with a git error — `worktree add` failing early would
    // otherwise guarantee that swap. The directory goes either way: mkdtemp
    // created it before git was involved, so nothing above is a precondition
    // for deleting it.
    let removed = false;
    try {
      execFileSync(GIT, ['worktree', 'remove', '--force', worktree], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
      removed = true;
    } catch { /* The registration is cleared below instead. */ }
    rmSync(worktree, { recursive: true, force: true });
    if (!removed) {
      // `prune` drops only registrations whose directory is already gone, so it
      // has to follow the delete. Running it first — while the worktree is still
      // on disk — is a no-op that leaves the registration behind for good.
      try {
        execFileSync(GIT, ['worktree', 'prune'], { cwd: repositoryRoot, stdio: 'ignore' });
      } catch { /* A stale registration outlives the run at worst. */ }
    }
  }
});

test('the planner still runs when it is reached through a symlinked path', () => {
  // The test above runs the script out of `os.tmpdir()`, and on macOS that is
  // `/var/folders/…` where `/var` is a symlink to `/private/var` — so the
  // script is reached through a symlink there and through a real directory on
  // Linux, where `/tmp` is not one. An entry-point guard comparing
  // `process.argv[1]` to `import.meta.url` raw sees those two spellings of one
  // file as different modules, runs nothing, and exits 0 with empty stdout,
  // which is a release plan step reporting success while emitting no outputs.
  // The platform difference is the whole reason it reached the macOS release
  // job: Linux CI runs this same suite and could not see it. Asserted directly,
  // through a symlink built by hand, so it stays caught wherever this runs
  // rather than only where the temporary directory happens to be one.
  const enclosing = mkdtempSync(join(tmpdir(), 'plan-release-symlink-'));
  try {
    const linkedScripts = join(enclosing, 'scripts');
    symlinkSync(resolve(repositoryRoot, 'apps/desktop/scripts'), linkedScripts);
    const output = execFileSync(
      process.execPath,
      [join(linkedScripts, 'plan-release.mjs')],
      {
        env: {
          ...process.env,
          GITHUB_OUTPUT: '',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          RELEASE_INPUT_TAG: 'v9.9.0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.match(output, /should_release=true/u);
    assert.match(output, /tag=v9\.9\.0/u);
  } finally {
    // Removes the symlink itself rather than what it points at: `rmSync` does
    // not follow one, so the checked-out scripts directory is never at risk.
    rmSync(enclosing, { recursive: true, force: true });
  }
});

test('desktop work since the released commit releases the next minor', () => {
  const plan = planRelease(branchPush());
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '1.34.0');
  assert.equal(plan.tag, 'v1.34.0');
  assert.equal(plan.ref, 'abc123');
  assert.equal(plan.createTag, true);
});

test('nobody has to bump a version for the change to ship', () => {
  // The whole point of the watermark: the merge that changed the desktop app
  // carries no version edit, and it still releases.
  const plan = planRelease(branchPush({ releaseInputPaths: ['apps/desktop/src/renderer/App.tsx'] }));
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '1.34.0');
});

test('the state a completed release actually leaves behind skips', () => {
  // This is the case the wiring produces, and the one an earlier version of
  // this test got wrong by hand-feeding []. The watermark is the *bump* commit,
  // and the release then pushes the record as a later commit, so the diff from
  // the watermark always contains apps/site/release.config.json. Feeding []
  // tested a state that cannot occur and left the skip below dead — a re-plan
  // of a finished release cut an empty minor.
  const plan = planRelease(branchPush({ releaseInputPaths: [RELEASE_RECORD_PATH] }));
  assert.equal(plan.shouldRelease, false);
  assert.match(plan.reason, /nothing but the release record/u);
});

test('the record is excluded by name, not by being the only path', () => {
  // Real work landing alongside the record still releases.
  const plan = planRelease(branchPush({
    releaseInputPaths: [RELEASE_RECORD_PATH, 'apps/desktop/src/main/index.ts'],
  }));
  assert.equal(plan.shouldRelease, true);
  assert.match(plan.reason, /1 path\(s\) changed/u);
});

test('a merge with nothing at all since the release skips', () => {
  const plan = planRelease(branchPush({ releaseInputPaths: [] }));
  assert.equal(plan.shouldRelease, false);
});

test('a bump left behind by a failed release is picked back up', () => {
  // The bump pushed to main before a build that then failed is not the
  // watermark, so it shows as unreleased work and the same version is retried
  // — apply-release-version.mjs finds the manifests already stamped.
  const plan = planRelease(branchPush({ releaseInputPaths: ['package.json', 'apps/desktop/package.json'] }));
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '1.34.0');
});

test('work stranded by an earlier discarded run ships with the next release', () => {
  // The `paths:` filter only sees the newest push. The watermark is what makes
  // a release carry everything since the last one that actually published.
  const plan = planRelease(branchPush({
    releaseInputPaths: ['apps/desktop/src/main/older-merge.ts', 'apps/desktop/src/main/newest-merge.ts'],
  }));
  assert.equal(plan.shouldRelease, true);
  assert.match(plan.reason, /2 path\(s\) changed/u);
});

test('an unrecorded watermark fails open rather than retiring work silently', () => {
  // Skipping a release that had work in it is the failure mode this planner
  // exists to prevent, so an unknown watermark releases.
  const plan = planRelease(branchPush({ releasedCommit: undefined }));
  assert.equal(plan.shouldRelease, true);
  assert.match(plan.reason, /no released commit is recorded/u);
});

test('an unreachable watermark fails open too', () => {
  // releaseInputPaths is null when git cannot reach the recorded commit — a force
  // push, or a pruned object.
  const plan = planRelease(branchPush({ releaseInputPaths: null }));
  assert.equal(plan.shouldRelease, true);
  assert.match(plan.reason, /unreachable/u);
});

test('the version is always exactly one minor above the published record', () => {
  // publish-r2-release.mjs enforces the same rule through
  // assertNextReleaseVersion, so anything else would fail at publication.
  assert.equal(planRelease(branchPush({ publishedVersion: '1.9.0' })).version, '1.10.0');
  assert.equal(planRelease(branchPush({ publishedVersion: '2.0.0' })).version, '2.1.0');
});

test('the stable promotion stays a human decision', () => {
  // assertNextReleaseVersion accepts 0.x -> 1.0.0, but automation never picks
  // it: a major promotion is not something a merge should trigger.
  assert.equal(planRelease(branchPush({ publishedVersion: '0.9.0' })).version, '0.10.0');
});

test('a version already published is never cut twice', () => {
  // Every published payload is immutable under v<version>. The watermark moves
  // with each release, so the same version cannot come around again.
  const afterRelease = planRelease(branchPush({ publishedVersion: '1.34.0', releaseInputPaths: [] }));
  assert.equal(afterRelease.shouldRelease, false);
  const next = planRelease(branchPush({ publishedVersion: '1.34.0' }));
  assert.equal(next.version, '1.35.0');
});

test('a dispatch replays the tag it names without creating one', () => {
  const plan = planRelease({ eventName: 'workflow_dispatch', inputTag: 'v1.34.0' });
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '1.34.0');
  assert.equal(plan.tag, 'v1.34.0');
  assert.equal(plan.ref, 'v1.34.0');
  assert.equal(plan.createTag, false);
});

test('a manual dispatch without a tag fails rather than guessing', () => {
  assert.throws(() => planRelease({ eventName: 'workflow_dispatch' }), /must name the tag to replay/u);
});

test('a malformed dispatch tag fails on the cheap runner, not the macOS one', () => {
  // The planner exists so nothing claims a 90-minute signed build to discover
  // it has nothing to ship. A typo in the dispatch input is exactly that case:
  // validate-release-tag.mjs would reject it, but only after the runner and the
  // whole install-and-verify prologue had been spent.
  for (const tag of ['1.34.0', 'v1.34.1', 'v1.34.0-rc.1', 'not-a-tag', 'v']) {
    assert.throws(
      () => planRelease({ eventName: 'workflow_dispatch', inputTag: tag }),
      /Release tag must have the form|patch 0|Invalid semantic version/u,
      `dispatching ${tag} must not reach a macOS runner`,
    );
  }
});

test('a dispatch tag is judged on shape alone, never on existence', () => {
  // A dispatch is the break-glass path — replaying a tag after a release failed
  // past publication. A planner that could wrongly decide a tag is missing
  // would block that during an incident, so existence stays with the checkout
  // and validate-release-tag.mjs.
  const plan = planRelease({ eventName: 'workflow_dispatch', inputTag: 'v9.99.0' });
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '9.99.0');
});

test('tags are never consulted, so a hand-cut tag changes nothing', () => {
  // A tag is a record of a release. Pushing one out of band must not make the
  // planner think a version shipped, nor stop it from shipping.
  const plan = planRelease(branchPush({ tagExists: true, tag: 'v1.34.0' }));
  assert.equal(plan.shouldRelease, true);
});

test('the plan is idempotent across repeated merges', () => {
  // Same inputs, same answer: nothing depends on which push triggered it, so a
  // run collapsed by the concurrency group loses nothing.
  assert.deepEqual(planRelease(branchPush()), planRelease(branchPush()));
});

test('a trigger with no release input since the watermark stops on Ubuntu', () => {
  // Every contracts change reaches the workflow, but the classifier removes an
  // API-only or test-only change before the pure planner sees it.
  const plan = planRelease(branchPush({ releaseInputPaths: [] }));
  assert.equal(plan.shouldRelease, false);
});
