import assert from 'node:assert/strict';
import test from 'node:test';

import { affectsDesktopRelease, planRelease } from './plan-release.mjs';

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

test('a merge that changes nothing shipped in the app does not spend a build', () => {
  const plan = planRelease(branchPush({
    changedPaths: ['docs/RUNBOOK.md', 'apps/api/src/index.ts', 'README.md'],
  }));
  assert.equal(plan.shouldRelease, false);
  assert.match(plan.reason, /affect the desktop app/u);
});

test('a merge with nothing at all since the release skips', () => {
  const plan = planRelease(branchPush({ changedPaths: [] }));
  assert.equal(plan.shouldRelease, false);
  assert.match(plan.reason, /nothing has landed/u);
});

test("the release's own recorded config cannot trigger another release", () => {
  // The last thing a release does is commit apps/site/release.config.json back
  // to main. If that commit looked like desktop work, every release would cut
  // another one for ever.
  const plan = planRelease(branchPush({ changedPaths: ['apps/site/release.config.json'] }));
  assert.equal(plan.shouldRelease, false);
});

test("the release's own version bump cannot trigger another release", () => {
  // The bump commit becomes the watermark, so it is the diff base rather than
  // part of the diff. Simulate the state right after a successful release.
  const plan = planRelease(branchPush({ changedPaths: [] }));
  assert.equal(plan.shouldRelease, false);
});

test('a bump left behind by a failed release is picked back up', () => {
  // The bump pushed to main before a build that then failed is not the
  // watermark, so it shows as unreleased desktop work and the same version is
  // retried — apply-release-version.mjs finds the manifests already stamped.
  const plan = planRelease(branchPush({ changedPaths: ['package.json', 'apps/desktop/package.json'] }));
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.version, '1.34.0');
});

test('one desktop path among many ignorable ones still releases', () => {
  const plan = planRelease(branchPush({
    changedPaths: ['docs/README.md', 'apps/api/src/index.ts', 'packages/contracts/src/index.ts'],
  }));
  assert.equal(plan.shouldRelease, true);
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
  assert.throws(() => planRelease({ eventName: 'workflow_dispatch' }), /must name an existing tag/u);
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

test('the release path set covers what ships and excludes what does not', () => {
  for (const path of [
    'apps/desktop/src/main/index.ts',
    'apps/desktop/package.json',
    'apps/desktop/electron-builder.yml',
    'packages/contracts/src/index.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    '.github/workflows/release-desktop-macos.yml',
  ]) {
    assert.equal(affectsDesktopRelease(path), true, `${path} ships in the desktop app`);
  }

  for (const path of [
    'docs/RUNBOOK.md',
    'README.md',
    'apps/api/src/index.ts',
    'apps/site/release.config.json',
    'apps/site/src/pages/index.astro',
    'apps/release-retention/src/index.ts',
    'scripts/check-regional-health.mjs',
    'assets/brand/logo.svg',
    'config/provider-apps/github.json',
    'eslint.config.mjs',
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-api.yml',
  ]) {
    assert.equal(affectsDesktopRelease(path), false, `${path} does not change the installed app`);
  }
});

test('a directory entry never matches a sibling that merely shares its prefix', () => {
  assert.equal(affectsDesktopRelease('apps/desktop-notes/README.md'), false);
  assert.equal(affectsDesktopRelease('packages-archive/old/index.ts'), false);
});
