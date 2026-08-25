import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  purgeAndVerifyImmutableReleaseUrls,
  purgeCloudflareUrls,
  verifyPublicReleaseArtifactHash,
} from './release-cache.mjs';

const execFileAsync = promisify(execFile);
const publisherPath = new URL('./publish-r2-release.mjs', import.meta.url);
const version = '0.1.0';

async function createFixture({ releaseVersion = version, currentVersion = releaseVersion } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-r2-publisher-test-'));
  const releaseDirectory = join(directory, 'release');
  await mkdir(releaseDirectory);
  const artifacts = {
    [`Avalon-${releaseVersion}-arm64.dmg`]: 'not-a-real-dmg',
    [`Avalon-${releaseVersion}-arm64.dmg.blockmap`]: 'dmg-blockmap',
    [`Avalon-${releaseVersion}-arm64-mac.zip`]: 'not-a-real-zip',
    [`Avalon-${releaseVersion}-arm64-mac.zip.blockmap`]: 'zip-blockmap',
  };
  await Promise.all(Object.entries(artifacts).map(([name, contents]) => (
    writeFile(join(releaseDirectory, name), contents, 'utf8')
  )));
  const zipName = `Avalon-${releaseVersion}-arm64-mac.zip`;
  const zipBytes = Buffer.from(artifacts[zipName]);
  const zipSha512 = createHash('sha512').update(zipBytes).digest('base64');
  await writeFile(join(releaseDirectory, 'latest-mac.yml'), [
    `version: ${releaseVersion}`,
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${zipSha512}`,
    `    size: ${zipBytes.length}`,
    `path: ${zipName}`,
    `sha512: ${zipSha512}`,
    '',
  ].join('\n'), 'utf8');
  const configPath = join(directory, 'release.config.json');
  const config = {
    published: false,
    version: currentVersion,
    platform: 'macOS',
    architecture: 'Apple silicon',
    downloadBaseUrl: 'https://downloads.with-avalon.com',
    bucket: 'avalon-desktop-releases',
    prefix: 'stable/darwin/arm64',
  };
  const configBytes = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, configBytes, 'utf8');
  return { directory, releaseDirectory, configPath, configBytes };
}

function environmentWithoutReleaseCredentials() {
  const environment = { ...process.env };
  for (const name of [
    'AVALON_RELEASE_R2_BUCKET',
    'AVALON_RELEASE_PREFIX',
    'AVALON_RELEASE_BASE_URL',
    'AVALON_RELEASE_PUBLISH_CONFIRM',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ZONE_ID',
  ]) delete environment[name];
  return environment;
}

test('dry-run resolves the complete release transaction without cloud access or mutations', async () => {
  const fixture = await createFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      publisherPath.pathname,
      '--dry-run',
      '--release-dir', fixture.releaseDirectory,
      '--site-config', fixture.configPath,
    ], {
      env: environmentWithoutReleaseCredentials(),
      encoding: 'utf8',
    });
    const plan = JSON.parse(stdout);
    assert.equal(plan.dryRun, true);
    assert.ok(plan.immutableObjects.includes(`stable/darwin/arm64/${version}/SHA256SUMS`));
    assert.deepEqual(plan.immutableCachePurgeUrls, [
      `https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-${version}-arm64-mac.zip`,
      `https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-${version}-arm64-mac.zip.blockmap`,
      `https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-${version}-arm64.dmg`,
      `https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-${version}-arm64.dmg.blockmap`,
      `https://downloads.with-avalon.com/stable/darwin/arm64/${version}/SHA256SUMS`,
    ]);
    assert.ok(plan.immutableCachePurgeUrls.every((url) => !url.includes('?')));
    assert.equal(plan.canonicalDmg, 'stable/darwin/arm64/Avalon.dmg');
    assert.equal(plan.latestManifest, 'stable/darwin/arm64/latest-mac.yml');
    assert.equal(plan.siteRelease.published, true);
    assert.equal(plan.siteRelease.objects.canonicalDmg, 'stable/darwin/arm64/Avalon.dmg');
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBytes);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('live publication executes the entire release transaction under the remote R2 lock', async () => {
  const source = await readFile(publisherPath, 'utf8');
  assert.match(source, /await withR2ReleaseLock\(\{/u);
  assert.match(source, /operation: executeReleaseTransaction,/u);
});

test('accepts pnpm argument separators forwarded by the root release command', async () => {
  const fixture = await createFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      publisherPath.pathname,
      '--',
      '--dry-run',
      '--release-dir', fixture.releaseDirectory,
      '--site-config', fixture.configPath,
    ], {
      env: environmentWithoutReleaseCredentials(),
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(stdout).dryRun, true);
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBytes);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('live publishing requires an exact version confirmation before cloud credentials', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        publisherPath.pathname,
        '--release-dir', fixture.releaseDirectory,
        '--site-config', fixture.configPath,
      ], {
        env: environmentWithoutReleaseCredentials(),
        encoding: 'utf8',
      }),
      (error) => String(error.stderr).includes(`Pass --confirm ${version}`),
    );
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBytes);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('dry-run rejects a release that does not advance exactly one minor version', async () => {
  const fixture = await createFixture({ currentVersion: '0.1.5', releaseVersion: '0.1.6' });
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        publisherPath.pathname,
        '--dry-run',
        '--release-dir', fixture.releaseDirectory,
        '--site-config', fixture.configPath,
      ], {
        env: environmentWithoutReleaseCredentials(),
        encoding: 'utf8',
      }),
      (error) => String(error.stderr).includes('patch 0'),
    );
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBytes);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('dry-run accepts the one-time stable promotion from 0.x to 1.0.0', async () => {
  const fixture = await createFixture({ currentVersion: '0.32.0', releaseVersion: '1.0.0' });
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      publisherPath.pathname,
      '--dry-run',
      '--release-dir', fixture.releaseDirectory,
      '--site-config', fixture.configPath,
    ], {
      env: environmentWithoutReleaseCredentials(),
      encoding: 'utf8',
    });
    const plan = JSON.parse(stdout);
    assert.equal(plan.siteRelease.version, '1.0.0');
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBytes);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('purges exact immutable URLs in one confirmed Cloudflare request', async () => {
  const urls = [
    `https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-${version}-arm64.dmg`,
    `https://downloads.with-avalon.com/stable/darwin/arm64/${version}/SHA256SUMS`,
  ];
  let request;
  await purgeCloudflareUrls({
    apiToken: 'test-api-token',
    zoneId: 'test-zone-id',
    urls,
    fetchImplementation: async (url, init) => {
      request = { url, init };
      return Response.json({
        success: true,
        errors: [],
        result: { id: 'confirmed-purge-id' },
      });
    },
  });

  assert.equal(
    request.url,
    'https://api.cloudflare.com/client/v4/zones/test-zone-id/purge_cache',
  );
  assert.equal(request.init.method, 'POST');
  assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer test-api-token');
  assert.deepEqual(JSON.parse(request.init.body), { files: urls });
});

