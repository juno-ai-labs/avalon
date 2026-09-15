import assert from 'node:assert/strict';
import test from 'node:test';

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import {
  promoteScheduledStableChannel,
  runScheduledStablePromotion,
} from './promote-stable-release.mjs';

function manifest(version, suffix = '') {
  return Buffer.from([
    `version: ${version}`,
    'files:',
    `  - url: Rally-${version}${suffix}-mac-arm64.zip`,
    '    sha512: YWJjZA==',
    '    size: 42',
    `path: Rally-${version}${suffix}-mac-arm64.zip`,
    '',
  ].join('\n'));
}

function receipt(version, promotedAt) {
  return Buffer.from(`${JSON.stringify({ version, promotedAt })}\n`);
}

function harness(overrides = {}) {
  const events = [];
  return {
    events,
    options: {
      fasterManifestBytes: manifest('1.2.0'),
      stableManifestBytes: manifest('1.1.0'),
      stableReceiptBytes: receipt('1.1.0', '2026-08-01T13:00:00.000Z'),
      now: () => Date.parse('2026-08-02T13:00:00.000Z'),
      publishStableManifest: async (bytes) => { events.push(['manifest', bytes]); },
      publishStableReceipt: async (bytes) => { events.push(['receipt', bytes]); },
      ...overrides,
    },
  };
}

test('the newest Faster release is promoted when the rolling day has elapsed', async () => {
  const times = [
    Date.parse('2026-08-02T13:00:00.000Z'),
    Date.parse('2026-08-02T13:00:05.000Z'),
  ];
  const { events, options } = harness({ now: () => times.shift() });

  const result = await promoteScheduledStableChannel(options);

  assert.deepEqual(result, {
    changed: true,
    reason: 'cooldown_elapsed',
    stableVersion: '1.2.0',
  });
  assert.equal(events[0][0], 'manifest');
  assert.ok(events[0][1].equals(options.fasterManifestBytes));
  assert.equal(events[1][0], 'receipt');
  assert.deepEqual(JSON.parse(events[1][1].toString('utf8')), {
    version: '1.2.0',
    promotedAt: '2026-08-02T13:00:05.000Z',
  });
});

test('an eligible Faster release stays pending until the full day has elapsed', async () => {
  const { events, options } = harness({
    now: () => Date.parse('2026-08-02T12:59:59.999Z'),
  });

  const result = await promoteScheduledStableChannel(options);

  assert.deepEqual(result, {
    changed: false,
    reason: 'cooldown',
    stableVersion: '1.1.0',
  });
  assert.deepEqual(events, []);
});

test('pre-channel installations are a successful no-op', async () => {
  const { events, options } = harness({
    fasterManifestBytes: undefined,
    stableManifestBytes: undefined,
    stableReceiptBytes: undefined,
  });

  assert.deepEqual(await promoteScheduledStableChannel(options), {
    changed: false,
    reason: 'channels_absent',
  });
  assert.deepEqual(events, []);
});

test('an orphan receipt without channel manifests fails closed', async () => {
  const { options } = harness({
    fasterManifestBytes: undefined,
    stableManifestBytes: undefined,
  });

  await assert.rejects(
    promoteScheduledStableChannel(options),
    /Stable channel receipt exists without Stable and Faster manifests/u,
  );
});

test('a partial channel rollout fails closed', async () => {
  const { options } = harness({ stableManifestBytes: undefined });

  await assert.rejects(
    promoteScheduledStableChannel(options),
    /Stable and Faster manifests must either both exist or both be absent/u,
  );
});

test('an interrupted receipt write is repaired without advancing Stable', async () => {
  const { events, options } = harness({
    stableReceiptBytes: receipt('1.0.0', '2026-07-31T13:00:00.000Z'),
  });

  const result = await promoteScheduledStableChannel(options);

  assert.deepEqual(result, {
    changed: true,
    reason: 'receipt_repaired',
    stableVersion: '1.1.0',
  });
  assert.deepEqual(events.map(([kind]) => kind), ['receipt']);
  assert.deepEqual(JSON.parse(events[0][1].toString('utf8')), {
    version: '1.1.0',
    promotedAt: '2026-08-02T13:00:00.000Z',
  });
});

test('equal channel versions cannot silently disagree about artifact bytes', async () => {
  const { options } = harness({
    fasterManifestBytes: manifest('1.1.0', '-different'),
  });

  await assert.rejects(
    promoteScheduledStableChannel(options),
    /Stable and Faster have different manifest bytes for Rally 1\.1\.0/u,
  );
});

test('the live adapter purges and verifies Stable before recording its promotion', async () => {
  const prefix = 'stable/darwin/arm64';
  const objects = new Map([
    [`${prefix}/stable-mac.yml`, manifest('1.1.0')],
    [`${prefix}/faster-mac.yml`, manifest('1.2.0')],
    [`${prefix}/stable-channel.json`, receipt('1.1.0', '2026-08-01T13:00:00.000Z')],
  ]);
  const events = [];
  const puts = [];
  const client = {
    async send(command) {
      if (command instanceof GetObjectCommand) {
        events.push(['get', command.input.Key]);
        const bytes = objects.get(command.input.Key);
        if (!bytes) {
          const error = new Error('missing');
          error.name = 'NoSuchKey';
          throw error;
        }
        return { Body: { transformToByteArray: async () => bytes } };
      }
      assert.ok(command instanceof PutObjectCommand);
      const bytes = Buffer.from(command.input.Body);
      events.push(['put', command.input.Key]);
      puts.push(command.input);
      objects.set(command.input.Key, bytes);
      return {};
    },
  };
  const times = [
    Date.parse('2026-08-02T13:00:00.000Z'),
    Date.parse('2026-08-02T13:00:05.000Z'),
  ];

  const result = await runScheduledStablePromotion({
    client,
    environment: {
      RALLY_RELEASE_R2_BUCKET: 'rally-releases',
      RALLY_RELEASE_PREFIX: prefix,
      RALLY_RELEASE_BASE_URL: 'https://downloads.rallywith.ai',
      CLOUDFLARE_API_TOKEN: 'test-token',
      CLOUDFLARE_ZONE_ID: 'test-zone',
    },
    fetchImplementation: async (input) => {
      const url = String(input);
      if (url.includes('/purge_cache')) {
        events.push(['purge']);
        return Response.json({ success: true, result: { id: 'purge-id' } });
      }
      events.push(['public-read']);
      return new Response(objects.get(`${prefix}/stable-mac.yml`));
    },
    now: () => times.shift(),
  });

  assert.equal(result.reason, 'cooldown_elapsed');
  assert.deepEqual(events.slice(-5), [
    ['put', `${prefix}/stable-mac.yml`],
    ['purge'],
    ['public-read'],
    ['put', `${prefix}/stable-channel.json`],
    ['get', `${prefix}/stable-channel.json`],
  ]);
  assert.equal(puts[0].CacheControl, 'public, max-age=0, must-revalidate');
  assert.equal(puts[1].CacheControl, 'no-store');
  assert.deepEqual(JSON.parse(objects.get(`${prefix}/stable-channel.json`).toString('utf8')), {
    version: '1.2.0',
    promotedAt: '2026-08-02T13:00:05.000Z',
  });
});
