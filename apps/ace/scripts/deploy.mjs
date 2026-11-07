import { execFileSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWranglerConfig } from '../../../scripts/wrangler-config.mjs';
import { verifyRuntimeQueuePermissions } from './runtime-token-permissions.mjs';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const deploymentToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
// The GitHub secret keeps its original name so an Ace release does not require
// a second credential migration. Its token now serves Ace's two Cloudflare API
// surfaces and is restricted to Flagship Write plus Queues Edit.
const aceRuntimeToken = process.env.ACE_FLAGSHIP_API_TOKEN?.trim();
// The operator tokens Ace's operator pages present to the regional API
// Workers. These are Rally operator credentials; the existing Global token
// remains in RALLY_OPERATOR_TOKEN.
const rallyOperatorToken = process.env.ACE_RALLY_OPERATOR_TOKEN?.trim();
const flagshipAppId = 'bec01d3a-d6b6-4d8c-b89a-37440ed63b8c';
const aceDomain = 'ace.internal.rallywith.ai';
const migrationDomain = 'migrations.internal.rallywith.ai';
const generatedConfig = join(appDirectory, 'wrangler.generated.json');

if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
if (!deploymentToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
if (!aceRuntimeToken) throw new Error('ACE_FLAGSHIP_API_TOKEN is required');
if (!rallyOperatorToken) throw new Error('ACE_RALLY_OPERATOR_TOKEN is required');

async function cloudflare(path, init = {}, authorization = deploymentToken) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${authorization}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const detail = (body?.errors ?? []).map((error) => error.message).join('; ');
    throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return body.result;
}

function policyShape(policy) {
  return Object.fromEntries([
    'name', 'decision', 'include', 'exclude', 'require', 'precedence',
    'purpose_justification_required', 'purpose_justification_prompt',
    'approval_required', 'approval_groups', 'session_duration',
  ].flatMap((key) => policy[key] === undefined ? [] : [[key, policy[key]]]));
}

async function ensureAccessApplication() {
  const applications = await cloudflare('/access/apps?per_page=100');
  const migration = applications.find((application) => application.domain === migrationDomain);
  if (!migration) throw new Error(`The ${migrationDomain} Access application is required as Ace's policy source`);
  const migrationPolicies = await cloudflare(`/access/apps/${encodeURIComponent(migration.id)}/policies?per_page=100`);
  if (!Array.isArray(migrationPolicies) || migrationPolicies.length === 0) {
    throw new Error('The migration Access application has no policy to reuse');
  }
  const policies = migrationPolicies.map(policyShape);
  const existing = applications.find((application) => application.domain === aceDomain);
  const application = {
    name: 'Avalon Ace',
    type: 'self_hosted',
    domain: aceDomain,
    session_duration: migration.session_duration ?? '24h',
    app_launcher_visible: migration.app_launcher_visible ?? false,
    auto_redirect_to_identity: migration.auto_redirect_to_identity ?? false,
    ...(Array.isArray(migration.allowed_idps) ? { allowed_idps: migration.allowed_idps } : {}),
    policies,
  };
  const result = existing
    ? await cloudflare(`/access/apps/${encodeURIComponent(existing.id)}`, { method: 'PUT', body: JSON.stringify(application) })
    : await cloudflare('/access/apps', { method: 'POST', body: JSON.stringify(application) });
  if (typeof result.aud !== 'string' || result.aud.length === 0) {
    throw new Error('Cloudflare Access returned no audience tag for Ace');
  }
  return result.aud;
}

let existingFlagKeysPromise;
async function flagExists(key) {
  existingFlagKeysPromise ??= cloudflare(`/flagship/apps/${flagshipAppId}/flags`, {}, aceRuntimeToken)
    .then((flags) => new Set(Array.isArray(flags) ? flags.map((flag) => flag.key) : []));
  return (await existingFlagKeysPromise).has(key);
}

