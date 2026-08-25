import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowPath = join(repositoryDirectory, '.github/workflows/release-desktop-macos.yml');

test('a new release supersedes pending ones without cancelling a running one', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const concurrency = workflow.match(/^concurrency:\n(?<body>(?:^(?: {2}|$).*\n)+)/mu)?.groups?.body;

  assert.ok(concurrency, 'Release workflow must define workflow-level concurrency');
  assert.match(concurrency, /^ {2}group: desktop-macos-release$/mu);
  assert.match(concurrency, /^ {2}cancel-in-progress: false$/mu);
  // Newest pending wins, so intermediate versions are dropped rather than
  // queued; cancel-in-progress stays false so a running release survives.
  assert.match(concurrency, /^ {2}queue: single$/mu);
  assert.doesNotMatch(concurrency, /github\.|inputs\.|ref_name/u);
});

test('the plan is made inside the release queue, not before it', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const jobs = workflow.slice(workflow.indexOf('\njobs:'));

  // A plan made while another release is in flight reads a release record that
  // run has not finished writing. It would pick a version that release is about
  // to take, and could not tell a genuine resume of a failed release from a
  // version that had just shipped — which is exactly what the bump step's
  // short-circuit relies on being able to distinguish.
  assert.match(workflow, /^concurrency:$/mu, 'Concurrency must cover the planning job');
  assert.doesNotMatch(jobs, /^ {4}concurrency:$/mu, 'No job may hold a narrower release queue');
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

test('a real packaged Crashpad fixture gates every desktop release', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const fixture = workflow.indexOf('pnpm --filter @rally/desktop test:crashpad');
  const signingIdentity = workflow.indexOf('- name: Import the Developer ID identity');
  const packagedRelease = workflow.indexOf('- name: Build, sign, notarize, staple, and verify');

  assert.notEqual(fixture, -1, 'Release workflow must run the packaged Crashpad fixture');
  assert.ok(fixture < signingIdentity, 'The unsigned fixture must not receive release signing credentials');
  assert.ok(fixture < packagedRelease, 'A failed Crashpad fixture must stop the release build');
});

test('the packaged Crashpad fixture owns its clean-runner bundler dependency', async () => {
  const packageJson = JSON.parse(await readFile(
    join(repositoryDirectory, 'apps/desktop/package.json'),
    'utf8',
  ));
  const fixture = await readFile(
    join(repositoryDirectory, 'apps/desktop/scripts/telemetry-crashpad-fixture.mjs'),
    'utf8',
  );

  assert.equal(
    packageJson.devDependencies.esbuild,
    '0.25.12',
    'The desktop package must own the exact release esbuild version',
  );
  assert.match(
    fixture,
    /await run\('pnpm',\s*\[\s*'--filter',\s*'@rally\/desktop',\s*'exec',\s*'esbuild',/u,
    'The fixture must resolve esbuild from the desktop package',
  );
  assert.match(
    fixture,
    /if \(\(await stat\(bundledControllerPath\)\)\.size === 0\) throw new Error/u,
    'A missing pnpm filter match must fail immediately instead of packaging without a controller',
  );
});

test('private telemetry artifacts are published to both isolated regional telemetry buckets but excluded from the app', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const builder = await readFile(join(repositoryDirectory, 'apps/desktop/electron-builder.yml'), 'utf8');
  const built = workflow.indexOf('- name: Build, sign, notarize, staple, and verify');
  const symbols = workflow.indexOf('- name: Publish private regional telemetry artifacts');
  const distributed = workflow.indexOf('- name: Publish immutable payloads and promote the release manifest');

  assert.match(builder, /- "!out\/\*\*\/\*\.map"/u);
  assert.match(workflow, /RALLY_GLOBAL_TELEMETRY_R2_BUCKET:/u);
  assert.match(workflow, /RALLY_EU_TELEMETRY_R2_BUCKET:/u);
  assert.doesNotMatch(workflow, /RALLY_(?:GLOBAL|EU)_PAYLOADS_R2_BUCKET:/u);
  assert.match(workflow, /cargo install dump_syms --version 2\.3\.7 --locked/u);
  assert.match(workflow, /pnpm --filter @rally\/desktop telemetry:publish-artifacts/u);
  assert.ok(built < symbols, 'symbols must be extracted from the exact packaged application');
  assert.ok(symbols < distributed, 'a release must not distribute before both regional artifacts exist');
});

// The `paths:` filter is the release trigger, so it is also the only place the
// "what ships in the app" decision is written down. These tests are what stops
// it drifting: a wrong entry here is invisible until a merge silently fails to
// release, which is exactly the outage this pipeline was rebuilt to prevent.
async function triggerPaths() {
  const workflow = await readFile(workflowPath, 'utf8');
  const block = workflow.match(/^ {4}paths:\n(?<body>(?:^ {6}- .*\n)+)/mu)?.groups?.body;
  assert.ok(block, 'Release workflow must filter pushes by path');
  return block.split('\n').filter(Boolean).map((line) => line.replace(/^ {6}- /u, '').replace(/^'|'$/gu, ''));
}

// GitHub path filters are globs; these are the only two shapes the list uses.
function matchesFilter(patterns, path) {
  return patterns.some((pattern) => (pattern.endsWith('/**')
    ? path.startsWith(pattern.slice(0, -2))
    : path === pattern));
}

test('the release trigger covers everything the installed app is built from', async () => {
  const patterns = await triggerPaths();

  for (const path of [
    'apps/desktop/src/main/index.ts',
    'apps/desktop/package.json',
    'apps/desktop/electron-builder.yml',
    'apps/desktop/resources/icon.icns',
    'packages/contracts/src/index.ts',
    'packages/agent-harness/src/index.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    '.github/workflows/release-desktop-macos.yml',
  ]) {
    assert.equal(matchesFilter(patterns, path), true, `${path} ships in the desktop app and must release`);
  }
});

test('the release trigger excludes what a user could never install', async () => {
  const patterns = await triggerPaths();

  for (const path of [
    'docs/runbook.md',
    'README.md',
    'apps/api/src/index.ts',
    'apps/site/src/pages/index.astro',
    'apps/release-retention/src/index.ts',
    'scripts/check-regional-health.mjs',
    'assets/brand/logo.svg',
    'config/provider-apps/github.json',
    'eslint.config.mjs',
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-api.yml',
  ]) {
    assert.equal(matchesFilter(patterns, path), false, `${path} must not spend a 90-minute signed build`);
  }
});

test("the release's own recorded config cannot re-trigger the release", async () => {
  const patterns = await triggerPaths();

  // The last thing a release does is commit apps/site/release.config.json back
  // to main. If the trigger matched it, every release would queue another one.
  assert.equal(matchesFilter(patterns, 'apps/site/release.config.json'), false);
});

test('a glob never matches a sibling directory that merely shares its prefix', async () => {
  const patterns = await triggerPaths();

  assert.equal(matchesFilter(patterns, 'apps/desktop-notes/README.md'), false);
  assert.equal(matchesFilter(patterns, 'packages-archive/old/index.ts'), false);
});

test('a tag push cannot reach the release, filter or no filter', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const trigger = workflow.match(/^on:\n(?<body>(?:^(?: {2}|$).*\n)+)/mu)?.groups?.body;

  // GitHub leaves it undefined whether a paths filter also applies to tag
  // pushes. It cannot matter here: the push trigger is branch-scoped, so a
  // `v*` tag matches nothing regardless of how the filter is evaluated.
  assert.ok(trigger, 'Release workflow must define triggers');
  assert.match(trigger, /^ {2}push:\n {4}branches:\n {6}- main$/mu);
  assert.doesNotMatch(trigger, /^\s*tags:/mu);
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
  assert.match(recordStep, /git -C "\$sync" push origin HEAD:main/u);
  assert.match(recordStep, /apps\/site\/release\.config\.json/u);
  // A dispatch replaying an older tag must not move the record backwards.
  assert.match(recordStep, /leaving it alone/u);
});

