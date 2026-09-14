import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  desktopContractSourceClosure,
  desktopReleaseInputPaths,
  FIXED_DESKTOP_RELEASE_INPUTS,
  resolveContractPackageImport,
  resolveContractSpecifier,
} from './desktop-release-inputs.mjs';

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

test('the macOS runner is only claimed after the frozen release commit passes Ubuntu verification', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const verifyJob = workflow.slice(workflow.indexOf('\n  verify:'), workflow.indexOf('\n  release:'));
  const releaseJob = workflow.slice(workflow.indexOf('\n  release:'));

  assert.match(verifyJob, /^ {4}needs: plan$/mu);
  assert.match(verifyJob, /^ {4}if: needs\.plan\.outputs\.should_release == 'true'$/mu);
  assert.match(verifyJob, /^ {4}runs-on: ubuntu-latest$/mu);
  assert.match(verifyJob, /^ {4}timeout-minutes: 60$/mu);
  assert.match(verifyJob, /^ {8}run: pnpm --filter @rally\/desktop test$/mu);
  assert.doesNotMatch(verifyJob, /^ {8}run: pnpm test$/mu);
  assert.match(releaseJob, /^ {4}needs: \[plan, verify\]$/mu);
  assert.match(releaseJob, /^ {4}runs-on: macos-26$/mu);
  assert.match(releaseJob, /ref: \$\{\{ needs\.verify\.outputs\.release_commit \}\}/u);

  for (const step of ['Lint', 'Typecheck', 'Test', 'Run release invariants']) {
    assert.match(verifyJob, new RegExp(`- name: ${step}`, 'u'), `${step} must run on Ubuntu`);
    assert.doesNotMatch(releaseJob, new RegExp(`- name: ${step}`, 'u'), `${step} must not spend macOS time`);
  }
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

test('the packaged Crashpad fixture cannot expire before its upload assertion', async () => {
  const fixture = await readFile(
    join(repositoryDirectory, 'apps/desktop/scripts/telemetry-crashpad-fixture.mjs'),
    'utf8',
  );

  assert.match(
    fixture,
    /const firstLaunchAt = new Date\(\);/u,
    'The fixture must compute its first launch from a live clock',
  );
  assert.match(
    fixture,
    /const secondLaunchAt = new Date\(firstLaunchAt\.getTime\(\)[ \t]*\+[ \t]*60_000\);/u,
    'The fixture must keep its second launch one minute after the first',
  );
  assert.match(
    fixture,
    /`--fixture-now=\$\{firstLaunchAt\.toISOString\(\)\}`/u,
    'The first launch argument must use the run-relative timestamp',
  );
  assert.match(
    fixture,
    /`--fixture-now=\$\{secondLaunchAt\.toISOString\(\)\}`/u,
    'The second launch argument must use the run-relative timestamp',
  );
  assert.doesNotMatch(
    fixture,
    /^[ \t]*['"`]--fixture-now=\d{4}-\d{2}-\d{2}T/mu,
    'A fixed launch date eventually crosses the production 14-day deletion deadline',
  );
});

test('private telemetry artifacts are published to the configured telemetry bucket but excluded from the app', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const builder = await readFile(join(repositoryDirectory, 'apps/desktop/electron-builder.yml'), 'utf8');
  const built = workflow.indexOf('- name: Build, sign, notarize, staple, and verify');
  const symbols = workflow.indexOf('- name: Publish private regional telemetry artifacts');
  const distributed = workflow.indexOf('- name: Publish immutable payloads and promote the release manifest');

  assert.match(builder, /- "!out\/\*\*\/\*\.map"/u);
  assert.match(workflow, /RALLY_GLOBAL_TELEMETRY_R2_BUCKET:/u);
  assert.doesNotMatch(workflow, /RALLY_GLOBAL_PAYLOADS_R2_BUCKET:/u);
  assert.match(workflow, /cargo install dump_syms --version 2\.3\.7 --locked/u);
  assert.match(workflow, /pnpm --filter @rally\/desktop telemetry:publish-artifacts/u);
  assert.ok(built < symbols, 'symbols must be extracted from the exact packaged application');
  assert.ok(symbols < distributed, 'a release must not distribute before both regional artifacts exist');
});

// The `paths:` filter admits work to the cheap planner. Contract source is broad
// on purpose; the planner derives which modules can reach the installed app.
// These tests keep the static admission filter and dynamic classifier aligned.
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

async function filesBelow(directory, ignoredDirectories = new Set()) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await filesBelow(path, ignoredDirectories));
      continue;
    }
    files.push(path);
  }
  return files;
}

