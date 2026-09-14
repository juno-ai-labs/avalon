import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployWorkflowPath = join(repositoryDirectory, '.github/workflows/deploy-api.yml');
const ciWorkflowPath = join(repositoryDirectory, '.github/workflows/ci.yml');
const pricingConfigPath = join(repositoryDirectory, 'apps/api/wrangler.pricing.global.jsonc');
const pricingEntrypointPath = join(repositoryDirectory, 'apps/api/src/inference-pricing-worker.ts');
const telemetryConfigPath = join(repositoryDirectory, 'apps/api/wrangler.telemetry.global.jsonc');
const engineeringMcpDeployPath = join(
  repositoryDirectory,
  'apps/engineering-mcp/scripts/deploy.mjs',
);
const engineeringMcpHostedClientsPath = join(
  repositoryDirectory,
  'apps/engineering-mcp/hosted-clients.json',
);
const capabilityEntrypointPaths = [
  join(repositoryDirectory, 'apps/api/src/document-processing-worker.ts'),
  join(repositoryDirectory, 'apps/api/src/telemetry-delivery-worker.ts'),
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

test('a merge to main provisions every declared Queue before the regional deploy', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');
  const ensureQueues = workflow.indexOf(
    '- name: Ensure every Queue the Wrangler configs declare exists',
  );
  const deployGlobal = workflow.indexOf('- name: Deploy the Global Worker');

  assert.match(workflow, /push:\s+branches:\s+- main/su);
  assert.match(workflow, /- "apps\/api\/\*\*"/u);
  assert.match(workflow, /- "packages\/\*\*"/u);
  assert.notEqual(ensureQueues, -1, 'the deploy must run the idempotent Queue provisioner');
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

test('the Global pricing Worker refreshes the shared regional KV on an hourly cron', async () => {
  const [pricingConfig, pricingEntrypoint, globalConfig] = await Promise.all([
    readFile(pricingConfigPath, 'utf8'),
    readFile(pricingEntrypointPath, 'utf8'),
    readFile(join(repositoryDirectory, 'apps/api/wrangler.global.jsonc'), 'utf8'),
  ]);
  const pricingKv = pricingConfig.match(
    /"binding": "INFERENCE_PRICING_CACHE", "id": "(?<id>[a-f0-9]+)"/u,
  );

  assert.match(pricingConfig, /"name": "avalon-api-inference-pricing-global"/u);
  assert.match(pricingConfig, /"main": "src\/inference-pricing-worker\.ts"/u);
  assert.match(pricingConfig, /"workers_dev": false/u);
  assert.match(pricingConfig, /"crons": \["0 \* \* \* \*"\]/u);
  assert.ok(pricingKv?.groups?.id, 'the pricing Worker must bind the shared pricing KV');
  assert.match(globalConfig, new RegExp(`INFERENCE_PRICING_CACHE", "id": "${pricingKv.groups.id}"`, 'u'));
  assert.match(pricingEntrypoint, /async scheduled\([\s\S]+await refreshOpenRouterPricingCache\(env\)/u);
});

test('profiles and uploads every Global service before promotion', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');
  const build = workflow.indexOf('- name: Build and profile the exact Global Worker artifact');
  const upload = workflow.indexOf('- name: Upload all Global Worker versions without traffic');
  const deploy = workflow.indexOf('- name: Deploy the Global Worker');
  assert.ok(build >= 0 && upload > build && deploy > upload);
  for (const service of ['api', 'documents', 'terminal', 'pricing', 'telemetry']) {
    assert.ok(workflow.includes(`steps.upload_global.outputs.global_${service}`));
  }
  assert.match(workflow, /node scripts\/deploy-api-direct-region\.mjs global/u);
  assert.match(workflow, /wrangler versions deploy[\s\S]+--version-id "\$version_id"/u);
  assert.match(workflow, /Preserve exact deployment startup evidence/u);
});

test('a missing capability Worker selects the service-first direct bootstrap', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');

  assert.match(
    workflow,
    /if ! deployment="\$\(pnpm --filter @rally\/api exec wrangler deployments status[\s\S]+echo unknown/u,
  );
  assert.match(workflow, /args\+=\(--deployed-sha "\$\(deployed_sha wrangler\.documents\.global\.jsonc\)"\)/u);
  assert.match(workflow, /args\+=\(--deployed-sha "\$\(deployed_sha wrangler\.terminal\.global\.jsonc\)"\)/u);
  assert.match(workflow, /args\+=\(--deployed-sha "\$\(deployed_sha wrangler\.pricing\.global\.jsonc\)"\)/u);
  assert.match(workflow, /args\+=\(--deployed-sha "\$\(deployed_sha wrangler\.telemetry\.global\.jsonc\)"\)/u);
  assert.match(workflow, /if \[ "\$\{\{ steps\.deploy_mode\.outputs\.mode \}\}" = "versioned" \]; then/u);
});

test('the shared telemetry-delivery capability is Global-only and private', async () => {
  const [config, globalConfig] = await Promise.all([
    readFile(telemetryConfigPath, 'utf8'),
    readFile(join(repositoryDirectory, 'apps/api/wrangler.global.jsonc'), 'utf8'),
  ]);

  assert.match(config, /"name": "avalon-api-telemetry-delivery-global"/u);
  assert.match(config, /"main": "src\/telemetry-delivery-worker\.ts"/u);
  assert.match(config, /"workers_dev": false/u);
  assert.match(config, /"preview_urls": false/u);
  assert.match(globalConfig, /"binding": "TELEMETRY_DELIVERY"[\s\S]+"service": "avalon-api-telemetry-delivery-global"/u);
  assert.doesNotMatch(globalConfig, /POSTHOG_DELIVERY|avalon-api-posthog-global/u);
});

test('applies Worker-first D1 migrations after the compatible Worker', async () => {
  const workflow = await readFile(deployWorkflowPath, 'utf8');
  const positions = [
    'List the pending remote migrations for Global',
    'Apply the remote D1 migrations to Global',
    'Deploy the Global Worker',
    'Apply Worker-first D1 migrations in Global after the compatible Worker',
    'Verify regional health',
  ].map((name) => workflow.indexOf(`- name: ${name}`));
  for (let i = 0; i < positions.length; i++) {
    assert.ok(positions[i] >= 0);
    if (i) assert.ok(positions[i] > positions[i - 1]);
  }
  assert.match(workflow, /0090_drop_legacy_product_tables\.sql/u);
  assert.match(workflow, /0094_retire_agent_inference_payload_ledger\.sql/u);
  assert.match(workflow, /0097_email_routes_use_full_address\.sql/u);
  assert.equal(workflow.match(/classify-pending-d1-migrations\.mjs/gu)?.length, 1);
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

test('deploys the Managed OAuth engineering MCP only after configured APIs are healthy', async () => {
  const [workflow, provisioner, hostedClientsSource] = await Promise.all([
    readFile(deployWorkflowPath, 'utf8'),
    readFile(engineeringMcpDeployPath, 'utf8'),
    readFile(engineeringMcpHostedClientsPath, 'utf8'),
  ]);
  const hostedClients = JSON.parse(hostedClientsSource);
  const regionalHealth = workflow.indexOf('- name: Verify regional health');
  const deployMcp = workflow.indexOf('- name: Deploy the engineering MCP after configured regional entrypoints');
  const verifyMcp = workflow.indexOf(
    '- name: Verify the engineering MCP advertises OAuth to non-browser clients',
  );

  assert.match(workflow, /- "apps\/engineering-mcp\/\*\*"/u);
  assert.match(workflow, /pnpm --filter @rally\/engineering-mcp build/u);
  assert.match(
    workflow.slice(deployMcp, verifyMcp),
    /run: pnpm --filter @rally\/engineering-mcp run deploy/u,
    'MCP deployment must explicitly run the package script instead of pnpm\'s built-in deploy command',
  );
  assert.ok(regionalHealth < deployMcp, 'regional health checks must precede MCP deployment');
  assert.ok(deployMcp < verifyMcp, 'the OAuth challenge probe must inspect the new MCP deployment');
  assert.match(
    workflow.slice(deployMcp, verifyMcp),
    /if: env\.DEPLOY_GLOBAL == 'true'/u,
  );
  assert.match(workflow, /www-authenticate:.*resource_metadata/u);

  assert.match(provisioner, /const aceDomain = "ace\.internal\.rallywith\.ai"/u);
  assert.match(provisioner, /oauth_configuration:\s*\{\s*enabled: true,/su);
  assert.match(provisioner, /dynamic_client_registration:\s*\{[\s\S]{0,180}enabled: true,/u);
  assert.match(provisioner, /allow_any_on_localhost: true/u);
  assert.match(provisioner, /allow_any_on_loopback: true/u);
  assert.deepEqual(hostedClients, {
    oauthRedirectUriPatterns: [
      'https://claude.ai/*',
      'https://chatgpt.com/*',
      'https://cursor.com/*',
      'https://www.cursor.com/*',
    ],
    originHostnames: ['claude.ai', 'chatgpt.com', 'cursor.com', 'www.cursor.com'],
  });
  assert.match(provisioner, /hostedClients\.oauthRedirectUriPatterns/u);
  assert.match(
    provisioner,
    /allowed_uris:\s*\[\.\.\.new Set\(\[\s*\.\.\.currentAllowedRedirectUris,\s*\.\.\.hostedMcpRedirectUris,?\s*\]\)\]/su,
    'hosted callback patterns must be merged with administrator-managed redirect URIs',
  );
  assert.match(provisioner, /current\?\.oauth_configuration\?\.grant/u);
  assert.match(provisioner, /config\.vars\.ACCESS_APPLICATION_AUD = audience/u);
  assert.match(provisioner, /cloudflareList\("\/access\/apps"\)/u);
  assert.match(provisioner, /body\.result_info\?\.total_pages/u);
  assert.match(provisioner, /cloudflareList\(\s*`\/access\/apps\/\$\{encodeURIComponent\(ace\.id\)\}\/policies`/u);
});
