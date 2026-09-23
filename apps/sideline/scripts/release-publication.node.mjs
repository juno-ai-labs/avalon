import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadReleaseDirectory, verifyFeedArtifact } from '../../desktop/scripts/release-lib.mjs';
import { publishSidelineRelease } from './release-publication.mjs';

const prefix = 'sideline/stable/darwin/arm64';
const origin = `https://downloads.rallywith.ai/${prefix}/`;
const version = '0.1.4';
const dmgName = `Sideline-${version}-mac-arm64.dmg`;
const zipName = `Sideline-${version}-mac-arm64.zip`;

function hash(bytes) {
  return createHash('sha512').update(bytes).digest('base64');
}

async function fixture({ committedDifferentManifest = false, staleCanonical = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sideline-publication-'));
  const files = new Map([
    [dmgName, Buffer.from('selected signed dmg')],
    [`${dmgName}.blockmap`, Buffer.from('selected dmg blockmap')],
    [zipName, Buffer.from('selected signed zip')],
    [`${zipName}.blockmap`, Buffer.from('selected zip blockmap')],
  ]);
  const manifest = [
    `version: "${version}"`,
    'files:',
    `  - url: "${zipName}"`,
    `    sha512: "${hash(files.get(zipName))}"`,
    `    size: ${files.get(zipName).length}`,
    `  - url: "${dmgName}"`,
    `    sha512: "${hash(files.get(dmgName))}"`,
    `    size: ${files.get(dmgName).length}`,
    `path: "${zipName}"`,
    `sha512: "${hash(files.get(zipName))}"`,
    '',
  ].join('\n');
  await Promise.all([...files].map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  await writeFile(join(directory, 'latest-mac.yml'), manifest);
  const release = await loadReleaseDirectory(directory);
  await verifyFeedArtifact(release);

  const oldManifest = committedDifferentManifest
    ? `${manifest}# a different committed feed\n`
    : 'version: "0.1.3"\nfiles:\n  - url: "Sideline-0.1.3-mac-arm64.zip"\n    sha512: "YWJj"\n    size: 3\n';
  const r2 = new Map([
    [`${prefix}/latest-mac.yml`, Buffer.from(oldManifest)],
    [`${prefix}/${dmgName}`, Buffer.from('interrupted candidate dmg')],
    [`${prefix}/Sideline.dmg`, Buffer.from('old recovery installer')],
  ]);
  const publicCache = new Map(r2);
  const events = [];
  const put = async (name, path) => {
    events.push(`put:${name}`);
    r2.set(`${prefix}/${name}`, await readFile(path));
  };
  const purgeChannel = async () => {
    events.push('purge');
    for (const [key, bytes] of r2) {
      if (staleCanonical && key === `${prefix}/Sideline.dmg`) continue;
      publicCache.set(key, bytes);
    }
  };
  const verifyPublic = async ({ expectedHash, url }) => {
    const name = url.slice(origin.length);
    events.push(`verify:${name}`);
    const bytes = publicCache.get(`${prefix}/${name}`);
    if (!bytes || hash(bytes) !== expectedHash) throw new Error(`Public SHA-512 mismatch: ${name}`);
  };
  return {
    directory,
    events,
    manifest,
    r2,
    run: () => publishSidelineRelease({
      bucket: 'avalon-desktop-releases',
      prefix,
      publicUrl: (name) => `${origin}${name}`,
      purgeChannel,
      put,
      release,
      remoteSha512: async (key) => r2.has(key) ? hash(r2.get(key)) : undefined,
      remoteText: async (key) => r2.get(key)?.toString('utf8'),
      verifyPublic,
      log: () => {},
    }),
  };
}

test('reconciles interrupted candidate bytes and verifies public URLs before committing the feed', async () => {
  const testFixture = await fixture();
  try {
    await testFixture.run();
    const feedWrite = testFixture.events.indexOf('put:latest-mac.yml');
    assert.ok(feedWrite > 0);
    assert.ok(testFixture.events.indexOf(`put:${dmgName}`) < feedWrite);
    assert.ok(testFixture.events.indexOf('put:Sideline.dmg') < feedWrite);
    for (const name of [dmgName, `${dmgName}.blockmap`, zipName, `${zipName}.blockmap`, 'Sideline.dmg']) {
      const verification = testFixture.events.indexOf(`verify:${name}`);
      assert.ok(verification > testFixture.events.indexOf('purge'));
      assert.ok(verification < feedWrite, `${name} must be publicly verified before feed commit`);
    }
    assert.ok(testFixture.events.indexOf('verify:latest-mac.yml') > feedWrite);
    assert.equal(testFixture.r2.get(`${prefix}/latest-mac.yml`).toString('utf8'), testFixture.manifest);
  } finally {
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test('a stale exact public installer blocks the manifest commit', async () => {
  const testFixture = await fixture({ staleCanonical: true });
  try {
    await assert.rejects(testFixture.run(), /Public SHA-512 mismatch: Sideline\.dmg/u);
    assert.ok(!testFixture.events.includes('put:latest-mac.yml'));
    assert.match(testFixture.r2.get(`${prefix}/latest-mac.yml`).toString('utf8'), /version: "0\.1\.3"/u);
  } finally {
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test('a same-version retry rejects a different committed manifest', async () => {
  const testFixture = await fixture({ committedDifferentManifest: true });
  try {
    await assert.rejects(testFixture.run(), /does not match this build/u);
    assert.deepEqual(testFixture.events, []);
  } finally {
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});
