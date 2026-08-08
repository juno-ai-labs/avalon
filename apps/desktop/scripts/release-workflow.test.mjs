import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowPath = join(repositoryDirectory, '.github/workflows/release-desktop-macos.yml');

test('desktop releases share one non-canceling queue', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const concurrency = workflow.match(/^concurrency:\n(?<body>(?:^(?:  |$).*\n)+)/mu)?.groups?.body;

  assert.ok(concurrency, 'Release workflow must define workflow-level concurrency');
  assert.match(concurrency, /^  group: desktop-macos-release$/mu);
  assert.match(concurrency, /^  cancel-in-progress: false$/mu);
  assert.match(concurrency, /^  queue: max$/mu);
  assert.doesNotMatch(concurrency, /github\.|inputs\.|ref_name/u);
});