test('fails closed and redacts Cloudflare purge failure details', async () => {
  const apiToken = 'test-api-token-must-not-leak';
  const providerDetail = 'provider-detail-must-not-leak';
  await assert.rejects(
    purgeCloudflareUrls({
      apiToken,
      zoneId: 'test-zone-id',
      urls: ['https://downloads.with-avalon.com/stable/darwin/arm64/artifact.zip'],
      fetchImplementation: async () => Response.json({
        success: false,
        errors: [{ code: 1001, message: `${providerDetail}: ${apiToken}` }],
      }, { status: 403 }),
    }),
    (error) => {
      assert.match(error.message, /could not be confirmed \(HTTP 403; codes: 1001\)/u);
      assert.ok(!error.message.includes(apiToken));
      assert.ok(!error.message.includes(providerDetail));
      return true;
    },
  );

  await assert.rejects(
    purgeCloudflareUrls({
      apiToken,
      zoneId: 'test-zone-id',
      urls: ['https://downloads.with-avalon.com/stable/darwin/arm64/artifact.zip'],
      fetchImplementation: async () => Response.json({ success: true, errors: [] }),
    }),
    /could not be confirmed/u,
  );
});

test('does not verify immutable public artifacts until their purge is confirmed', async () => {
  const artifacts = [
    { name: 'artifact.zip', url: 'https://downloads.with-avalon.com/artifact.zip' },
    { name: 'artifact.zip.blockmap', url: 'https://downloads.with-avalon.com/artifact.zip.blockmap' },
  ];
  const events = [];
  await purgeAndVerifyImmutableReleaseUrls({
    artifacts,
    purgeUrls: async (urls) => { events.push(['purge', ...urls]); },
    verifyArtifact: async ({ name }) => { events.push(['verify', name]); },
  });
  assert.deepEqual(events, [
    ['purge', ...artifacts.map(({ url }) => url)],
    ['verify', 'artifact.zip'],
    ['verify', 'artifact.zip.blockmap'],
  ]);

  let verified = false;
  await assert.rejects(
    purgeAndVerifyImmutableReleaseUrls({
      artifacts,
      purgeUrls: async () => { throw new Error('purge rejected'); },
      verifyArtifact: async () => { verified = true; },
    }),
    /purge rejected/u,
  );
  assert.equal(verified, false);
});

test('rejects stale public bytes even when their size and first byte match', async () => {
  const expected = Buffer.from('same-new');
  const stale = Buffer.from('same-old');
  assert.equal(stale.length, expected.length);
  assert.equal(stale[0], expected[0]);

  await assert.rejects(
    verifyPublicReleaseArtifactHash({
      expectedHash: createHash('sha512').update(expected).digest('base64'),
      fetchImplementation: async () => new Response(stale),
      sleepImplementation: async () => undefined,
      url: 'https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-1.147.0.dmg',
    }),
    /SHA-512 mismatch/u,
  );
});
