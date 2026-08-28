import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('a merge to main provisions every declared Queue before either regional deploy', async () => {
  const workflow = await readFile(
    join(repositoryDirectory, '.github/workflows/deploy-api.yml'),
    'utf8',
  );
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

test('applies destructive D1 retirements only after compatible Workers deploy', async () => {
  const workflow = await readFile(
    join(repositoryDirectory, '.github/workflows/deploy-api.yml'),
    'utf8',
  );
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

test('runs the one-shot automation cutover between regional health checks', async () => {
  const workflow = await readFile(
    join(repositoryDirectory, '.github/workflows/deploy-api.yml'),
    'utf8',
  );
  const firstHealth = workflow.indexOf('- name: Verify regional health');
  const cutover = workflow.indexOf('- name: Cut over workspace automations to AutomationAgent');
  const finalHealth = workflow.indexOf('- name: Verify regional health after automation cutover');
  assert.ok(firstHealth >= 0 && firstHealth < cutover, 'the new Workers must be healthy before cutover');
  assert.ok(cutover < finalHealth, 'the deployment must verify both regions after cutover');
  assert.match(workflow, /cutover-automation-agents\.mjs --apply/u);
});

test('wakes WorkspaceDO ledgers on the old build before deploying either region', async () => {
  const workflow = await readFile(
    join(repositoryDirectory, '.github/workflows/deploy-api.yml'),
    'utf8',
  );
  const preflight = workflow.indexOf(
    '- name: Establish historical WorkspaceDO migration ledgers on the old build',
  );
  const deployEu = workflow.indexOf('- name: Deploy the EU Worker');
  const deployGlobal = workflow.indexOf('- name: Deploy the Global Worker');
  assert.ok(preflight >= 0 && preflight < deployEu, 'the old EU Worker must receive the ledger wake');
  assert.ok(preflight < deployGlobal, 'the old Global Worker must receive the ledger wake');
  assert.match(workflow, /cutover-automation-agents\.mjs --preflight/u);
});
