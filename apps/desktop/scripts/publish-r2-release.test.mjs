import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  downloadReleaseObject,
  purgeAndVerifyImmutableReleaseUrls,
  purgeCloudflareUrls,
  verifyPublicReleaseArtifactHash,
} from './release-cache.mjs';

const execFileAsync = promisify(execFile);
const publisherPath = new URL('./publish-r2-release.mjs', import.meta.url);
const version = '0.1.0';

async function createFixture({ releaseVersion = version, currentVersion = releaseVersion } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rally-r2-publisher-test-'));
  const releaseDirectory = join(directory, 'release');
  await mkdir(releaseDirectory);
  const artifacts = {
    [`Rally-${releaseVersion}-arm64.dmg`]: 'not-a-real-dmg',
    [`Rally-${releaseVersion}-arm64.dmg.blockmap`]: 'dmg-blockmap',
    [`Rally-${releaseVersion}-arm64-mac.zip`]: 'not-a-real-zip',
    [`Rally-${releaseVersion}-arm64-mac.zip.blockmap`]: 'zip-blockmap',
  };
  await Promise.all(Object.entries(artifacts).map(([name, contents]) => (
    writeFile(join(releaseDirectory, name), contents, 'utf8')
  )));
  const zipName = `Rally-${releaseVersion}-arm64-mac.zip`;
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
    downloadBaseUrl: 'https://downloads.rallywith.ai',
    bucket: 'rally-desktop-releases',
    prefix: 'stable/darwin/arm64',
  };
  const configBytes = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, configBytes, 'utf8');
  return { directory, releaseDirectory, configPath, configBytes };
}

function environmentWithoutReleaseCredentials() {
  const environment = { ...process.env };
  for (const name of [
    'RALLY_RELEASE_R2_BUCKET',
    'RALLY_RELEASE_PREFIX',
    'RALLY_RELEASE_BASE_URL',
    'RALLY_RELEASE_PUBLISH_CONFIRM',
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
      `https://downloads.rallywith.ai/stable/darwin/arm64/Rally-${version}-arm64-mac.zip`,
      `https://downloads.rallywith.ai/stable/darwin/arm64/Rally-${version}-arm64-mac.zip.blockmap`,
      `https://downloads.rallywith.ai/stable/darwin/arm64/Rally-${version}-arm64.dmg`,
      `https://downloads.rallywith.ai/stable/darwin/arm64/Rally-${version}-arm64.dmg.blockmap`,
      `https://downloads.rallywith.ai/stable/darwin/arm64/${version}/SHA256SUMS`,
    ]);
    assert.ok(plan.immutableCachePurgeUrls.every((url) => !url.includes('?')));
    assert.equal(plan.canonicalDmg, 'stable/darwin/arm64/Rally.dmg');
    assert.deepEqual(plan.channelManifests, {
      legacy: 'stable/darwin/arm64/latest-mac.yml',
      stable: 'stable/darwin/arm64/stable-mac.yml',
      faster: 'stable/darwin/arm64/faster-mac.yml',
    });
    assert.equal(plan.stableChannelReceipt, 'stable/darwin/arm64/stable-channel.json');
    assert.equal(plan.releasePublicationReceipt, 'stable/darwin/arm64/release-publication.json');
    assert.equal(plan.stablePromotionIntervalHours, 24);
    assert.equal(plan.siteRelease.published, true);
    assert.equal(plan.siteRelease.objects.canonicalDmg, 'stable/darwin/arm64/Rally.dmg');
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

test('validates all channel state and prepares exact recovery bytes before mutable writes', async () => {
  const source = await readFile(publisherPath, 'utf8');
  const planIndex = source.indexOf('const publicationPlan = planReleasePointerPublication({');
  const preparedReceiptIndex = source.indexOf('await publishPreparedPublication(', planIndex);
  const canonicalIndex = source.indexOf('await publishCanonicalDmg(', preparedReceiptIndex);
  const firstManifestIndex = source.indexOf('await publishManifest(', planIndex);

  assert.ok(planIndex > 0);
  assert.ok(preparedReceiptIndex > planIndex);
  assert.ok(canonicalIndex > preparedReceiptIndex);
  assert.ok(firstManifestIndex > preparedReceiptIndex);
  assert.match(source, /candidateManifestBytes = preparedPublication\.manifestBytes/u);
  assert.match(source, /restorePreparedPublication/u);
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
    `https://downloads.rallywith.ai/stable/darwin/arm64/Rally-${version}-arm64.dmg`,
    `https://downloads.rallywith.ai/stable/darwin/arm64/${version}/SHA256SUMS`,
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
      urls: ['https://downloads.rallywith.ai/stable/darwin/arm64/artifact.zip'],
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
      urls: ['https://downloads.rallywith.ai/stable/darwin/arm64/artifact.zip'],
      fetchImplementation: async () => Response.json({ success: true, errors: [] }),
    }),
    /could not be confirmed/u,
  );
});

