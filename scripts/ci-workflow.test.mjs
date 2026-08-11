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

test('CI distributes the expensive verification work across independent lanes', async () => {
  const workflow = await readWorkflow();

  for (const lane of [
    'lint',
    'typecheck-and-build-invariants',
    'desktop-tests-1-of-2',
    'desktop-tests-2-of-2',
    'api-tests-1-of-2',
    'api-tests-2-of-2',
    'remaining-tests',
  ]) {
    assert.match(workflow, new RegExp(`^ {10}- name: ${lane}$`, 'mu'));
  }

  for (const command of [
    'pnpm --filter @avalon/desktop exec vitest run --shard=1/2',
    'pnpm --filter @avalon/desktop exec vitest run --shard=2/2',
    'pnpm --filter @avalon/api exec vitest run --shard=1/2',
    'pnpm --filter @avalon/api exec vitest run --shard=2/2',
    "pnpm --filter '!@avalon/desktop' --filter '!@avalon/api' --recursive --if-present test",
  ]) {
    assert.ok(workflow.includes(command), `CI must retain ${command}`);
  }

  assert.match(workflow, /^ {6}fail-fast: false$/mu);
});

test('CI retains one terminal verify check for branch protection', async () => {
  const workflow = await readWorkflow();
  const verifyJob = workflow.slice(workflow.indexOf('\n  verify:'));

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
    'vitest run --config vitest.workers.config.ts',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});
