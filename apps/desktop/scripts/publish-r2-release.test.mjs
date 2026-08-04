import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

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
    assert.equal(plan.canonicalDmg, 'stable/darwin/arm64/Avalon.dmg');
    assert.equal(plan.latestManifest, 'stable/darwin/arm64/latest-mac.yml');
    assert.equal(plan.siteRelease.published, true);
    assert.equal(plan.siteRelease.objects.canonicalDmg, 'stable/darwin/arm64/Avalon.dmg');
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBytes);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
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