test('does not verify immutable public artifacts until their purge is confirmed', async () => {
  const artifacts = [
    { name: 'artifact.zip', url: 'https://downloads.rallywith.ai/artifact.zip' },
    { name: 'artifact.zip.blockmap', url: 'https://downloads.rallywith.ai/artifact.zip.blockmap' },
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

// Drives an idle deadline from a manual clock rather than real timers, so the
// gaps between chunks stay under the timeout while their sum exceeds it.
function createManualIdleClock() {
  const clock = { elapsedMilliseconds: 0 };
  let deadline;
  clock.setIdleTimeoutImplementation = (onIdle, milliseconds) => {
    deadline = { at: clock.elapsedMilliseconds + milliseconds, onIdle };
    return deadline;
  };
  clock.clearIdleTimeoutImplementation = (handle) => {
    if (handle !== undefined && handle === deadline) deadline = undefined;
  };
  clock.advance = (milliseconds) => {
    clock.elapsedMilliseconds += milliseconds;
    if (!deadline || deadline.at > clock.elapsedMilliseconds) return;
    const { onIdle } = deadline;
    deadline = undefined;
    onIdle();
  };
  return clock;
}

function slowChunkedFetch(chunks, clock, chunkGapMilliseconds) {
  return async (_url, { signal }) => {
    let chunkIndex = 0;
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      pull(controller) {
        clock.advance(chunkGapMilliseconds);
        assert.equal(signal.aborted, false, 'idle deadline fired while bytes were still arriving');
        controller.enqueue(Buffer.from(chunks[chunkIndex]));
        chunkIndex += 1;
        if (chunkIndex === chunks.length) controller.close();
      },
    }));
  };
}

test('allows a full artifact transfer to exceed the timeout while bytes keep arriving', async () => {
  const chunks = ['first-', 'second-', 'third'];
  const expected = Buffer.from(chunks.join(''));
  const idleTimeoutMilliseconds = 200;
  const clock = createManualIdleClock();

  await verifyPublicReleaseArtifactHash({
    clearIdleTimeoutImplementation: clock.clearIdleTimeoutImplementation,
    expectedHash: createHash('sha512').update(expected).digest('base64'),
    fetchImplementation: slowChunkedFetch(chunks, clock, 75),
    idleTimeoutMilliseconds,
    setIdleTimeoutImplementation: clock.setIdleTimeoutImplementation,
    sleepImplementation: async () => undefined,
    url: 'https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-1.147.0.dmg',
  });

  assert.ok(clock.elapsedMilliseconds > idleTimeoutMilliseconds);
});

