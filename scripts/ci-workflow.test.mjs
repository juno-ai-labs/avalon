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
  const match = workflow.match(new RegExp(
    `^ {10}- name: ${escapedLane}\\n {12}command: (?:>-\\n(?<folded>(?:^ {14}.+\\n?)+)|(?<inline>.+))`,
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

test('CI distributes the expensive verification work across independent lanes', async () => {
  const workflow = await readWorkflow();

  assert.equal(matrixCommand(workflow, 'lint'), 'pnpm lint');
  assert.equal(
    matrixCommand(workflow, 'typecheck-and-build-invariants'),
    'pnpm typecheck && pnpm --filter @avalon/api build && '
      + 'pnpm --filter @avalon/api build:eu && pnpm --filter @avalon/desktop test:release',
  );
  assert.equal(
    matrixCommand(workflow, 'remaining-tests'),
    "pnpm --filter '!@avalon/desktop' --filter '!@avalon/api' --recursive --if-present test && "
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
    matrixCommand(workflow, 'desktop-tests-1-of-2'),
    `pnpm --filter @avalon/desktop exec ${desktopScripts.test} --shard=1/2`,
  );
  assert.equal(
    matrixCommand(workflow, 'desktop-tests-2-of-2'),
    `pnpm --filter @avalon/desktop exec ${desktopScripts.test} --shard=2/2`,
  );
  assert.equal(
    matrixCommand(workflow, 'api-tests-1-of-2'),
    `pnpm --filter @avalon/api exec ${apiTestCommands[0]} --shard=1/2`,
  );
  assert.equal(
    matrixCommand(workflow, 'api-tests-2-of-2'),
    `pnpm --filter @avalon/api exec ${apiTestCommands[0]} --shard=2/2 && `
      + 'pnpm --filter @avalon/api test:workers',
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

  for (const command of [
    'pnpm lint',
    'pnpm typecheck',
    'pnpm --filter @avalon/api build',
    'pnpm --filter @avalon/api build:eu',
    'pnpm --filter @avalon/desktop test:release',
    'pnpm test:scripts',
    'pnpm --filter @avalon/api test:workers',
  ]) {
    assert.ok(workflow.includes(command), `CI must retain ${command}`);
  }
});
