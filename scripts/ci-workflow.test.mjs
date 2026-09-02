import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = join(repositoryDirectory, '.github/workflows/ci.yml');

async function readWorkflow() {
  return readFile(workflowPath, 'utf8');
}

function matrixCommand(workflow, lane) {
  const escapedLane = lane.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Sibling keys (currently `env:`) may sit between `name` and `command`.
  const match = workflow.match(new RegExp(
    `^ {10}- name: ${escapedLane}\\n`
      + `(?: {12}(?!command:)\\S.*\\n(?: {14}.+\\n)*)*`
      + ` {12}command: (?:>-\\n(?<folded>(?:^ {14}.+\\n?)+)|(?<inline>.+))`,
    'mu',
  ));

  assert.ok(match, `CI must define the ${lane} matrix lane`);
  return match.groups.inline ?? match.groups.folded
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .join(' ');
}

async function packageScripts(packageDirectory) {
  const source = await readFile(join(repositoryDirectory, packageDirectory, 'package.json'), 'utf8');
  return JSON.parse(source).scripts;
}

test('CI runs for pull requests only', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /^ {2}pull_request:$/mu);
  assert.doesNotMatch(workflow, /^ {2}push:$/mu);
});

test('CI distributes the expensive verification work across independent lanes', async () => {
  const workflow = await readWorkflow();

  assert.equal(matrixCommand(workflow, 'lint'), 'pnpm lint');
  assert.equal(
    matrixCommand(workflow, 'typecheck-and-build-invariants'),
    'pnpm typecheck && pnpm --filter @rally/api build && '
      + 'pnpm --filter @rally/api build:eu && pnpm --filter @rally/api build:telemetry && '
      + 'pnpm --filter @rally/api check:telemetry-startup-boundary && '
      + 'pnpm --filter @rally/api build:pricing && '
      // The artifact-serving Workers are dry-run built here rather than only in
      // the deploy workflow, unlike the documents and Terminal services: they
      // are the one public origin that executes model-authored code, so a bad
      // route, binding, or startup profile is worth catching on the pull
      // request instead of at release.
      + 'pnpm --filter @rally/api build:artifacts && '
      + 'pnpm --filter @rally/api build:artifacts:eu && '
      + 'pnpm --filter @rally/desktop test:release',
  );
  assert.equal(
    matrixCommand(workflow, 'remaining-tests'),
    "pnpm --filter '!@rally/desktop' --filter '!@rally/api' --recursive --if-present test && "
      + 'pnpm test:scripts',
  );

  assert.match(workflow, /^ {6}fail-fast: false$/mu);
});

test('CI shards the package-owned desktop and API test commands without drift', async () => {
  const [workflow, desktopScripts, apiScripts] = await Promise.all([
    readWorkflow(),
    packageScripts('apps/desktop'),
    packageScripts('apps/api'),
  ]);
  const apiTestCommands = apiScripts.test.split(' && ');

  assert.deepEqual(
    apiTestCommands,
    [apiTestCommands[0], apiScripts['test:workers']],
    'API test must remain one shardable command followed by the package-owned workers suite',
  );
  assert.equal(
    matrixCommand(workflow, 'desktop-tests-1-of-n'),
    `pnpm --filter @rally/desktop exec ${desktopScripts.test} --shard=1/2`,
  );
  assert.equal(
    matrixCommand(workflow, 'desktop-tests-2-of-n'),
    `pnpm --filter @rally/desktop exec ${desktopScripts.test} --shard=2/2`,
  );
  assert.equal(
    matrixCommand(workflow, 'api-tests-1-of-n'),
    `pnpm --filter @rally/api exec ${apiTestCommands[0]} --shard=1/3`,
  );
  assert.equal(
    matrixCommand(workflow, 'api-tests-2-of-n'),
    `pnpm --filter @rally/api exec ${apiTestCommands[0]} --shard=2/3`,
  );
  assert.equal(
    matrixCommand(workflow, 'api-tests-3-of-n'),
    `pnpm --filter @rally/api exec ${apiTestCommands[0]} --shard=3/3`,
  );
  assert.equal(
    matrixCommand(workflow, 'api-tests-workers-1-of-n'),
    `pnpm --filter @rally/api exec ${apiScripts['test:workers']} --shard=1/2`,
  );
  assert.equal(
    matrixCommand(workflow, 'api-tests-workers-2-of-n'),
    `pnpm --filter @rally/api exec ${apiScripts['test:workers']} --shard=2/2`,
  );
});

