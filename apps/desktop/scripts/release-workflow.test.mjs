import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowPath = join(repositoryDirectory, '.github/workflows/release-desktop-macos.yml');

test('a new release supersedes pending ones without cancelling a running one', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const concurrency = workflow.match(/^ {4}concurrency:\n(?<body>(?:^(?: {6}|$).*\n)+)/mu)?.groups?.body;

  assert.ok(concurrency, 'Release workflow must define job-level concurrency');
  assert.match(concurrency, /^ {6}group: desktop-macos-release$/mu);
  assert.match(concurrency, /^ {6}cancel-in-progress: false$/mu);
  // Newest pending wins, so intermediate versions are dropped rather than
  // queued; cancel-in-progress stays false so a running release survives.
  assert.match(concurrency, /^ {6}queue: single$/mu);
  assert.doesNotMatch(concurrency, /github\.|inputs\.|ref_name/u);
});

test('the planner stays outside the release queue', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const planJob = workflow.slice(workflow.indexOf('\n  plan:'), workflow.indexOf('\n  release:'));

  // At workflow level the group would also cover the planner, so a push that
  // plans a skip would occupy the single pending slot and could displace a
  // queued release that had work to do.
  assert.doesNotMatch(workflow, /^concurrency:$/mu, 'Concurrency must not be workflow-level');
  assert.doesNotMatch(planJob, /concurrency:/u, 'The planning job must not join the release queue');
});

test('the site deployment never shares the release queue', async () => {
  const siteWorkflow = await readFile(join(repositoryDirectory, '.github/workflows/deploy-site.yml'), 'utf8');

  // Sharing the release group would let a queued site deployment satisfy
  // `queue: single` by cancelling a pending release.
  assert.match(siteWorkflow, /^ {2}group: deploy-site$/mu);
  assert.doesNotMatch(siteWorkflow, /group: desktop-macos-release/u);
});

test('the macOS runner is only claimed once the plan job has approved a release', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /^ {2}release:\n {4}needs: plan\n {4}if: needs\.plan\.outputs\.should_release == 'true'$/mu);
});

test('the app is health-gated against the regional APIs before it is distributed', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const healthGate = workflow.indexOf('scripts/check-regional-health.mjs');
  const published = workflow.indexOf('- name: Publish immutable payloads and promote the release manifest');

  // Ordering between the API and desktop workflows is not coordinated between
  // runners. This gate, not a wait, is what keeps a release from shipping
  // against unhealthy regions.
  assert.notEqual(healthGate, -1, 'Release workflow must check regional health');
  assert.ok(healthGate < published, 'Regional health must be checked before anything is published');
});

test('tag pushes are never filtered by path', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const trigger = workflow.match(/^on:\n(?<body>(?:^(?: {2}|$).*\n)+)/mu)?.groups?.body;

  // GitHub leaves it undefined whether a paths filter also applies to tag
  // pushes, so a manual `v*` tag must not depend on that behavior.
  assert.ok(trigger, 'Release workflow must define triggers');
  assert.doesNotMatch(trigger, /^\s*paths:/mu);
});

test('the release tag is pushed after publication and before anything that can still fail', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const stepIndex = (name) => workflow.indexOf(`- name: ${name}`);

  const createdLocally = stepIndex('Create the release tag locally');
  const published = stepIndex('Publish immutable payloads and promote the release manifest');
  const pushedTag = stepIndex('Publish the release tag');
  const recordedConfig = stepIndex('Record the published release config on the default branch');
  const site = stepIndex('Deploy the landing site with the verified release');

  for (const [name, index] of Object.entries({ createdLocally, published, pushedTag, recordedConfig, site })) {
    assert.notEqual(index, -1, `Release workflow must keep the ${name} step`);
  }
  // Every tag released by hand is annotated; automation must not start mixing
  // in lightweight ones.
  assert.match(workflow, /tag -a "\$RELEASE_TAG"/u);
  // A release that fails before publication must leave no tag, so the version
  // can be retried.
  assert.ok(createdLocally < published, 'The local tag must exist before the release guards run');
  assert.ok(published < pushedTag, 'The tag must not be pushed before the payloads are published');
  // Once the channel is promoted the release is live to updaters, and an
  // untagged live release can be neither re-run nor dispatched. So everything
  // that can still fail happens after the tag exists.
  assert.ok(pushedTag < recordedConfig, 'The tag must be pushed before the release config is recorded');
  assert.ok(pushedTag < site, 'The tag must be pushed before the site deploy, which can fail on its own');
});

test('the release records its site config back on the default branch', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const recordStep = workflow.slice(workflow.indexOf('- name: Record the published release config'));

  // publish-r2-release.mjs reads the committed config through
  // assertNextReleaseVersion, so leaving main stale breaks the next release,
  // and plan-release.mjs reads the commit it names as its watermark.
  assert.match(recordStep, /git push origin HEAD:main/u);
  assert.match(recordStep, /apps\/site\/release\.config\.json/u);
  // A dispatch replaying an older tag must not move the record backwards.
  assert.match(recordStep, /leaving it alone/u);
});

test('the pipeline bumps the version itself, before the commit it tags', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const stepIndex = (name) => workflow.indexOf(`- name: ${name}`);

  const bumped = stepIndex('Bump the workspace version and record it on the default branch');
  const resolved = stepIndex('Resolve the release commit');
  const createdLocally = stepIndex('Create the release tag locally');
  const guarded = stepIndex('Guard tag, commit, and package versions');

  assert.notEqual(bumped, -1, 'The release must stamp the planned version onto the manifests');
  // The bump has to be in the tree before the tag is cut and before
  // validate-release-tag.mjs compares the manifests against it, or every
  // release would fail its own guard.
  assert.ok(bumped < createdLocally, 'The version must be bumped before the tag is created');
  assert.ok(createdLocally < guarded, 'The tag must exist before the guard checks it');
  // The recorded watermark must name the bumped commit, not the one that
  // triggered the run.
  assert.ok(bumped < resolved, 'The release commit must be resolved after the bump');
  assert.match(workflow.slice(resolved), /AVALON_RELEASE_COMMIT=\$\(git rev-parse HEAD\)/u);
});

test('the bump is skipped on a dispatch, which replays an already-tagged version', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const bumpStep = workflow.slice(
    workflow.indexOf('- name: Bump the workspace version'),
    workflow.indexOf('- name: Resolve the release commit'),
  );

  // A replayed tag already carries its own version; re-bumping would move the
  // manifests off the tag and fail the guard.
  assert.match(bumpStep, /^ {8}if: needs\.plan\.outputs\.create_tag == 'true'$/mu);
  // main can move between the plan and the bump; the newer tip carries strictly
  // more work, so the release follows it rather than failing.
  assert.match(bumpStep, /git reset --hard origin\/main/u);
  assert.match(bumpStep, /retrying/u);
});

test('the release job can write the tag it publishes', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const releaseJob = workflow.slice(workflow.indexOf('\n  release:'));

  assert.match(releaseJob, /^ {4}permissions:\n {6}contents: write$/mu);
});