async function staticModuleSpecifiers(path) {
  const source = await readFile(path, 'utf8');
  const syntax = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/u.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, syntax);
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return specifiers;
}

async function typescriptDesktopContractSourceClosure() {
  const desktopDirectory = join(repositoryDirectory, 'apps/desktop');
  const contractDirectory = join(repositoryDirectory, 'packages/contracts');
  const packageJson = JSON.parse(await readFile(join(contractDirectory, 'package.json'), 'utf8'));
  const entryPoints = new Set();

  for (const path of await filesBelow(
    desktopDirectory,
    new Set(['coverage', 'dist', 'node_modules', 'out']),
  )) {
    if (!/\.[cm]?[jt]sx?$/u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) continue;
    for (const specifier of await staticModuleSpecifiers(path)) {
      const entryPoint = resolveContractPackageImport(packageJson, specifier);
      if (entryPoint) entryPoints.add(entryPoint);
    }
  }

  const closure = new Set();
  const pending = [...entryPoints];
  while (pending.length > 0) {
    const path = pending.pop();
    if (closure.has(path)) continue;
    closure.add(path);
    for (const specifier of await staticModuleSpecifiers(path)) {
      const imported = await resolveContractSpecifier(path, specifier, packageJson);
      if (!imported) continue;
      if (!closure.has(imported)) pending.push(imported);
    }
  }

  return [...closure]
    .map((path) => relative(repositoryDirectory, path).replaceAll('\\', '/'))
    .sort();
}

test('the release trigger covers everything the installed app is built from', async () => {
  const patterns = await triggerPaths();

  for (const path of [
    'apps/desktop/src/main/index.ts',
    'apps/desktop/package.json',
    'apps/desktop/electron-builder.yml',
    'apps/desktop/resources/icon.icns',
    'packages/contracts/package.json',
    'packages/contracts/src/index.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    '.github/workflows/release-desktop-macos.yml',
  ]) {
    assert.equal(matchesFilter(patterns, path), true, `${path} ships in the desktop app and must release`);
  }

  assert.deepEqual(
    patterns.sort(),
    [
      ...FIXED_DESKTOP_RELEASE_INPUTS.filter((path) => path !== 'packages/contracts/package.json'),
      'packages/contracts/**',
    ].sort(),
    'The broad trigger must admit every contract change to the Ubuntu classifier and nothing else',
  );
});

