import assert from 'node:assert/strict';
import test from 'node:test';

import { planRelease } from './plan-release.mjs';

const RELEASED = '1111111111111111111111111111111111111111';

const branchPush = (overrides = {}) => ({
  eventName: 'push',
  headSha: 'abc123',
  publishedVersion: '1.33.0',
  releasedCommit: RELEASED,
  changedPaths: ['apps/desktop/src/main/index.ts'],
  ...overrides,
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
  const plan = planRelease(branchPush({ changedPaths: ['apps/desktop/src/renderer/App.tsx'] }));
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '1.34.0');
});

test('a merge with nothing at all since the release skips', () => {
  const plan = planRelease(branchPush({ changedPaths: [] }));
  assert.equal(plan.shouldRelease, false);
  assert.match(plan.reason, /nothing has landed/u);
});

test("the release's own version bump cannot trigger another release", () => {
  // The bump commit matches the workflow's paths filter — it edits
  // package.json — so this skip is the guard that stops a release loop, and it
  // works because the bump becomes the watermark rather than part of the diff.
  const plan = planRelease(branchPush({ changedPaths: [] }));
  assert.equal(plan.shouldRelease, false);
});

test('a bump left behind by a failed release is picked back up', () => {
  // The bump pushed to main before a build that then failed is not the
  // watermark, so it shows as unreleased work and the same version is retried
  // — apply-release-version.mjs finds the manifests already stamped.
  const plan = planRelease(branchPush({ changedPaths: ['package.json', 'apps/desktop/package.json'] }));
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '1.34.0');
});

test('work stranded by an earlier discarded run ships with the next release', () => {
  // The `paths:` filter only sees the newest push. The watermark is what makes
  // a release carry everything since the last one that actually published.
  const plan = planRelease(branchPush({
    changedPaths: ['apps/desktop/src/main/older-merge.ts', 'apps/desktop/src/main/newest-merge.ts'],
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
  // changedPaths is null when git cannot reach the recorded commit — a force
  // push, or a pruned object.
  const plan = planRelease(branchPush({ changedPaths: null }));
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
  const afterRelease = planRelease(branchPush({ publishedVersion: '1.34.0', changedPaths: [] }));
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

test('the planner no longer second-guesses the trigger it sits behind', () => {
  // The `paths:` filter decides release-worthiness now. Re-applying a path list
  // here would mean two lists to keep in sync, and the stricter of the two
  // would silently win — so any change at all since the watermark releases.
  const plan = planRelease(branchPush({ changedPaths: ['docs/RUNBOOK.md'] }));
  assert.equal(plan.shouldRelease, true);
});
