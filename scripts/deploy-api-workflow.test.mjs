import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployWorkflowPath = join(repositoryDirectory, '.github/workflows/deploy-api.yml');
const ciWorkflowPath = join(repositoryDirectory, '.github/workflows/ci.yml');
const capabilityEntrypointPaths = [
  join(repositoryDirectory, 'apps/api/src/document-processing-worker.ts'),
  join(repositoryDirectory, 'apps/api/src/terminal-provider-worker.ts'),
];

function matrixCommand(workflow, lane) {
  const escapedLane = lane.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Sibling keys (currently `env:` on CI) may sit between `name` and `command`.
  const match = workflow.match(new RegExp(
    `^ {10}- name: ${escapedLane}\\n`
      + `(?: {12}(?!command:)\\S.*\\n(?: {14}.+\\n)*)*`
      + ` {12}command: (?:>-\\n(?<folded>(?:^ {14}.+\\n?)+)|(?<inline>.+))`,
    'mu',
  ));

  assert.ok(match, `the workflow must define the ${lane} matrix lane`);
  return match.groups.inline ?? match.groups.folded
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .join(' ');
}

function assertInertFetchHandler(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const entrypoint = sourceFile.statements.find((statement) => (
    ts.isClassDeclaration(statement)
      && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)
      && statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
  ));
  assert.ok(entrypoint && ts.isClassDeclaration(entrypoint), `${path} must default-export a class`);

  const handler = entrypoint.members.find((member) => (
    ts.isMethodDeclaration(member)
      && ts.isIdentifier(member.name)
      && member.name.text === 'fetch'
  ));
  assert.ok(handler && ts.isMethodDeclaration(handler), `${path} must register a fetch handler`);
  assert.ok(
    handler.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.OverrideKeyword),
    `${path} fetch handler must override WorkerEntrypoint.fetch`,
  );
  assert.equal(handler.body?.statements.length, 1, `${path} fetch handler must be inert`);

  const [statement] = handler.body.statements;
  assert.ok(
    ts.isReturnStatement(statement) && statement.expression,
    `${path} fetch handler must return a response`,
  );
  const response = statement.expression;
  assert.ok(
    ts.isNewExpression(response)
      && ts.isIdentifier(response.expression)
      && response.expression.text === 'Response',
    `${path} fetch handler must return a Response`,
  );
  assert.equal(response.arguments?.length, 2, `${path} fetch handler must return only a status`);
  assert.equal(response.arguments[0].kind, ts.SyntaxKind.NullKeyword, `${path} response body must be null`);

  const options = response.arguments[1];
  assert.ok(ts.isObjectLiteralExpression(options), `${path} response options must be literal`);
  assert.equal(options.properties.length, 1, `${path} response must set only its status`);
  const [status] = options.properties;
  assert.ok(
    ts.isPropertyAssignment(status)
      && ts.isIdentifier(status.name)
      && status.name.text === 'status'
      && ts.isNumericLiteral(status.initializer)
      && status.initializer.text === '404',
    `${path} fetch handler must always return 404`,
  );
}

test('a merge to main provisions every declared Queue before either regional deploy', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');
  const ensureQueues = workflow.indexOf(
    '- name: Ensure every Queue the Wrangler configs declare exists',
  );
  const deployEu = workflow.indexOf('- name: Deploy the EU Worker');
  const deployGlobal = workflow.indexOf('- name: Deploy the Global Worker');

  assert.match(workflow, /push:\s+branches:\s+- main/su);
  assert.match(workflow, /- "apps\/api\/\*\*"/u);
  assert.match(workflow, /- "packages\/\*\*"/u);
  assert.notEqual(ensureQueues, -1, 'the deploy must run the idempotent Queue provisioner');
  assert.ok(ensureQueues < deployEu, 'Queue provisioning must precede the EU deploy');
  assert.ok(ensureQueues < deployGlobal, 'Queue provisioning must precede the Global deploy');
});

test('private RPC Workers register Cloudflare-required inert fetch handlers', async () => {
  const entrypoints = await Promise.all(
    capabilityEntrypointPaths.map(async (path) => [path, await readFile(path, 'utf8')]),
  );

  for (const [path, entrypoint] of entrypoints) {
    assertInertFetchHandler(path, entrypoint);
  }
});