async function workspacePackages() {
  const workspace = await readFile(join(repositoryDirectory, 'pnpm-workspace.yaml'), 'utf8');
  const packagePatterns = workspace
    .match(/^packages:\n(?<body>(?: {2}- .*\n)+)/mu)?.groups?.body
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^ {2}- /u, '').replace(/^['"]|['"]$/gu, ''));
  assert.ok(packagePatterns, 'pnpm-workspace.yaml must declare package directories');

  const packages = [];
  for (const pattern of packagePatterns) {
    assert.match(pattern, /\/\*$/u, `Release invariant does not understand workspace pattern ${pattern}`);
    const parent = pattern.slice(0, -2);
    for (const entry of await readdir(join(repositoryDirectory, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${parent}/${entry.name}`;
      try {
        const manifest = JSON.parse(await readFile(join(repositoryDirectory, directory, 'package.json'), 'utf8'));
        packages.push({ directory, manifest });
      } catch { /* A workspace glob may contain a directory that is not a package. */ }
    }
  }
  return packages;
}

test('every desktop workspace dependency reaches both the workflow and planner', async () => {
  const patterns = await triggerPaths();
  const packages = await workspacePackages();
  const packageByName = new Map(packages.map(({ directory, manifest }) => [manifest.name, directory]));
  const desktop = packages.find(({ manifest }) => manifest.name === '@rally/desktop')?.manifest;
  assert.ok(desktop, 'The desktop package must belong to the pnpm workspace');
  const dependencies = { ...desktop.dependencies, ...desktop.devDependencies };

  for (const [name, version] of Object.entries(dependencies)) {
    if (!version.startsWith('workspace:')) continue;
    const directory = packageByName.get(name);
    assert.ok(directory, `${name} must resolve to a package declared by pnpm-workspace.yaml`);
    const manifestPath = `${directory}/package.json`;
    assert.equal(matchesFilter(patterns, manifestPath), true, `${name} changes must reach Ubuntu planning`);
    assert.deepEqual(
      await desktopReleaseInputPaths([manifestPath]),
      [manifestPath],
      `${name} changes must remain release inputs after Ubuntu classification`,
    );
  }
});

test('the dependency-free planner scan equals the TypeScript contract import graph', async () => {
  const contractSources = await desktopContractSourceClosure();
  assert.deepEqual(
    contractSources,
    await typescriptDesktopContractSourceClosure(),
    'Import syntax the planner cannot recognize must fail CI instead of silently missing a desktop dependency',
  );
  const mixedChanges = [
    contractSources[0],
    'packages/contracts/src/text.ts',
    'packages/contracts/src/index.test.ts',
    'docs/runbook.md',
  ];
  assert.deepEqual(await desktopReleaseInputPaths(mixedChanges), [contractSources[0]]);
});

test('the Ubuntu planner excludes what a user could never install', async () => {
  const patterns = await triggerPaths();
  const unrelated = [
    'docs/runbook.md',
    'README.md',
    'apps/api/src/index.ts',
    'apps/site/src/pages/index.astro',
    'apps/release-retention/src/index.ts',
    'packages/agent-harness/src/index.ts',
    'packages/connectors/src/index.ts',
    'packages/contracts/src/durable-object-migrations.ts',
    'packages/contracts/src/engineering-inspection.ts',
    'packages/contracts/src/index.test.ts',
    'packages/contracts/src/text.ts',
    'packages/db/src/index.ts',
    'scripts/check-regional-health.mjs',
    'assets/brand/logo.svg',
    'config/provider-apps/github.json',
    'eslint.config.mjs',
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-api.yml',
  ];
  const admitted = await desktopReleaseInputPaths(unrelated);

  assert.deepEqual(admitted, [], 'Unrelated paths must not reach the macOS job');
  for (const path of unrelated) {
    const shouldReachUbuntu = path.startsWith('packages/contracts/');
    assert.equal(
      matchesFilter(patterns, path),
      shouldReachUbuntu,
      `${path} must ${shouldReachUbuntu ? '' : 'not '}start the cheap planner`,
    );
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
  const site = stepIndex('Deploy the landing site from the tip of main');

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
  // The site builds from main's tip, so the tip has to carry the freshly
  // recorded config by then, or the deployed site advertises the previous
  // version.
  assert.ok(recordedConfig < site, 'The release config must be recorded on main before the site builds from it');
});

test('the landing site deploys from the tip of main, never from the stale release checkout', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const keychainRemoved = workflow.indexOf('- name: Remove the temporary signing keychain');
  const siteStart = workflow.indexOf('- name: Deploy the landing site from the tip of main');
  assert.notEqual(keychainRemoved, -1, 'Release workflow must keep the keychain removal step');
  assert.notEqual(siteStart, -1, 'Release workflow must keep the site deploy step');
  // The step executes code from main's tip — commits this job never built —
  // so the signing identity must be gone before any of it runs.
  assert.ok(keychainRemoved < siteStart, 'The signing keychain must be removed before tip code runs');
  // Bounded at the next step so a step appended after this one is not
  // silently policed by the site step's own negative assertions.
  const nextStep = workflow.indexOf('\n      - name: ', siteStart);
  const siteStep = workflow.slice(siteStart, nextStep === -1 ? workflow.length : nextStep);
  assert.match(siteStep, /RALLY_TURNSTILE_SITE_KEY:\s*\$\{\{ vars\.RALLY_TURNSTILE_SITE_KEY \}\}/u,
    'The release site build needs the production Turnstile site key');

  // Each command is looked up as a complete run-block line — anchored by the
  // newline and the block's indent, so a comment quoting it cannot satisfy
  // the assertion — and captured as an index, so the order is pinned too.
  const line = (command) => {
    const index = siteStep.indexOf(`\n          ${command}\n`);
    assert.notEqual(index, -1, `The site step must run: ${command}`);
    return index;
  };

  // The job checked out the release commit before a build that takes up to
  // ninety minutes, so by deploy time that checkout can be older than a site
  // change deploy-site.yml has already shipped — on 2026-08-27 deploying it
  // reverted a live site fix. Every push-triggered deploy-site.yml run
  // deploys a commit on main (a manual dispatch on another branch sits
  // outside the guarantee), so a build from main's freshly fetched tip is
  // never older than one of those.
  const fetched = line('git fetch origin main');
  const added = line('git worktree add --detach "$site" origin/main');
  // Its own frozen install, filtered to the site's dependency closure so
  // Electron and the desktop toolchain stay out of the release's final step
  // (wrangler is a site dependency, so workerd and esbuild remain) — and
  // failing loudly when the filter stops matching, because an unmatched
  // pnpm filter exits 0 and a green run would deploy no site at all.
  const installed = line('pnpm -C "$site" install --frozen-lockfile --filter "@rally/site..." --fail-if-no-match');
  const typechecked = line('pnpm -C "$site" --filter @rally/site --fail-if-no-match typecheck');
  const tested = line('pnpm -C "$site" --filter @rally/site --fail-if-no-match test');
  // The same live-channel guard the standalone deployment runs, invoked from
  // the worktree so it reads the committed config it is about to deploy.
  const guarded = line('node "$site/scripts/check-site-release-config.mjs"');
  const deployed = line('pnpm -C "$site" --filter @rally/site --fail-if-no-match run deploy');

  // Presence is not enough: a deploy hoisted above the checks would pass a
  // pure-presence test and ship a site build nothing verified.
  assert.ok(fetched < added, 'The tip must be fetched before the worktree is created from it');
  assert.ok(added < installed, 'The worktree must exist before it is installed into');
  assert.ok(installed < typechecked, 'The install must precede the site typecheck');
  assert.ok(typechecked < deployed, 'The site must typecheck before it ships');
  assert.ok(tested < deployed, 'The site tests must pass before it ships');
  assert.ok(guarded < deployed, 'The live-channel guard must run before the publish');

  // The shell stays in the job workspace: every git and pnpm call addresses
  // the worktree explicitly, so the EXIT trap never removes its own cwd.
  assert.doesNotMatch(siteStep, /^ +cd\b/mu, 'The site step must not change directory');
  // Scanned per line rather than anchored on the first token, so an env-var
  // prefix or a command substitution cannot slip an invocation of the job
  // checkout past the assertion.
  for (const invocation of siteStep.split('\n')) {
    if (/^\s*#/u.test(invocation) || !/(^|[\s(`])pnpm\s/u.test(invocation)) continue;
    assert.match(invocation, /pnpm -C "\$site" /u,
      `Every pnpm invocation in the site step must address the worktree: ${invocation.trim()}`);
  }
});

