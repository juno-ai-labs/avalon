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

test('adoption commits only the configured regional config and pushes it to main', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /git add apps\/api\/wrangler\.global\.jsonc\n\s+git commit -qm/u);
  assert.doesNotMatch(workflow, /git commit -a/u);
  assert.match(workflow, /git fetch origin main\n\s+git rebase origin\/main\n\s+git push origin HEAD:main/u);
  assert.doesNotMatch(workflow, /git push --force/u);
});

test('the push authenticates with the PAT so deploy-api.yml starts', async () => {
  const workflow = await readWorkflow();
  // A GITHUB_TOKEN push starts no workflows. The checkout token is the PAT
  // with no fallback, and a missing token fails before the build.
  assert.match(workflow, /^ {10}token: \$\{\{ secrets\.TERMINAL_SNAPSHOT_PR_TOKEN \}\}$/mu);
  assert.match(workflow, /if \[ "\$PR_TOKEN_CONFIGURED" != "true" \]; then[\s\S]*?exit 1/u);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/u);
  assert.doesNotMatch(workflow, /gh pr /u);
});
