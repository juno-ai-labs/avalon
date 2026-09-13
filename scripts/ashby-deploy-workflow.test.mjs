import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = await readFile(join(repository, '.github/workflows/deploy-api.yml'), 'utf8');
const steps = workflow.split(/^ {6}- name: /mu).slice(1).map((block) => {
  const lines = block.split('\n');
  const run = block.match(/^ {8}run: (.+)\n(?<body>(?:^ {10}.*\n|^\n)*)/mu);
  return {
    name: lines[0],
    condition: block.match(/^ {8}if: (.+)$/mu)?.[1],
    script: run?.[1] === '|' ? run.groups.body.replace(/^ {10}/gmu, '') : run?.[1],
  };
});
const selectedNames = new Set([
  'Select the Cloudflare deployment mode',
  'Upload all EU Worker versions without traffic',
  'Upload all Global Worker versions without traffic',
  'Bootstrap Global Ashby router before EU',
  'Deploy the EU Worker', 'Verify EU health before Global promotion',
  'Deploy the Global Worker', 'Verify Global health before schema retirement',
  'Verify regional health', 'Deploy dedicated Ashby ingress after both regional entrypoints',
  'Verify dedicated Ashby ingress and its regional dependencies',
]);

// Execute the checked-in shell steps and their region/order conditions. Only the
// unavailable Cloudflare commands and live health probes are stand-ins. Regional
// deployment uses the production helper and real child processes throughout.
async function release(t, { bootstrap = false, failure = '', eu = true, global = true, mode = 'direct' } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'ashby-release-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const log = join(temporary, 'commands');
  const output = join(temporary, 'output');
  await writeFile(log, '');
  await writeFile(output, '');
  await writeFile(join(temporary, 'pnpm'), `#!/bin/bash
set -euo pipefail
echo "pnpm $*" >> "$COMMAND_LOG"
if [[ "$*" == *"$FAIL_COMMAND"* ]] && [ -n "$FAIL_COMMAND" ]; then exit 1; fi
if [[ "$*" == *"deployments status"* ]]; then echo '{"versions":[{"version_id":"active","percentage":100}]}'; fi
if [[ "$*" == *"versions list"* ]]; then echo '[{"id":"active","annotations":{"workers/tag":"verified"}}]'; fi
if [[ "$*" == *"versions upload"* ]]; then echo '{"type":"version-upload","version_id":"uploaded"}' > "$WRANGLER_OUTPUT_FILE_PATH"; fi
`, { mode: 0o755 });
  await writeFile(join(temporary, 'node'), `#!/bin/bash
set -euo pipefail
if [ "$1" = scripts/deploy-api-direct-region.mjs ]; then exec "$REAL_NODE" "$@"; fi
echo "node $*" >> "$COMMAND_LOG"
if [[ "$*" == *"$FAIL_COMMAND"* ]] && [ -n "$FAIL_COMMAND" ]; then exit 1; fi
if [ "$1" = scripts/select-api-deploy-mode.mjs ]; then echo '{"mode":"${mode}","reason":"fixture"}'; fi
`, { mode: 0o755 });
  const values = {
    'env.DEPLOY_EU': String(eu), 'env.DEPLOY_GLOBAL': String(global),
    'steps.ashby_order.outputs.bootstrap_global': String(bootstrap),
    'needs.verify.outputs.verified_sha': 'verified',
    'steps.deploy_mode.outputs.mode': mode,
  };
  const executed = [];
  let failed;
  for (const step of steps.filter(({ name }) => selectedNames.has(name))) {
    if (step.condition && !step.condition.split(' && ').every((part) => {
      const match = part.match(/^(\S+) (==|!=) '([^']+)'$/u);
      assert.ok(match, `unsupported condition: ${part}`);
      const [, key, operator, value] = match;
      assert.ok(Object.hasOwn(values, key), `unknown condition key: ${key}`);
      return operator === '==' ? values[key] === value : values[key] !== value;
    })) continue;
    const script = step.script.replace(/\$\{\{ (.+?) \}\}/gu, (_, key) => {
      if (key.startsWith('steps.upload_')) return 'uploaded';
      assert.ok(Object.hasOwn(values, key), `unknown expression: ${key}`);
      return values[key];
    });
    executed.push(step.name);
    try {
      await execFile('bash', ['-e', '-o', 'pipefail', '-c', script], {
        cwd: repository,
        env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, REAL_NODE: process.execPath,
          COMMAND_LOG: log, FAIL_COMMAND: failure, DEPLOY_EU: String(eu), DEPLOY_GLOBAL: String(global),
          DEPLOY_SHA: 'verified', GITHUB_OUTPUT: output, RUNNER_TEMP: temporary, GITHUB_RUN_ATTEMPT: '1' },
      });
      if (step.name === 'Select the Cloudflare deployment mode') {
        values['steps.deploy_mode.outputs.mode'] = (await readFile(output, 'utf8')).match(/^mode=(.+)$/mu)[1];
      }
    } catch {
      failed = step.name;
      break;
    }
  }
  return { executed, failed, commands: await readFile(log, 'utf8') };
}

