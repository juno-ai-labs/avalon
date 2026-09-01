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
const flagshipAppId = 'bec01d3a-d6b6-4d8c-b89a-37440ed63b8c';
const aceDomain = 'ace.internal.rallywith.ai';
const migrationDomain = 'migrations.internal.rallywith.ai';
const generatedConfig = join(appDirectory, 'wrangler.generated.json');

if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
if (!deploymentToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
if (!aceRuntimeToken) throw new Error('ACE_FLAGSHIP_API_TOKEN is required');

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
  ensureFlag('hypersight-enabled', 'True shows HyperSight surfaces in Electron; false hides them without changing API availability.'),
  ensureFlag('meeting-recording-enabled', 'True shows meeting-recording actions in Electron; false hides them without changing API availability.'),
  ensureFlag('suggested-work-enabled', 'True shows Suggested Work surfaces in Electron; false hides them without changing API availability.'),
  ensureFlag('automation-workspace-templates-enabled', 'True shows workspace-template surfaces in Electron; false hides them without changing API availability.'),
  // Defaults ON, not off like every other managed flag: a digest already
  // sends by default for every existing person, so provisioning this flag
  // must not be the thing that silently stops delivery. See docs/digests.md#the-run.
  ensureFlag('digests-enabled', 'True sends scheduled digests as configured; false stops delivery for whoever the rule reaches and hides the Digest settings section in Electron for them, without touching their saved schedule, destinations, or cursor.', 'on'),
  ensureModelFlag('agent-model-workstream', 'Runs the main participant-visible work stream and the structured attachment-summary pass: reasons over transcripts, calls tools, and streams answers.', 'x-ai/grok-4.3', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-inline-child', 'Runs a bounded read-only child task delegated by a work-stream agent and returns the result to its parent.', 'x-ai/grok-4.3', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-automation-compiler', 'Turns an automation setup conversation into the saved automation definition, schedule, scope, and delivery plan.', 'x-ai/grok-4.5', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-block-dashboard', 'Refreshes one shared read-only Markdown dashboard block from a reproducible interval of the work-stream transcript.', 'x-ai/grok-4.3', []),
  ensureModelFlag('agent-model-meeting-notes', 'Produces the live and final meeting-note passes from captured transcript segments.', 'x-ai/grok-4.3', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-addressing-classifier', 'Decides whether a message is for the agent, people, both, or uncertain before a work-stream run starts.', 'google/gemini-2.5-flash-lite', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-workstream-naming', 'Creates the short work-stream title from the opening request while the creator waits.', 'google/gemini-2.5-flash-lite', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-work-opportunity-admission', 'Decides whether recent unclaimed activity should become a personal or workspace suggestion and drafts its candidate.', 'google/gemini-2.5-flash-lite', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-work-opportunity-ranking', 'Orders admitted suggestions for one person, accounting for freshness and impressions before storing the visible set.', 'google/gemini-2.5-flash-lite', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-workstream-description', 'Re-evaluates the derived one-line description after terminal runs and rewrites it only when the work stream changed purpose.', 'google/gemini-2.5-flash-lite', ['google/gemini-3.6-flash']),
  ensureModelFlag('agent-model-automation-result-disposition', 'Decides whether a completed automation run is worth delivering at all, and whether its result belongs in the work stream that owns the automation or in the work stream the run itself used, made visible.', 'google/gemini-2.5-flash-lite', ['google/gemini-3.6-flash']),
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
} finally {
  await unlink(generatedConfig).catch(() => undefined);
}
