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
// Job name to Azure deployment identifier, in the order the workflow declares
// them — the first test asserts the job headings match this order exactly.
const reviewerModels = new Map([
	['review-deepseek-cline', 'DeepSeek-V4-Pro'],
	['review-grok-46-azure-cline', 'grok-4.6'],
	['review-kimi-cline', 'Kimi-K2.6'],
	['review-gpt-56-sol-cline', 'gpt-5.6-sol'],
	['review-gpt-56-terra-cline', 'gpt-5.6-terra'],
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

test('workflow contains only the expected Azure Cline reviewers', async () => {
	const workflow = await readWorkflow();
	const jobs = workflowJobs(workflow);

	assert.deepEqual([...jobs.keys()], [
		'acknowledge',
		...reviewerModels.keys(),
	]);
	assert.doesNotMatch(workflow, /OPENROUTER_API_KEY|review-qwen|review-mimo|review-glm|review-grok-cline/u);
	assert.match(workflow, /^ {2}pull_request:$/mu);
	assert.doesNotMatch(workflow, /^ {2}pull_request_target:$/mu);
	assert.match(workflow, /^ {4}types: \[opened, reopened, ready_for_review\]$/mu);
	assert.doesNotMatch(workflow, /synchronize/u);

	const acknowledge = jobs.get('acknowledge');
	assert.match(acknowledge, /github\.event\.issue\.pull_request != null/u);
	assert.match(acknowledge, /github\.event\.comment\.author_association/u);
	assert.match(acknowledge, /'\/cline review'/u);
	assert.doesNotMatch(acknowledge, /opencode/u);
});

test('each Azure reviewer preserves the proven Monad Cline harness', async () => {
	const jobs = workflowJobs(await readWorkflow());

	for (const [jobName, model] of reviewerModels) {
		const review = jobs.get(jobName);
		assert.ok(review, `workflow must define ${jobName}`);

		assert.match(review, /github\.event_name == 'pull_request'/u);
		assert.match(review, /github\.event\.pull_request\.draft == false/u);
		assert.match(review, /github\.event\.issue\.pull_request != null/u);
		assert.match(review, /github\.event\.comment\.author_association/u);
		assert.match(review, /contains\(github\.event\.comment\.body, '\/cline review'\)/u);

		for (const permission of [
			'contents: read',
			'pull-requests: write',
			'issues: write',
			'checks: read',
			'statuses: read',
			'actions: read',
		]) {
			assert.match(review, new RegExp(`^ {6}${permission}$`, 'mu'));
		}

		assert.equal(
			occurrences(review, /\$\{\{ secrets\.AZURE_AI_API_KEY \}\}/gu),
			3,
			`${jobName} must expose the Azure key only to validation, authentication, and posting`,
		);
		assert.match(review, /\$\{\{ vars\.AZURE_AI_API_ENDPOINT \}\}/u);
		assert.match(review, /\*\.services\.ai\.azure\.com\|\*\.openai\.azure\.com/u);
		// `replaceAll`, not `replace`: an identifier with two dots would otherwise
		// leave the second one as a regex wildcard and stop pinning the deployment.
		assert.match(review, new RegExp(`--modelid ${model.replaceAll('.', '\\.')}`, 'u'));
		assert.match(review, /^ {6}CLINE_NO_AUTO_UPDATE: "1"$/mu);
		assert.match(review, /^ {8}run: npm install -g cline@3\.0\.47$/mu);

		const stepNames = [...review.matchAll(/^ {6}- name: (.+)$/gmu)].map(
			(match) => match[1],
		);
		assert.deepEqual(stepNames, [
			'Verify Azure AI credentials and resolve the inference base URL',
			'Resolve PR number',
			'Setup Node.js',
			'Install Cline CLI',
			'Verify Cline CLI',
			...stepNames.filter((name) =>
				name.startsWith('Configure Cline authentication ('),
			),
			'Check out the PR head',
			'Clear the workspace root',
			'Review PR with Cline',
			'Post Cline review',
		]);

		assert.match(review, /uses: actions\/checkout@v6/u);
		assert.match(review, /ref: refs\/pull\/\$\{\{ steps\.pr\.outputs\.number \}\}\/head/u);
		assert.match(review, /^ {10}path: pr-head$/mu);
		assert.match(review, /^ {10}persist-credentials: false$/mu);
		assert.match(review, /rm -rf cline-review\.md AGENTS\.md CLAUDE\.md \.clinerules \.cline \.agents/u);

		const modelReviewStart = review.indexOf('      - name: Review PR with Cline');
		const postStart = review.indexOf('      - name: Post Cline review');
		assert.ok(modelReviewStart >= 0 && modelReviewStart < postStart);
		const modelReview = review.slice(modelReviewStart, postStart);
		assert.match(modelReview, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
		assert.match(modelReview, /CLINE_COMMAND_PERMISSIONS/u);
		assert.match(modelReview, /PROMPT=\$\(cat <<EOF/u);
		assert.match(
			modelReview,
			/cline --cwd "\$GITHUB_WORKSPACE" --auto-approve true "\$PROMPT"/u,
		);
		assert.doesNotMatch(
			modelReview,
			/cline[^\n]*--json|PROMPT_FILE|< "\$PROMPT_FILE"|cat "\$PROMPT_FILE" \| cline/u,
		);

		const post = review.slice(postStart);
		assert.match(post, /REVIEW_FILE="\$GITHUB_WORKSPACE\/cline-review\.md"/u);
		const symlinkGuard = post.indexOf('if [ -L "$REVIEW_FILE" ]');
		const regularFileRead = post.indexOf('if [ ! -f "$REVIEW_FILE" ]');
		assert.ok(symlinkGuard >= 0 && symlinkGuard < regularFileRead);
		assert.match(post, /for secret in "\$AZURE_API_KEY" "\$GH_TOKEN"; do/u);
	}
});