test('profiles all static service artifacts and uploads both regional sets before promotion', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');
  const buildEu = workflow.indexOf('- name: Build and profile the exact EU Worker artifact');
  const buildGlobal = workflow.indexOf('- name: Build and profile the exact Global Worker artifact');
  const uploadEu = workflow.indexOf('- name: Upload all EU Worker versions without traffic');
  const uploadGlobal = workflow.indexOf('- name: Upload all Global Worker versions without traffic');
  const deployEu = workflow.indexOf('- name: Deploy the EU Worker');
  const euHealth = workflow.indexOf('- name: Verify EU health before Global promotion');
  const deployGlobal = workflow.indexOf('- name: Deploy the Global Worker');

  for (const position of [buildEu, buildGlobal, uploadEu, uploadGlobal, deployEu, euHealth, deployGlobal]) {
    assert.notEqual(position, -1);
  }
  assert.ok(buildEu < uploadEu && buildGlobal < uploadEu);
  assert.ok(uploadEu < deployEu && uploadGlobal < deployEu);
  assert.ok(deployEu < euHealth && euHealth < deployGlobal);
  assert.match(workflow, /wrangler\.documents\.eu\.jsonc wrangler\.terminal\.eu\.jsonc \.wrangler\.lakehouses\.eu\.json/u);
  assert.match(workflow, /wrangler\.documents\.global\.jsonc wrangler\.terminal\.global\.jsonc \.wrangler\.lakehouses\.global\.json/u);
  assert.match(workflow, /WRANGLER_OUTPUT_FILE_PATH="\$output_file"[\s\S]+\.version_id/u);
  assert.match(workflow, /wrangler versions deploy[\s\S]+--version-id "\$version_id"/u);
  assert.doesNotMatch(workflow, /versions deploy[\s\S]{0,200}--version-tag/u);
  assert.match(workflow, /steps\.upload_eu\.outputs\.eu_documents/u);
  assert.match(workflow, /steps\.upload_global\.outputs\.global_api/u);
  assert.match(workflow, /Preserve exact deployment startup evidence/u);
});

test('a missing capability Worker selects the service-first direct bootstrap', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');

  assert.match(
    workflow,
    /if ! deployment="\$\(pnpm --filter @rally\/api exec wrangler deployments status[\s\S]+echo unknown/u,
  );
  assert.match(workflow, /args\+=\(--deployed-sha "\$\(deployed_sha wrangler\.documents\.eu\.jsonc\)"\)/u);
  assert.match(workflow, /args\+=\(--deployed-sha "\$\(deployed_sha wrangler\.terminal\.global\.jsonc\)"\)/u);
  assert.match(workflow, /if \[ "\$\{\{ steps\.deploy_mode\.outputs\.mode \}\}" = "versioned" \]; then/u);
});

test('applies destructive D1 retirements only after compatible Workers deploy', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');
  const pendingEu = workflow.indexOf('- name: List the pending remote migrations for EU');
  const ordinaryEu = workflow.indexOf('- name: Apply the remote D1 migrations to EU');
  const deployEu = workflow.indexOf('- name: Deploy the EU Worker');
  const deployGlobal = workflow.indexOf('- name: Deploy the Global Worker');
  const retireEu = workflow.indexOf(
    '- name: Apply Worker-first D1 migrations in EU after the compatible Worker',
  );
  const retireGlobal = workflow.indexOf(
    '- name: Apply Worker-first D1 migrations in Global after the compatible Worker',
  );
  const health = workflow.indexOf('- name: Verify regional health');

  for (const [label, position] of Object.entries({
    pendingEu,
    ordinaryEu,
    deployEu,
    deployGlobal,
    retireEu,
    retireGlobal,
    health,
  })) assert.notEqual(position, -1, `${label} step is required`);
  assert.ok(pendingEu < ordinaryEu, 'the pending ledger must select migration ordering');
  assert.ok(ordinaryEu < deployEu, 'ordinary migrations remain migration-first');
  assert.ok(deployEu < deployGlobal, 'EU must still deploy before Global');
  assert.ok(deployGlobal < retireEu, 'a Worker-first migration must wait for both compatible Workers');
  assert.ok(retireEu < retireGlobal, 'EU Worker-first migrations must still precede Global');
  assert.ok(retireGlobal < health, 'health must inspect the final schema');
  assert.match(workflow, /0090_drop_legacy_product_tables\.sql/u);
  assert.match(workflow, /0094_retire_agent_inference_payload_ledger\.sql/u);
  assert.match(workflow, /0097_email_routes_use_full_address\.sql/u);
  assert.equal(
    workflow.match(/classify-pending-d1-migrations\.mjs/gu)?.length,
    2,
    "both regional ledgers must reject companions around Worker-first migrations",
  );
  assert.match(workflow, /steps\.pending_eu\.outputs\.worker_first == 'true'/u);
  assert.match(workflow, /steps\.pending_global\.outputs\.worker_first == 'true'/u);
});

test('deploy verify shards workers the same way CI does', async () => {
  const [deploy, ci] = await Promise.all([
    readFile(deployWorkflowPath, 'utf8'),
    readFile(ciWorkflowPath, 'utf8'),
  ]);

  for (const lane of ['api-tests-workers-1-of-n', 'api-tests-workers-2-of-n']) {
    assert.equal(
      matrixCommand(deploy, lane),
      matrixCommand(ci, lane),
      `deploy ${lane} must match CI so verify is not a second, unsharded workers run`,
    );
  }

  const nodeShardTwo = matrixCommand(deploy, 'api-tests-2-of-2');
  assert.equal(
    nodeShardTwo,
    'pnpm --filter @rally/api exec vitest run --shard=2/2',
  );
  assert.doesNotMatch(
    nodeShardTwo,
    /test:workers|vitest\.workers\.config\.ts/u,
    'workers must not be appended unsharded onto a Node API shard',
  );
});
