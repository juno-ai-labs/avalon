import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions, parseUpdateFeed, verifyFeedArtifact } from './release-lib.mjs';
import { decideStableChannelPromotion, encodeStableChannelReceipt, parseStableChannelReceipt } from './release-channels.mjs';

export const LINUX_RELEASE_PREFIX = 'stable/linux/x64';
export const linuxHash = (bytes) => createHash('sha512').update(bytes).digest('base64');

export function parseLinuxFeed(bytes) {
  const feed = parseUpdateFeed(bytes.toString('utf8'), 'latest-linux.yml');
  const names = feed.files.map((file) => file.url);
  if (names.length !== 2 || !names.includes(`Rally-${feed.version}-linux-x64.AppImage`)
    || !names.includes(`Rally-${feed.version}-linux-x64.deb`)) {
    throw new Error('Linux feed must contain exactly the versioned x64 AppImage and Debian package');
  }
  for (const file of feed.files) {
    if (Buffer.from(file.sha512, 'base64').length !== 64) throw new Error(`Invalid SHA-512 for ${file.url}`);
  }
  return feed;
}

export async function loadLinuxRelease(directory) {
  const manifestBytes = await readFile(join(directory, 'latest-linux.yml'));
  const feed = parseLinuxFeed(manifestBytes);
  await verifyFeedArtifact({ directory, feed });
  const names = (await readdir(directory)).filter((name) => /\.(?:AppImage|deb|blockmap)$/u.test(name)).sort();
  for (const name of names) {
    if (!feed.files.some((file) => name === file.url || name === `${file.url}.blockmap`)) {
      throw new Error(`Unexpected Linux artifact: ${name}`);
    }
  }
  const sums = [];
  for (const name of names) {
    sums.push(`${createHash('sha256').update(await readFile(join(directory, name))).digest('hex')}  ${name}`);
  }
  await writeFile(join(directory, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return { directory, manifestBytes, feed, names: [...names, 'SHA256SUMS'] };
}

/** The caller holds the existing R2 release lock throughout this transaction. */
export async function publishLinuxRelease({ release, commit, read, write, verifyPublic, now = Date.now }) {
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) throw new Error('Linux release commit must be a full Git SHA');
  const faster = await read('faster-linux.yml');
  const stable = await read('stable-linux.yml');
  const receiptBytes = await read('stable-channel.json');
  for (const current of [faster, stable]) {
    if (current && compareVersions(parseLinuxFeed(current).version, release.feed.version) > 0) {
      throw new Error('Refusing to roll a Linux release channel backwards');
    }
  }
  const receiptName = `Rally-${release.feed.version}-linux-x64.release.json`;
  const prior = await read(receiptName);
  const artifacts = [];
  for (const name of release.names) {
    const bytes = await readFile(join(release.directory, name));
    // Checksums are versioned too: a newer release must not mutate an old receipt.
    const key = name === 'SHA256SUMS' ? `Rally-${release.feed.version}-linux-x64.SHA256SUMS` : name;
    artifacts.push({ key, bytes, sha512: linuxHash(bytes) });
  }
  const receipt = Buffer.from(`${JSON.stringify({ version: release.feed.version, commit,
    manifest: release.manifestBytes.toString('utf8'), artifacts: artifacts.map(({ key, sha512 }) => ({ key, sha512 })) })}\n`);
  if (prior && !prior.equals(receipt)) throw new Error('Published Linux release differs; restore its exact artifacts instead of rebuilding');
  for (const artifact of artifacts) {
    const existing = await read(artifact.key);
    if (existing && !existing.equals(artifact.bytes)) throw new Error(`Immutable Linux artifact differs: ${artifact.key}`);
    if (prior && !existing) throw new Error(`Published Linux artifact is missing: ${artifact.key}`);
    if (!existing) await write(artifact.key, artifact.bytes, true);
    await verifyPublic(artifact.key, artifact.sha512);
  }
  // Commit exact artifact bytes before any channel can reference them.
  if (!prior) await write(receiptName, receipt, true);
  const decision = decideStableChannelPromotion({ candidateVersion: release.feed.version,
    stableVersion: stable ? parseLinuxFeed(stable).version : undefined,
    receipt: receiptBytes ? parseStableChannelReceipt(JSON.parse(receiptBytes.toString('utf8'))) : undefined, now: now() });
  for (const name of ['latest-linux.yml', 'faster-linux.yml']) {
    await write(name, release.manifestBytes, false);
    await verifyPublic(name, linuxHash(release.manifestBytes));
  }
  if (decision.promote) {
    await write('stable-linux.yml', release.manifestBytes, false);
    await verifyPublic('stable-linux.yml', linuxHash(release.manifestBytes));
  }
  const stableReceipt = decision.promote
    ? { version: release.feed.version, promotedAt: new Date(now()).toISOString() } : decision.receipt;
  await write('stable-channel.json', encodeStableChannelReceipt(stableReceipt), false);
  for (const extension of ['AppImage', 'deb']) {
    const artifact = artifacts.find(({ key }) => key.endsWith(`.${extension}`));
    await write(`Rally.${extension}`, artifact.bytes, false);
    await verifyPublic(`Rally.${extension}`, artifact.sha512);
  }
}
