import assert from 'node:assert/strict';
import test from 'node:test';

import { planRelease } from './plan-release.mjs';

const branchPush = (overrides = {}) => ({
  eventName: 'push',
  refName: 'main',
  headSha: 'abc123',
  rootVersion: '1.34.0',
  desktopVersion: '1.34.0',
  previousVersion: '1.33.0',
  tagExists: false,
  ...overrides,
});

test('a version bump on the default branch releases and creates its tag', () => {
  const plan = planRelease(branchPush());
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.tag, 'v1.34.0');
  assert.equal(plan.ref, 'abc123');
  assert.equal(plan.createTag, true);
});

test('a merge that does not change the version does not release', () => {
  const plan = planRelease(branchPush({ previousVersion: '1.34.0' }));
  assert.equal(plan.shouldRelease, false);
  assert.equal(plan.createTag, false);
  assert.match(plan.reason, /bump it to release/u);
});

test('an already released version never republishes, even if the bump reappears', () => {
  // Guards revert-and-remerge and re-run of an earlier push: the immutable R2
  // payloads for that version are already published.
  const plan = planRelease(branchPush({ tagExists: true }));
  assert.equal(plan.shouldRelease, false);
  assert.equal(plan.createTag, false);
  assert.match(plan.reason, /already released/u);
});

test('a version bump whose desktop package disagrees fails instead of releasing', () => {
  assert.throws(
    () => planRelease(branchPush({ desktopVersion: '1.33.0' })),
    /Desktop package version 1\.33\.0 does not match tag v1\.34\.0/u,
  );
});

test('a non-minor version bump is rejected by the existing tag rules', () => {
  assert.throws(() => planRelease(branchPush({ rootVersion: '1.34.1', desktopVersion: '1.34.1' })), /1\.34\.1/u);
});

test('a tag push releases that tag without creating one', () => {
  const plan = planRelease({ eventName: 'push', refName: 'v1.34.0', headSha: 'abc123' });
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.tag, 'v1.34.0');
  assert.equal(plan.ref, 'v1.34.0');
  assert.equal(plan.createTag, false);
});

test('a manual dispatch releases the tag it names', () => {
  const plan = planRelease({ eventName: 'workflow_dispatch', inputTag: 'v1.33.0', refName: 'main' });
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.tag, 'v1.33.0');
  assert.equal(plan.ref, 'v1.33.0');
  assert.equal(plan.createTag, false);
});

test('a manual dispatch without a tag fails rather than guessing', () => {
  assert.throws(() => planRelease({ eventName: 'workflow_dispatch', refName: 'main' }), /must name an existing tag/u);
});

test('an unknown previous version still releases a new tag', () => {
  // A first push to a fresh clone or a force-pushed history: the tag check is
  // the authority, and it says this version has never been published.
  const plan = planRelease(branchPush({ previousVersion: undefined }));
  assert.equal(plan.shouldRelease, true);
  assert.equal(plan.createTag, true);
});