test('nothing deploys the site from the release checkout', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  // The pre-2026-08-27 failure was a site deploy running from the job's own
  // working tree — the release commit, up to a build stale — which reverted
  // a live site fix. Any spelling of a site deploy that does not address the
  // tip worktree is that failure coming back, so this scans every
  // non-comment line naming a site deploy rather than pinning one exact
  // command form.
  for (const invocation of workflow.split('\n')) {
    if (/^\s*#/u.test(invocation)) continue;
    if (!(invocation.includes('pnpm') && invocation.includes('@rally/site') && invocation.includes('deploy'))) continue;
    assert.match(invocation, /-C "\$site"/u,
      `A site deploy must run from the tip worktree, never the release checkout: ${invocation.trim()}`);
  }
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
  const recordStart = workflow.indexOf('- name: Record the published release config');
  const recordEnd = workflow.indexOf('- name: Remove the temporary signing keychain');
  assert.notEqual(recordStart, -1, 'Release workflow must keep the record step');
  assert.notEqual(recordEnd, -1, 'Release workflow must keep the keychain removal step');
  assert.ok(recordStart < recordEnd, 'The keychain removal that bounds this slice must follow the record step');
  const recordStep = workflow.slice(recordStart, recordEnd);

  // A rejected push removes and recreates this worktree on the next attempt.
  // Keeping the shell inside it makes that retry fail before it can refetch.
  assert.doesNotMatch(recordStep, /cd "\$sync"/u);
  assert.match(recordStep, /git -C "\$sync" push origin HEAD:main/u);
});

