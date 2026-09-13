import { readFile } from 'node:fs/promises';
import { isEntryPoint } from './entry-point.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

// Read active deployments, not the newest uploaded (possibly unpromoted) version.
// Cloudflare documents named_handlers in the Get Version Detail response.
export async function activeEntrypoints(script, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const account = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('Cloudflare deployment credentials are required');
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(script)}`;
  async function get(path) {
    const response = await fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true || !body.result) {
      throw new Error(`Cannot inspect ${script} ${path}: HTTP ${response.status}`);
    }
    return body.result;
  }
  const { deployments } = await get('/deployments');
  if (!Array.isArray(deployments) || deployments.length === 0
    || deployments.some((deployment) => !Number.isFinite(Date.parse(deployment.created_on)))) {
    throw new Error(`Cannot determine the active deployment of ${script}`);
  }
  const [current] = deployments.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  const versions = current.versions;
  if (!Array.isArray(versions) || versions.length === 0
    || versions.some((version) => typeof version.version_id !== 'string' || !version.version_id
      || !Number.isFinite(version.percentage) || version.percentage <= 0)
    || Math.abs(versions.reduce((total, version) => total + version.percentage, 0) - 100) > Number.EPSILON * 100) {
    throw new Error(`Cannot determine active version traffic for ${script}`);
  }
  const exported = [];
  for (const version of versions) {
    const detail = await get(`/versions/${encodeURIComponent(version.version_id)}`);
    const handlers = detail.resources?.script?.named_handlers;
    if (!Array.isArray(handlers) || handlers.some((handler) => typeof handler.name !== 'string')) {
      throw new Error(`Cannot inspect named entrypoints of ${script} version ${version.version_id}`);
    }
    exported.push(new Set(handlers.map((handler) => handler.name)));
  }
  // A split deployment is ready only if every serving version exports the target.
  return new Set([...exported[0]].filter((name) => exported.every((names) => names.has(name))));
}

export async function selectAshbyDeployOrder({
  deployEu,
  deployGlobal,
  globalConfig,
  euConfig,
  readEntrypoints = activeEntrypoints,
}) {
  if (!deployEu) return { bootstrapGlobal: false };
  const globalExports = await readEntrypoints(globalConfig.name);
  if (globalExports.has('AshbyRoutingBridge')) return { bootstrapGlobal: false };
  if (!deployGlobal) {
    throw new Error('Global does not yet export AshbyRoutingBridge; select eu-and-global for the first Ashby rollout');
  }
  // Global already calls EU. Never reverse the order if this revision introduces
  // another missing target in that direction too; that would be a dependency cycle.
  const euExports = await readEntrypoints(euConfig.name);
  for (const binding of globalConfig.services ?? []) {
    if (binding.service === euConfig.name && binding.entrypoint && !euExports.has(binding.entrypoint)) {
      throw new Error(`Cannot bootstrap Global: EU does not yet export ${binding.entrypoint}`);
    }
  }
  return { bootstrapGlobal: true };
}

if (isEntryPoint(import.meta.url)) {
  try {
    const [globalConfig, euConfig] = await Promise.all(['global', 'eu'].map(async (region) =>
      parseWranglerConfig(await readFile(`apps/api/wrangler.${region}.jsonc`, 'utf8'))));
    const argv = process.argv.slice(2);
    if (argv.length === 1 && argv[0] === '--require-global-router') {
      if (!(await activeEntrypoints(globalConfig.name)).has('AshbyRoutingBridge')) {
        throw new Error('Global deployment has not established AshbyRoutingBridge; EU deployment stopped');
      }
    } else {
      if (argv.length) throw new Error(`Unknown argument: ${argv[0]}`);
      const order = await selectAshbyDeployOrder({
        deployEu: process.env.DEPLOY_EU === 'true',
        deployGlobal: process.env.DEPLOY_GLOBAL === 'true',
        globalConfig,
        euConfig,
      });
      console.log(JSON.stringify(order));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