async function retireFlag(key) {
  if (!await flagExists(key)) return;
  await cloudflare(`/flagship/apps/${flagshipAppId}/flags/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  }, aceRuntimeToken);
  (await existingFlagKeysPromise).delete(key);
}

async function ensureFlag(key, description, defaultVariation = 'off') {
  if (await flagExists(key)) return;
  await cloudflare(`/flagship/apps/${flagshipAppId}/flags`, {
    method: 'POST',
    body: JSON.stringify({
      key,
      description,
      enabled: true,
      default_variation: defaultVariation,
      variations: { off: false, on: true },
      rules: [],
    }),
  }, aceRuntimeToken);
}

async function ensureModelFlag(key, description, model, fallbackModels) {
  if (await flagExists(key)) return;
  await cloudflare(`/flagship/apps/${flagshipAppId}/flags`, {
    method: 'POST',
    body: JSON.stringify({
      key,
      description,
      enabled: true,
      default_variation: 'current',
      variations: { current: { model, fallbackModels } },
      rules: [],
      type: 'json',
    }),
  }, aceRuntimeToken);
}


function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: appDirectory, stdio: 'inherit', ...options });
}

const audience = await ensureAccessApplication();
await Promise.all([
  retireFlag('meeting-recording-enabled'),
  retireFlag('control-tower-refresh-seconds'),
  retireFlag('agent-model-meeting-notes'),
  retireFlag('hypersight-enabled'),
  retireFlag('agent-model-block-dashboard'),
  retireFlag('automation-workspace-templates-enabled'),
  retireFlag('agent-model-automation-compiler'),
  retireFlag('agent-model-automation-result-disposition'),
  retireFlag('agent-model-activity-structured'),
  retireFlag('agent-model-addressing-classifier'),
  retireFlag('agent-model-hypersight'),
  retireFlag('digests-enabled'),
  retireFlag('live-artifacts-enabled'),
  retireFlag('agent-model-workstream-description'),
  retireFlag('agent-model-suggestion-draft'),
  retireFlag('agent-model-work-opportunity-admission'),
  retireFlag('agent-model-work-opportunity-ranking'),
  retireFlag('agent-model-session-import'),
]);
await Promise.all([
  ensureFlag('suggested-work-enabled', 'True shows Suggested Work surfaces in Electron; false hides them without changing API availability.'),
  ensureFlag('multiple-workspaces-enabled', 'True shows workspace switching, invitations, creation, and background attention in Electron; false hides them without changing API availability.'),
  ensureFlag('push-notifications-enabled', 'True enables Apple push delivery and the desktop Notifications setting for everyone from launch; false pauses push for the targeted users.', 'on'),
  ensureModelFlag('agent-model-workstream', 'Runs a Canvas\'s Chat or a Sidekick\'s conversation and the structured attachment-summary pass: reasons over transcripts, calls tools, and streams answers.', 'openai/gpt-6.1-sol', ['google/gemini-3.8-flash']),
  ensureModelFlag('agent-model-inline-child', 'Runs a bounded read-only child task delegated by a Canvas chat\'s or Sidekick conversation\'s agent and returns the result to its parent.', 'openai/gpt-6.1-sol', ['google/gemini-3.8-flash']),
  ensureModelFlag('agent-model-workstream-naming', 'Titles a long pasted text from its contents, so the attachment chip has a name.', 'google/gemini-2.5-flash-lite', ['google/gemini-3.8-flash']),
  ensureModelFlag('agent-model-memory-sweep', 'Reads a window of a Canvas or Sidekick conversation after it settles and decides which facts Rally should remember, revise or retract; the judgment is what a colleague would need later, so it runs on a strong model.', 'openai/gpt-6.1-sol', ['google/gemini-3.8-flash']),
  ensureModelFlag('agent-model-sidekick-authoring', 'Creates and revises Sidekick definitions in their authoring conversations, including event bindings, schedules, tools, and durable run instructions.', 'openai/gpt-6.1-sol', ['google/gemini-3.8-flash']),
]);
await verifyRuntimeQueuePermissions({ accountId, token: aceRuntimeToken });

const source = await readFile(join(appDirectory, 'wrangler.jsonc'), 'utf8');
const config = parseWranglerConfig(source);
config.vars.ACCESS_APPLICATION_AUD = audience;
await writeFile(generatedConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
try {
  run('pnpm', ['build:client']);
  run('pnpm', ['exec', 'wrangler', 'deploy', '--config', generatedConfig]);
  run('pnpm', ['exec', 'wrangler', 'secret', 'put', 'CLOUDFLARE_FLAGSHIP_API_TOKEN', '--config', generatedConfig], {
    input: `${aceRuntimeToken}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  run('pnpm', ['exec', 'wrangler', 'secret', 'put', 'RALLY_OPERATOR_TOKEN', '--config', generatedConfig], {
    input: `${rallyOperatorToken}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
} finally {
  await unlink(generatedConfig).catch(() => undefined);
}
