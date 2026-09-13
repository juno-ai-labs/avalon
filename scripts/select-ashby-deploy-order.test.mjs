import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { activeEntrypoints, selectAshbyDeployOrder } from './select-ashby-deploy-order.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const [globalConfig, euConfig] = await Promise.all(['global', 'eu'].map(async (region) =>
  parseWranglerConfig(await readFile(new URL(`../apps/api/wrangler.${region}.jsonc`, import.meta.url), 'utf8'))));
const euNames = globalConfig.services.filter((binding) => binding.service === euConfig.name).map((binding) => binding.entrypoint);

function provider({ ready = false, split = false, badStatus, missingCatalog = false, missingEu = false } = {}) {
  const calls = [];
  const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'test-token' };
  async function fetchImpl(url, options) {
    calls.push(url);
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/'));
    if (badStatus) return Response.json({ success: false }, { status: badStatus });
    const eu = url.includes('/avalon-api-eu/');
    if (url.endsWith('/deployments')) return Response.json({ success: true, result: { deployments: [
      { created_on: '2026-09-11T00:00:00Z', versions: [{ version_id: 'old', percentage: 100 }] },
      { created_on: '2026-09-13T00:00:00Z', versions: split && !eu
        ? [{ version_id: 'current', percentage: 50 }, { version_id: 'old', percentage: 50 }]
        : [{ version_id: 'current', percentage: 100 }] },
    ] } });
    const names = eu ? (missingEu ? [] : euNames) : ready && url.endsWith('/current') ? ['AshbyRoutingBridge'] : [];
    return Response.json({ success: true, result: { resources: { script: missingCatalog ? {} : {
      named_handlers: names.map((name) => ({ name, handlers: ['fetch'] })),
    } } } });
  }
  return { calls, readEntrypoints: (name) => activeEntrypoints(name, { environment, fetchImpl }) };
}

const select = (remote, options = {}) => selectAshbyDeployOrder({
  deployEu: true, deployGlobal: true, globalConfig, euConfig, ...remote, ...options,
});

test('first rollout requires Global first only after proving its existing EU dependencies', async () => {
  const remote = provider();
  assert.deepEqual(await select(remote), { bootstrapGlobal: true });
  assert.ok(remote.calls.some((url) => url.includes('/avalon-api-eu/versions/current')));
});

test('later releases and a retry after successful Global bootstrap retain EU-first order', async () => {
  const remote = provider({ ready: true });
  assert.deepEqual(await select(remote), { bootstrapGlobal: false });
  assert.equal(remote.calls.length, 2);
  assert.ok(remote.calls[1].endsWith('/versions/current'), 'inspect active traffic, not old deployment or newest upload');
});

test('one old serving version in split traffic still requires bootstrap', async () => {
  assert.deepEqual(await select(provider({ ready: true, split: true })), { bootstrapGlobal: true });
});

test('EU-only first rollout refuses to deploy unselected Global; Global-only needs no bootstrap', async () => {
  await assert.rejects(select(provider(), { deployGlobal: false }), /select eu-and-global/u);
  assert.deepEqual(await select(provider({ ready: true }), { deployGlobal: false }), { bootstrapGlobal: false });
  const remote = provider();
  assert.deepEqual(await select(remote, { deployEu: false }), { bootstrapGlobal: false });
  assert.equal(remote.calls.length, 0);
});

test('a dependency cycle stops the release instead of trying either caller first', async () => {
  await assert.rejects(select(provider({ missingEu: true })), /Cannot bootstrap Global: EU does not yet export/u);
});

test('unavailable control plane and unknown export metadata fail rather than choose an order', async () => {
  for (const badStatus of [403, 404, 500]) {
    await assert.rejects(select(provider({ badStatus })), new RegExp(`HTTP ${badStatus}`, 'u'));
  }
  await assert.rejects(select(provider({ missingCatalog: true })), /Cannot inspect named entrypoints/u);
  for (const result of [{}, { deployments: [] }, { deployments: [{ created_on: 'bad' }] },
    { deployments: [{ created_on: '2026-09-13', versions: [] }] }]) {
    await assert.rejects(activeEntrypoints('worker', {
      environment: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'test-token' },
      fetchImpl: async () => Response.json({ success: true, result }),
    }), /Cannot determine/u);
  }
});
