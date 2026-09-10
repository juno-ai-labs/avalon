import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkRequiredR2Buckets,
  configuredR2Buckets,
} from './check-cloudflare-r2-buckets.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token',
};

test('the hosted-resource inventory comes from both regional Wrangler files', async () => {
  const buckets = await configuredR2Buckets();

  assert.deepEqual(buckets, [
    { region: 'global', binding: 'DESKTOP_RELEASES', name: 'avalon-desktop-releases', jurisdiction: 'default' },
    { region: 'global', binding: 'PAYLOADS', name: 'avalon-global-payloads', jurisdiction: 'default' },
    { region: 'global', binding: 'TELEMETRY_PAYLOADS', name: 'avalon-global-telemetry', jurisdiction: 'default' },
    { region: 'eu', binding: 'PAYLOADS', name: 'avalon-eu-payloads', jurisdiction: 'eu' },
    { region: 'eu', binding: 'TELEMETRY_PAYLOADS', name: 'avalon-eu-telemetry', jurisdiction: 'eu' },
  ]);
});

test('checks and logs every configured bucket with its regional jurisdiction', async () => {
  const calls = [];
  const lines = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({
      name: url.pathname.split('/').at(-1),
      jurisdiction: new Headers(init.headers).get('cf-r2-jurisdiction'),
    });
    return Response.json({ success: true, result: { name: url.pathname.split('/').at(-1) } });
  };

  await checkRequiredR2Buckets({ environment, fetchImpl, log: (line) => lines.push(line) });

  assert.deepEqual(calls, [
    { name: 'avalon-desktop-releases', jurisdiction: null },
    { name: 'avalon-global-payloads', jurisdiction: null },
    { name: 'avalon-global-telemetry', jurisdiction: null },
    { name: 'avalon-eu-payloads', jurisdiction: 'eu' },
    { name: 'avalon-eu-telemetry', jurisdiction: 'eu' },
  ]);
  assert.equal(lines.length, 5);
  assert.match(lines.at(-1), /eu\/TELEMETRY_PAYLOADS.*avalon-eu-telemetry.*eu/u);
});

test('fails before deployment when a configured R2 bucket does not exist', async () => {
  const fetchImpl = async (input) => {
    const name = new URL(input).pathname.split('/').at(-1);
    return name === 'avalon-eu-telemetry'
      ? Response.json({ success: false }, { status: 404 })
      : Response.json({ success: true, result: { name } });
  };

  await assert.rejects(
    checkRequiredR2Buckets({ environment, fetchImpl, log: () => undefined }),
    /eu\/TELEMETRY_PAYLOADS.*avalon-eu-telemetry.*HTTP 404/u,
  );
});

test('the API deployment checks hosted R2 resources before remote mutations', async () => {
  const workflow = await readFile(join(repositoryDirectory, '.github/workflows/deploy-api.yml'), 'utf8');
  const resourceGate = workflow.indexOf('node scripts/check-cloudflare-r2-buckets.mjs');
  const firstMigration = workflow.indexOf('- name: List the pending remote migrations for EU');

  assert.notEqual(resourceGate, -1, 'API deploy must verify configured R2 buckets');
  assert.ok(resourceGate < firstMigration, 'R2 resource verification must precede remote migrations');
});