test('CI retains one terminal verify check for branch protection', async () => {
  const workflow = await readWorkflow();
  const start = workflow.indexOf('\n  verify:');
  const end = workflow.indexOf('\n  secrets:', start);

  assert.notEqual(start, -1, 'CI must define a terminal verify job');
  assert.notEqual(end, -1, 'CI must keep the secrets job after verify');
  const verifyJob = workflow.slice(start, end);

  assert.match(verifyJob, /^ {4}name: verify$/mu);
  assert.match(verifyJob, /^ {4}needs: checks$/mu);
  assert.match(verifyJob, /^ {4}if: \$\{\{ always\(\) \}\}$/mu);
  assert.match(verifyJob, /test "\$CHECKS_RESULT" = success/u);
});

test('CI still runs every repository quality gate', async () => {
  const workflow = await readWorkflow();
  const commands = [
    'lint',
    'typecheck-and-build-invariants',
    'desktop-tests-1-of-n',
    'desktop-tests-2-of-n',
    'api-tests-1-of-n',
    'api-tests-2-of-n',
    'api-tests-3-of-n',
    'api-tests-workers-1-of-n',
    'api-tests-workers-2-of-n',
    'remaining-tests',
  ].flatMap((lane) => matrixCommand(workflow, lane).split(' && '));

  for (const command of [
    'pnpm lint',
    'pnpm typecheck',
    'pnpm --filter @rally/api build',
    'pnpm --filter @rally/api build:eu',
    'pnpm --filter @rally/api build:telemetry',
    'pnpm --filter @rally/api check:telemetry-startup-boundary',
    'pnpm --filter @rally/api build:pricing',
    'pnpm --filter @rally/desktop test:release',
    'pnpm test:scripts',
  ]) {
    assert.ok(commands.includes(command), `CI must retain the exact command: ${command}`);
  }

  assert.equal(
    commands.filter((command) => command.includes('vitest.workers.config.ts')).length,
    2,
    'CI must retain the workers suite across two shards',
  );
});

test('CI retains the shared telemetry Worker startup profile', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /- name: Preserve Worker startup evidence/u);
  assert.match(workflow, /if: \$\{\{ always\(\) && matrix\.name == 'typecheck-and-build-invariants' \}\}/u);
  assert.match(workflow, /^ {10}name: telemetry-worker-startup-\$\{\{ github\.sha \}\}$/mu);
  assert.match(workflow, /^ {10}retention-days: 7$/mu);
  assert.match(workflow, /^ {10}path: apps\/api\/dist-telemetry\/startup\.cpuprofile$/mu);
});

// A lane's `env:` is inert until the run step names it. Actions gives a matrix
// key called `env` no meaning of its own — it is a variable like any other — so
// a ceiling declared only in the matrix entry never reaches the process, and
// nothing above would notice: every assertion here is about `command`. That is
// how `NODE_OPTIONS: --max-old-space-size=8192` sat on the lint and typecheck
// lanes without applying to either.
test('a lane env: reaches the process that runs its command', async () => {
  const workflow = await readWorkflow();
  const runStep = workflow.match(
    /^ {6}- name: Run \$\{\{ matrix\.name \}\}\n(?<body>(?:^ {8}.*\n)+)/mu,
  );

  assert.ok(runStep, 'CI must run each lane through one matrix-driven step');
  assert.match(
    runStep.groups.body,
    /^ {8}env:\n {10}NODE_OPTIONS: \$\{\{ matrix\.env\.NODE_OPTIONS \}\}$/mu,
    'the run step must name matrix.env.NODE_OPTIONS, or a lane env: does nothing',
  );

  const include = workflow.match(/^ {8}include:\n(?<body>(?:^ {10}.*\n)+)/mu);
  assert.ok(include, 'CI must define a matrix include block');

  // The forwarder above only matters while a lane still opts in. These two
  // carry the ceiling, and an entry losing its `env:` is what the whole defect
  // looked like: a number in the file that never reaches a process.
  for (const lane of ['lint', 'typecheck-and-build-invariants']) {
    assert.match(
      include.groups.body,
      new RegExp(`^ {10}- name: ${lane}\\n {12}env:\\n {14}NODE_OPTIONS: --max-old-space-size=\\d+$`, 'mu'),
      `the ${lane} lane must declare the NODE_OPTIONS the run step forwards`,
    );
  }

  for (const entry of include.groups.body.split(/^ {10}- /mu).slice(1)) {
    const declared = entry.match(/^ {12}env:\n(?<body>(?:^ {14}.+\n)+)/mu);
    if (!declared) continue;
    assert.deepEqual(
      declared.groups.body.trimEnd().split('\n').map((line) => line.trim().split(':')[0]),
      ['NODE_OPTIONS'],
      'the run step forwards NODE_OPTIONS only; another lane env: key would be inert',
    );
  }
});