test('the pipeline freezes and verifies the bumped commit before macOS tags it', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const stepIndex = (name) => workflow.indexOf(`- name: ${name}`);

  const bumped = stepIndex('Bump the workspace version and record it on the default branch');
  const resolved = stepIndex('Resolve the release commit');
  const createdLocally = stepIndex('Create the release tag locally');
  const guarded = stepIndex('Guard tag, commit, and package versions');
  const verified = stepIndex('Run release invariants');

  assert.notEqual(bumped, -1, 'The release must stamp the planned version onto the manifests');
  // The bump has to be in the tree before the tag is cut and before
  // validate-release-tag.mjs compares the manifests against it, or every
  // release would fail its own guard.
  assert.ok(bumped < resolved, 'The release commit must be resolved after the bump');
  assert.ok(resolved < verified, 'Portable verification must run against the frozen release commit');
  assert.ok(verified < createdLocally, 'The version must pass Ubuntu verification before macOS tags it');
  assert.ok(createdLocally < guarded, 'The tag must exist before the guard checks it');
  // The recorded watermark must name the bumped commit, not the one that
  // triggered the run.
  assert.match(workflow.slice(resolved), /sha=\$\(git rev-parse HEAD\).*GITHUB_OUTPUT/u);
  assert.match(workflow, /RALLY_RELEASE_COMMIT: \$\{\{ needs\.verify\.outputs\.release_commit \}\}/u);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.release_commit \}\}/u);
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
  // main can move between the plan and the bump; the verifier includes the
  // newest tip and then freezes it, so later commits wait for another run.
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
  const planJob = workflow.slice(workflow.indexOf('\n  plan:'), workflow.indexOf('\n  verify:'));

  // A run that waited in the queue was triggered long before it got the slot.
  // Planning from that stale checkout re-cuts a shipped version; planning from
  // the tip reads the record the release ahead of it just wrote, and matches
  // the commit the release job goes on to build.
  assert.match(planJob, /git fetch --no-tags origin main/u);
  assert.ok(
    planJob.indexOf('git fetch --no-tags origin main') < planJob.indexOf('plan-release.mjs'),
    'The tip must be fetched before the plan reads it',
  );
  assert.ok(
    planJob.indexOf('git checkout --detach origin/main') < planJob.indexOf('plan-release.mjs'),
    'The contract classifier must read the same main tip whose watermark diff it classifies',
  );
  assert.match(
    planJob,
    /- name: Check out the tip the plan is made from\n {8}if: github\.event_name == 'push'/u,
    'A tag replay must keep its dispatch checkout while a branch push moves to main tip',
  );
});

test('the release job can write the tag it publishes', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const releaseJob = workflow.slice(workflow.indexOf('\n  release:'));

  assert.match(releaseJob, /^ {4}permissions:\n {6}contents: write$/mu);
});

test('the Ubuntu verification job can write and freeze the version bump', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const verifyJob = workflow.slice(workflow.indexOf('\n  verify:'), workflow.indexOf('\n  release:'));

  assert.match(verifyJob, /^ {4}permissions:\n {6}contents: write$/mu);
  assert.match(verifyJob, /^ {4}outputs:\n {6}release_commit: \$\{\{ steps\.release_commit\.outputs\.sha \}\}$/mu);
  assert.match(verifyJob, /git push origin HEAD:main/u);
});
