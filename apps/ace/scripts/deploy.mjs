import { execFileSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWranglerConfig } from '../../../scripts/wrangler-config.mjs';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const deploymentToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const flagshipToken = process.env.ACE_FLAGSHIP_API_TOKEN?.trim();
const flagshipAppId = 'bec01d3a-d6b6-4d8c-b89a-37440ed63b8c';
const aceDomain = 'ace.internal.rallywith.ai';
const migrationDomain = 'migrations.internal.rallywith.ai';
const generatedConfig = join(appDirectory, 'wrangler.generated.json');

if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
if (!deploymentToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
if (!flagshipToken) throw new Error('ACE_FLAGSHIP_API_TOKEN is required');

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

async function ensureFlag(key, description) {
  const flags = await cloudflare(`/flagship/apps/${flagshipAppId}/flags`, {}, flagshipToken);
  const existing = Array.isArray(flags) ? flags.find((flag) => flag.key === key) : undefined;
  if (existing) return;
  await cloudflare(`/flagship/apps/${flagshipAppId}/flags`, {
    method: 'POST',
    body: JSON.stringify({
      key,
      description,
      enabled: true,
      default_variation: 'off',
      variations: { off: false, on: true },
      rules: [],
    }),
  }, flagshipToken);
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
]);

const source = await readFile(join(appDirectory, 'wrangler.jsonc'), 'utf8');
const config = parseWranglerConfig(source);
config.vars.ACCESS_APPLICATION_AUD = audience;
await writeFile(generatedConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
try {
  run('pnpm', ['build:client']);
  run('pnpm', ['exec', 'wrangler', 'deploy', '--config', generatedConfig]);
  run('pnpm', ['exec', 'wrangler', 'secret', 'put', 'CLOUDFLARE_FLAGSHIP_API_TOKEN', '--config', generatedConfig], {
    input: `${flagshipToken}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
} finally {
  await unlink(generatedConfig).catch(() => undefined);
}
