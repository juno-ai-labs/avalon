import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxHash, loadLinuxRelease, parseLinuxFeed, publishLinuxRelease } from './linux-release.mjs';

async function fixture(t, version = '1.2.0') {
  const directory = await mkdtemp(join(tmpdir(), 'linux-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let manifest = `version: ${version}\nfiles:\n`;
  for (const extension of ['AppImage', 'deb']) {
    const name = `Rally-${version}-linux-x64.${extension}`;
    const bytes = Buffer.from(`package ${version} ${extension}`);
    await writeFile(join(directory, name), bytes);
    manifest += `  - url: ${name}\n    sha512: ${linuxHash(bytes)}\n    size: ${bytes.length}\n`;
  }
  await writeFile(join(directory, 'latest-linux.yml'), manifest);
  return loadLinuxRelease(directory);
}
function store() {
  const objects = new Map();
  const events = [];
  return { objects, events, ports: {
    commit: 'a'.repeat(40), now: () => Date.parse('2026-11-11T12:00:00Z'),
    read: async (name) => objects.get(name),
    write: async (name, bytes) => { objects.set(name, bytes); events.push(`write:${name}`); },
    verifyPublic: async (name, hash) => { assert.equal(linuxHash(objects.get(name)), hash); events.push(`verify:${name}`); },
  } };
}
test('verifies both Linux payloads before making a feed available and resumes exact publication', async (t) => {
  const release = await fixture(t);
  const { objects, events, ports } = store();
  await publishLinuxRelease({ release, ...ports });
  assert.ok(events.indexOf('verify:Rally-1.2.0-linux-x64.deb') < events.indexOf('write:faster-linux.yml'));
  assert.equal(parseLinuxFeed(objects.get('stable-linux.yml')).version, '1.2.0');
  assert.equal(objects.get('Rally.AppImage').toString(), 'package 1.2.0 AppImage');
  await publishLinuxRelease({ release, ...ports });
  await assert.rejects(publishLinuxRelease({ release, ...ports, commit: 'b'.repeat(40) }), /Published Linux release differs/);
});
test('rejects corrupt artifacts and foreign platform manifests', async (t) => {
  const release = await fixture(t);
  await writeFile(join(release.directory, 'Rally-1.2.0-linux-x64.deb'), 'corrupted');
  await assert.rejects(loadLinuxRelease(release.directory), /SHA-512 mismatch/);
  assert.throws(() => parseLinuxFeed(Buffer.from(release.manifestBytes.toString().replaceAll('linux-x64', 'mac-arm64'))), /versioned x64/);
});
test('keeps Stable pinned during the rolling day and refuses rollback', async (t) => {
  const { objects, ports } = store();
  await publishLinuxRelease({ release: await fixture(t), ...ports });
  await publishLinuxRelease({ release: await fixture(t, '1.3.0'), ...ports });
  assert.equal(parseLinuxFeed(objects.get('stable-linux.yml')).version, '1.2.0');
  assert.equal(parseLinuxFeed(objects.get('faster-linux.yml')).version, '1.3.0');
  await assert.rejects(publishLinuxRelease({ release: await fixture(t), ...ports }), /backwards/);
});
test('does not expose a release when public payload verification fails', async (t) => {
  const { objects, ports } = store();
  await assert.rejects(publishLinuxRelease({ release: await fixture(t), ...ports,
    verifyPublic: async () => { throw new Error('CDN hash mismatch'); } }), /CDN hash/);
  assert.equal(objects.has('faster-linux.yml'), false);
  assert.equal(objects.has('stable-linux.yml'), false);
});
