import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = join(
  repositoryDirectory,
  '.github/workflows/azure-ai-reviewers.yml',
);
const reviewerModels = new Map([
  ['review-deepseek-cline', 'DeepSeek-V4-Pro'],
  ['review-grok-43-azure-cline', 'grok-4.3'],
  ['review-kimi-cline', 'Kimi-K2.6'],
]);

async function readWorkflow() {
  return readFile(workflowPath, 'utf8');
}

function workflowJobs(workflow) {
  const jobsStart = workflow.indexOf('\njobs:\n');
  assert.notEqual(jobsStart, -1, 'workflow must define jobs');

  const jobsSource = workflow.slice(jobsStart + '\njobs:\n'.length);
  const headings = [...jobsSource.matchAll(/^ {2}([a-z0-9-]+):$/gmu)];
  const jobs = new Map();

  for (const [index, heading] of headings.entries()) {
    const end = headings[index + 1]?.index ?? jobsSource.length;
    jobs.set(heading[1], jobsSource.slice(heading.index, end));
  }

  return jobs;
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test('Azure review workflow contains only the selected Cline reviewers', async () => {
  const workflow = await readWorkflow();
  const jobs = workflowJobs(workflow);

  assert.deepEqual(
    [...jobs.keys()],
    ['acknowledge', ...reviewerModels.keys()],
  );
  assert.doesNotMatch(workflow, /OPENROUTER|opencode/iu);
  assert.doesNotMatch(workflow, /^ {6}contents: write$/gmu);
  assert.match(workflow, /^ {4}types: \[opened, reopened, ready_for_review\]$/mu);
  assert.doesNotMatch(workflow, /synchronize/u);

  const acknowledge = jobs.get('acknowledge');
  assert.match(acknowledge, /github\.event\.issue\.pull_request != null/u);
  assert.match(acknowledge, /github\.event\.comment\.author_association/u);
  assert.match(acknowledge, /'\/cline review'/u);
});

test('every Azure reviewer preserves the trigger and checkout security boundary', async () => {
  const jobs = workflowJobs(await readWorkflow());

  for (const [jobName, model] of reviewerModels) {
    const job = jobs.get(jobName);
    assert.ok(job, `workflow must define ${jobName}`);

    assert.match(job, /github\.event\.pull_request\.draft == false/u);
    assert.match(job, /github\.event\.issue\.pull_request != null/u);
    assert.match(job, /github\.event\.comment\.author_association/u);
    assert.match(job, /contains\(github\.event\.comment\.body, '\/cline review'\)/u);

    for (const permission of [
      'contents: read',
      'pull-requests: write',
      'issues: write',
      'checks: read',
      'statuses: read',
      'actions: read',
    ]) {
      assert.match(job, new RegExp(`^ {6}${permission}$`, 'mu'));
    }

    assert.equal(
      occurrences(job, /\$\{\{ secrets\.AZURE_AI_API_KEY \}\}/gu),
      3,
      `${jobName} must expose the Azure key only to validation, auth, and posting`,
    );
    assert.match(job, /\$\{\{ vars\.AZURE_AI_API_ENDPOINT \}\}/u);
    assert.match(job, /\*\.services\.ai\.azure\.com\|\*\.openai\.azure\.com/u);
    assert.match(job, new RegExp(`--modelid ${model.replace('.', '\\.')} \\\\`, 'u'));
    assert.match(job, /^ {6}CLINE_NO_AUTO_UPDATE: "1"$/mu);

    const stepNames = [...job.matchAll(/^ {6}- name: (.+)$/gmu)]
      .map((match) => match[1]);
    const checkoutIndex = stepNames.indexOf('Check out the PR head');
    assert.ok(checkoutIndex > 0, `${jobName} must check out the PR head`);
    assert.equal(stepNames[checkoutIndex - 1].startsWith('Configure Cline authentication'), true);
    assert.deepEqual(
      stepNames.slice(checkoutIndex, checkoutIndex + 4),
      [
        'Check out the PR head',
        'Clear the workspace root',
        'Review PR with Cline',
        'Post Cline review',
      ],
      `${jobName} must not execute repository code after checkout`,
    );

    const checkoutAndReview = job.slice(job.indexOf('      - name: Check out the PR head'));
    assert.match(checkoutAndReview, /^ {10}path: pr-head$/mu);
    assert.match(checkoutAndReview, /^ {10}persist-credentials: false$/mu);
    assert.match(
      checkoutAndReview,
      /rm -rf cline-review\.md AGENTS\.md CLAUDE\.md \.clinerules \.cline \.agents/u,
    );
    assert.match(
      checkoutAndReview,
      /cline --cwd "\$GITHUB_WORKSPACE" --auto-approve true/u,
    );
    assert.match(
      checkoutAndReview,
      /REVIEW_FILE="\$GITHUB_WORKSPACE\/cline-review\.md"/u,
    );

    const symlinkGuard = checkoutAndReview.indexOf('if [ -L "$REVIEW_FILE" ]');
    const regularFileRead = checkoutAndReview.indexOf('if [ ! -f "$REVIEW_FILE" ]');
    assert.ok(symlinkGuard >= 0 && symlinkGuard < regularFileRead);
    assert.match(
      checkoutAndReview,
      /for secret in "\$AZURE_API_KEY" "\$GH_TOKEN"; do/u,
    );
  }
});
