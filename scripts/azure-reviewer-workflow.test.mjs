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
	['deepseek', 'DeepSeek-V4-Pro'],
	['grok-43-azure', 'grok-4.3'],
	['kimi', 'Kimi-K2.6'],
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

	assert.deepEqual([...jobs.keys()], ['acknowledge', 'review']);
	assert.doesNotMatch(workflow, /OPENROUTER|opencode/iu);
	assert.doesNotMatch(workflow, /actions\/checkout|pr-head/iu);
	assert.doesNotMatch(workflow, /--auto-approve true|CLINE_COMMAND_PERMISSIONS/u);
	assert.doesNotMatch(workflow, /^ {6}contents: write$/gmu);
	assert.match(workflow, /^ {2}pull_request_target:$/mu);
	assert.doesNotMatch(workflow, /^ {2}pull_request:$/mu);
	assert.match(workflow, /^ {4}types: \[opened, reopened, ready_for_review\]$/mu);
	assert.doesNotMatch(workflow, /synchronize/u);

	const acknowledge = jobs.get('acknowledge');
	assert.match(acknowledge, /github\.event\.issue\.pull_request != null/u);
	assert.match(acknowledge, /github\.event\.comment\.author_association/u);
	assert.match(acknowledge, /'\/cline review'/u);

	const review = jobs.get('review');
	for (const [reviewer, model] of reviewerModels) {
		assert.match(review, new RegExp(`reviewer: ${reviewer}$`, 'mu'));
		assert.match(review, new RegExp(`model: ${model.replace('.', '\\.')}$`, 'mu'));
	}
});

test('reviewers prefetch bounded context and deny Cline all tools', async () => {
	const jobs = workflowJobs(await readWorkflow());
	const review = jobs.get('review');
	assert.ok(review, 'workflow must define the review matrix');

	assert.match(review, /github\.event_name == 'pull_request_target'/u);
	assert.match(review, /github\.event\.pull_request\.draft == false/u);
	assert.match(review, /github\.event\.issue\.pull_request != null/u);
	assert.match(review, /github\.event\.comment\.author_association/u);
	assert.match(review, /contains\(github\.event\.comment\.body, '\/cline review'\)/u);
	assert.match(review, /^ {6}fail-fast: false$/mu);

	for (const permission of [
		'contents: read',
		'pull-requests: write',
		'issues: write',
	]) {
		assert.match(review, new RegExp(`^ {6}${permission}$`, 'mu'));
	}
	for (const removedPermission of ['checks:', 'statuses:', 'actions:']) {
		assert.doesNotMatch(review, new RegExp(`^ {6}${removedPermission}`, 'mu'));
	}

	assert.equal(
		occurrences(review, /\$\{\{ secrets\.AZURE_AI_API_KEY \}\}/gu),
		3,
		'Azure key must be exposed only to validation, authentication, and posting',
	);
	assert.match(review, /\$\{\{ vars\.AZURE_AI_API_ENDPOINT \}\}/u);
	assert.match(review, /\*\.services\.ai\.azure\.com\|\*\.openai\.azure\.com/u);
	assert.match(review, /project="\$\{path#\/api\/projects\/\}"/u);
	assert.match(review, /""\|\*\/\*\|\*\\\?\*\|\*\\#\*\|\*\[\[:space:\]\]\*/u);
	assert.match(review, /--modelid "\$\{\{ matrix\.model \}\}"/u);
	assert.match(review, /^ {6}CLINE_NO_AUTO_UPDATE: "1"$/mu);
	assert.match(review, /^ {8}run: npm install -g cline@3\.0\.47$/mu);

	const stepNames = [...review.matchAll(/^ {6}- name: (.+)$/gmu)].map(
		(match) => match[1],
	);
	assert.deepEqual(stepNames, [
		'Verify Azure AI credentials and resolve the inference base URL',
		'Resolve PR number',
		'Gather PR review context',
		'Setup Node.js',
		'Install Cline CLI',
		'Verify Cline CLI',
		'Configure Cline authentication (${{ matrix.label }} on Azure AI Foundry)',
		'Review PR with Cline',
		'Post Cline review',
	]);

	const gatherStart = review.indexOf('      - name: Gather PR review context');
	const reviewStart = review.indexOf('      - name: Review PR with Cline');
	const postStart = review.indexOf('      - name: Post Cline review');
	assert.ok(gatherStart >= 0 && gatherStart < reviewStart && reviewStart < postStart);

	const gather = review.slice(
		gatherStart,
		review.indexOf('      - name: Setup Node.js'),
	);
	assert.match(gather, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
	assert.match(
		gather,
		/--json number,title,body,author,baseRefName,headRefName,files/u,
	);
	assert.match(gather, /gh pr diff "\$PR_NUMBER"/u);
	assert.match(gather, /total_bytes.*600000/su);
	assert.match(gather, /cat "\$METADATA_FILE"/u);
	assert.match(gather, /cat "\$DIFF_FILE"/u);

	const modelReview = review.slice(reviewStart, postStart);
	assert.doesNotMatch(modelReview, /GH_TOKEN|github\.token/u);
	assert.match(modelReview, /CLINE_TOOL_APPROVAL_MODE: terminal/u);
	assert.match(modelReview, /cat <<'PROMPT'/u);
	assert.match(modelReview, /Do not call any tool/u);
	assert.match(modelReview, /mkdir -p "\$CLINE_WORKSPACE"/u);
	assert.match(modelReview, /--cwd "\$CLINE_WORKSPACE"/u);
	assert.match(modelReview, /--auto-approve false/u);
	assert.match(modelReview, /--json/u);
	assert.match(modelReview, /set -o pipefail/u);
	assert.match(modelReview, /cat "\$PROMPT_FILE" \| cline/u);
	assert.doesNotMatch(modelReview, /< "\$PROMPT_FILE"/u);
	assert.match(modelReview, /> "\$OUTPUT_FILE"/u);
	assert.match(modelReview, /select\(\.type == "run_result" and \.finishReason == "completed"\)/u);

	const post = review.slice(postStart);
	assert.match(post, /REVIEW_FILE="\$RUNNER_TEMP\/cline-review\.md"/u);
	const symlinkGuard = post.indexOf('if [ -L "$REVIEW_FILE" ]');
	const regularFileRead = post.indexOf('if [ ! -f "$REVIEW_FILE" ]');
	assert.ok(symlinkGuard >= 0 && symlinkGuard < regularFileRead);
	assert.match(post, /for secret in "\$AZURE_API_KEY" "\$GH_TOKEN"; do/u);
});