test('the release-config retry never runs from the disposable sync worktree', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const recordStep = workflow.slice(
    workflow.indexOf('- name: Record the published release config'),
    workflow.indexOf('- name: Deploy the landing site with the verified release'),
  );

  // A rejected push removes and recreates this worktree on the next attempt.
  // Keeping the shell inside it makes that retry fail before it can refetch.
  assert.doesNotMatch(recordStep, /cd "\$sync"/u);
  assert.match(recordStep, /git -C "\$sync" push origin HEAD:main/u);
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
  assert.match(workflow.slice(resolved), /RALLY_RELEASE_COMMIT=\$\(git rev-parse HEAD\)/u);
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

test('a no-op bump is treated as resuming a release, never as one already shipped', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const bumpStep = workflow.slice(
    workflow.indexOf('- name: Bump the workspace version'),
    workflow.indexOf('- name: Resolve the release commit'),
  );

  // Sitting inside the queue is not on its own enough to make this branch
  // unambiguous, and assuming it was is what broke v1.48.0 and v1.49.0: the
  // plan job checks out the commit that triggered the run, which predates the
  // record the release ahead of it pushes on its way out, so the planner cut a
  // version that had already shipped and the run died at `git tag` with nothing
  // but `already exists` to explain itself. The plan is now made from main's
  // tip, and this branch no longer takes the queue's word for it: the pushed
  // tag says whether those bytes are live.
  assert.match(bumpStep, /git diff --quiet/u);
  assert.match(bumpStep, /resuming a release that did not publish it/u);
  assert.match(bumpStep, /git ls-remote --tags origin/u);
  assert.match(bumpStep, /Refusing to release it a second time/u);
});

test('the plan is made from the tip, not from the commit that triggered the run', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const planJob = workflow.slice(workflow.indexOf('\n  plan:'), workflow.indexOf('\n  release:'));

  // A run that waited in the queue was triggered long before it got the slot.
  // Planning from that stale checkout re-cuts a shipped version; planning from
  // the tip reads the record the release ahead of it just wrote, and matches
  // the commit the release job goes on to build.
  assert.match(planJob, /git fetch --no-tags origin main/u);
  assert.ok(
    planJob.indexOf('git fetch --no-tags origin main') < planJob.indexOf('plan-release.mjs'),
    'The tip must be fetched before the plan reads it',
  );
});

test('the release job can write the tag it publishes', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const releaseJob = workflow.slice(workflow.indexOf('\n  release:'));

  assert.match(releaseJob, /^ {4}permissions:\n {6}contents: write$/mu);
});
