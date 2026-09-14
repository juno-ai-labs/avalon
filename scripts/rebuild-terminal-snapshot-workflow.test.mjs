import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = join(repositoryDirectory, '.github/workflows/rebuild-terminal-snapshot.yml');

async function readWorkflow() {
  return readFile(workflowPath, 'utf8');
}

// Every `run:` block scalar in the file, with its YAML indentation stripped.
function runBlocks(workflow) {
  const blocks = [];
  const pattern = /^( *)run: \|\n((?:(?:\1 .*|)\n)*)/gmu;
  for (const match of workflow.matchAll(pattern)) {
    blocks.push(match[2]);
  }
  assert.ok(blocks.length > 0, 'the workflow must have at least one run block');
  return blocks;
}

test('no dispatch input or other expression is interpolated into a run block', async () => {
  // `${{ inputs.snapshot_name }}` inside `run:` is textually substituted before
  // the shell sees it, which makes the input shell-injectable in a job that
  // holds the Daytona key. Inputs reach the script only through `env:`.
  const workflow = await readWorkflow();
  for (const block of runBlocks(workflow)) {
    assert.doesNotMatch(block, /\$\{\{/u, 'run blocks must read expressions from env, not interpolate them');
  }
  assert.match(workflow, /^ {10}REQUESTED_NAME: \$\{\{ inputs\.snapshot_name \}\}$/mu);
});

test('the snapshot name is validated before it names anything', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /grep -Eq '\^\[a-z0-9\]\[a-z0-9\._-\]\{0,62\}\$'/u);
});

test('the adoption pull request can run CI and commits only the configured regional config', async () => {
  const workflow = await readWorkflow();
  // A PR opened with GITHUB_TOKEN starts no workflows; the fallback is explicit
  // so a missing token degrades to a warning in the step summary, not silence.
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.TERMINAL_SNAPSHOT_PR_TOKEN \|\| secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(workflow, /git add apps\/api\/wrangler\.global\.jsonc\n\s+git commit -qm/u);
  assert.doesNotMatch(workflow, /git commit -a/u);
});