const regionalDeploys = (commands) => commands.split('\n').filter((line) => /wrangler (deploy|versions deploy) .*lakehouses/u.test(line));

test('first rollout executes Global once, proves health and router, then EU and dedicated ingress', async (t) => {
  const result = await release(t, { bootstrap: true, mode: 'versioned' });
  assert.equal(result.failed, undefined);
  assert.match(regionalDeploys(result.commands)[0], /global/u);
  assert.match(regionalDeploys(result.commands)[1], /eu/u);
  assert.equal(regionalDeploys(result.commands).length, 2);
  assert.doesNotMatch(result.commands, /versions upload/u, 'no EU caller upload before bootstrap');
  assert.match(result.commands, /lakehouses.global.json.*\nnode scripts\/check-regional-health.mjs global\nnode scripts\/select-ashby-deploy-order.mjs --require-global-router\npnpm .*wrangler.artifacts.eu.jsonc/u);
  assert.ok(result.executed.indexOf('Verify regional health') < result.executed.indexOf('Deploy dedicated Ashby ingress after both regional entrypoints'));
  assert.equal(result.executed.at(-1), 'Verify dedicated Ashby ingress and its regional dependencies');
  assert.match(result.commands, /--tag verified/u);
});

test('normal release and retry after Global bootstrap preserve EU health before Global promotion', async (t) => {
  for (const mode of ['direct', 'versioned']) {
    const result = await release(t, { mode });
    assert.equal(result.failed, undefined);
    assert.match(regionalDeploys(result.commands)[0], /eu/u);
    assert.match(regionalDeploys(result.commands)[1], /global/u);
    assert.equal(regionalDeploys(result.commands).length, 2);
    assert.ok(!result.executed.includes('Bootstrap Global Ashby router before EU'));
    assert.ok(result.executed.indexOf('Verify EU health before Global promotion') < result.executed.indexOf('Deploy the Global Worker'));
    if (mode === 'versioned') {
      assert.ok(result.commands.lastIndexOf('versions upload') < result.commands.indexOf('versions deploy'));
      assert.match(result.commands, /--version-id uploaded/u);
    }
  }
});

test('bootstrap deployment, Global health, or router verification failure prevents EU and ingress', async (t) => {
  for (const failure of ['wrangler.documents.global.jsonc', 'check-regional-health.mjs global', '--require-global-router']) {
    const result = await release(t, { bootstrap: true, failure });
    assert.equal(result.failed, 'Bootstrap Global Ashby router before EU');
    assert.doesNotMatch(result.commands, /wrangler.artifacts.eu.jsonc|wrangler.ashby.global.jsonc/u);
    if (failure === 'wrangler.documents.global.jsonc') assert.doesNotMatch(result.commands, /lakehouses.global/u);
  }
});

test('EU health failure blocks normal Global promotion and shared ingress', async (t) => {
  const result = await release(t, { failure: 'check-regional-health.mjs eu' });
  assert.equal(result.failed, 'Verify EU health before Global promotion');
  assert.equal(regionalDeploys(result.commands).length, 1);
  assert.doesNotMatch(result.commands, /wrangler.ashby.global.jsonc/u);
});

test('partial regional recovery leaves shared ingress untouched', async (t) => {
  for (const options of [{ eu: false }, { global: false }]) {
    const result = await release(t, options);
    assert.equal(result.failed, undefined);
    assert.equal(regionalDeploys(result.commands).length, 1);
    assert.doesNotMatch(result.commands, /wrangler.ashby.global.jsonc/u);
  }
});


test('Global health failure after EU prevents dedicated ingress', async (t) => {
  const result = await release(t, { failure: 'check-regional-health.mjs global' });
  assert.equal(result.failed, 'Verify Global health before schema retirement');
  assert.equal(regionalDeploys(result.commands).length, 2);
  assert.doesNotMatch(result.commands, /wrangler.ashby.global.jsonc/u);
});

test('bootstrap follows ordinary migrations and preserves both Worker-first migration barriers', () => {
  const bootstrap = workflow.indexOf('- name: Bootstrap Global Ashby router before EU');
  for (const region of ['EU', 'Global']) {
    assert.ok(workflow.indexOf(`- name: Apply the remote D1 migrations to ${region}`) < bootstrap);
    assert.ok(workflow.indexOf(`- name: Apply Worker-first D1 migrations in ${region}`) > bootstrap);
  }
  assert.ok(workflow.indexOf('- name: Select Ashby deployment order') < workflow.indexOf('- name: Ensure every Queue'));
  assert.match(workflow, /Verify dedicated Ashby ingress[\s\S]+AVALON_GLOBAL_API_URL: https:\/\/ashby.rallywith.ai[\s\S]+run: node scripts\/check-regional-health.mjs global/u);
});