test('downloads a release object whose transfer outlasts the idle timeout while bytes keep arriving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-r2-download-test-'));
  try {
    const destination = join(directory, 'Rally-1.479.0-mac-arm64.zip');
    const idleTimeoutMilliseconds = 200;
    const clock = createManualIdleClock();

    const found = await downloadReleaseObject({
      clearIdleTimeoutImplementation: clock.clearIdleTimeoutImplementation,
      destination,
      fetchImplementation: slowChunkedFetch(['zip-', 'bytes-', 'arrive-', 'slowly'], clock, 75),
      idleTimeoutMilliseconds,
      label: 'r2://rally-desktop-releases/stable/darwin/arm64/Rally-1.479.0-mac-arm64.zip',
      setIdleTimeoutImplementation: clock.setIdleTimeoutImplementation,
      source: 'Cloudflare',
      url: 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets/b/objects/k',
    });

    assert.equal(found, true);
    assert.equal(await readFile(destination, 'utf8'), 'zip-bytes-arrive-slowly');
    assert.ok(clock.elapsedMilliseconds > idleTimeoutMilliseconds);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('aborts a release object download once bytes stop arriving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-r2-download-test-'));
  try {
    await assert.rejects(
      downloadReleaseObject({
        destination: join(directory, 'stalled.zip'),
        fetchImplementation: async (_url, { signal }) => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('first-chunk-then-nothing'));
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        })),
        idleTimeoutMilliseconds: 20,
        label: 'r2://rally-desktop-releases/stable/darwin/arm64/stalled.zip',
        source: 'Cloudflare',
        url: 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets/b/objects/k',
      }),
      { name: 'TimeoutError', message: 'No bytes arrived for 20 ms' },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('reports a missing release object without writing it', async () => {
  const found = await downloadReleaseObject({
    destination: '/nonexistent/never-written',
    fetchImplementation: async () => new Response('missing', { status: 404 }),
    label: 'r2://rally-desktop-releases/stable/darwin/arm64/absent.zip',
    source: 'Cloudflare',
    url: 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets/b/objects/k',
  });
  assert.equal(found, false);
});

test('reports a missing release object even when its body cannot be cancelled', async () => {
  const found = await downloadReleaseObject({
    destination: '/nonexistent/never-written',
    fetchImplementation: async () => new Response(new ReadableStream({
      cancel() { throw new Error('cancel failed'); },
    }), { status: 404 }),
    label: 'r2://rally-desktop-releases/stable/darwin/arm64/absent.zip',
    source: 'Cloudflare',
    url: 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets/b/objects/k',
  });
  assert.equal(found, false);
});

test('names the status of a refused download whose body cannot be read', async () => {
  await assert.rejects(
    downloadReleaseObject({
      destination: '/nonexistent/never-written',
      fetchImplementation: async () => new Response(new ReadableStream({
        pull() { throw new Error('read failed'); },
      }), { status: 503 }),
      label: 'r2://rally-desktop-releases/stable/darwin/arm64/Rally.zip',
      source: 'Cloudflare',
      url: 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets/b/objects/k',
    }),
    {
      message: 'Could not inspect r2://rally-desktop-releases/stable/darwin/arm64/Rally.zip; '
        + 'Cloudflare returned HTTP 503: unreadable response body',
    },
  );
});

test('names the object and status when a release object download is refused', async () => {
  await assert.rejects(
    downloadReleaseObject({
      destination: '/nonexistent/never-written',
      fetchImplementation: async () => new Response('bucket locked', { status: 403 }),
      label: 'r2://rally-desktop-releases/stable/darwin/arm64/Rally.zip',
      source: 'Cloudflare',
      url: 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets/b/objects/k',
    }),
    {
      message: 'Could not inspect r2://rally-desktop-releases/stable/darwin/arm64/Rally.zip; '
        + 'Cloudflare returned HTTP 403: bucket locked',
    },
  );
});

test('preserves an HTTP failure when response-body cancellation also fails', async () => {
  await assert.rejects(
    verifyPublicReleaseArtifactHash({
      expectedHash: 'unused',
      fetchImplementation: async () => new Response(new ReadableStream({
        cancel() { throw new Error('cancel failed'); },
      }), { status: 503 }),
      idleTimeoutMilliseconds: 200,
      sleepImplementation: async () => undefined,
      url: 'https://downloads.with-avalon.com/stable/darwin/arm64/Avalon-1.147.0.dmg',
    }),
    /HTTP 503/u,
  );
});
