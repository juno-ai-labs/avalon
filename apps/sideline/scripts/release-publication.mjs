import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  compareVersions,
  parseMacUpdateFeed,
  sha512File,
} from '../../desktop/scripts/release-lib.mjs';

export async function publishSidelineRelease({
  bucket,
  prefix,
  publicUrl,
  purgeChannel,
  put,
  release,
  remoteSha512,
  remoteText,
  verifyPublic,
  log = console.log,
}) {
  const liveFeedText = await remoteText(`${prefix}/latest-mac.yml`);
  const liveFeed = liveFeedText ? parseMacUpdateFeed(liveFeedText) : undefined;
  if (liveFeed && compareVersions(liveFeed.version, release.feed.version) > 0) {
    throw new Error(`Refusing to replace Sideline ${liveFeed.version} with older ${release.feed.version}`);
  }

  if (liveFeed?.version === release.feed.version) {
    const localFeedText = await readFile(release.manifestPath, 'utf8');
    if (liveFeedText !== localFeedText) {
      throw new Error(`Published Sideline ${release.feed.version} does not match this build`);
    }
    await purgeChannel();
    await verifyPublic({
      expectedHash: await sha512File(release.manifestPath),
      url: publicUrl('latest-mac.yml'),
    });
    for (const file of liveFeed.files) {
      await verifyPublic({ expectedHash: file.sha512, url: publicUrl(file.url) });
    }
    const liveDmg = liveFeed.files.find((file) => file.url.endsWith('.dmg'));
    if (!liveDmg) throw new Error('Committed Sideline update feed is missing its DMG');
    await verifyPublic({ expectedHash: liveDmg.sha512, url: publicUrl('Sideline.dmg') });
    log(`Sideline ${release.feed.version} is already published; verified its committed feed`);
    return;
  }

  const versioned = [];
  for (const artifact of release.artifacts) {
    if (!artifact.name.includes(release.feed.version)) throw new Error(`Refusing unversioned artifact ${artifact.name}`);
    const key = `${prefix}/${artifact.name}`;
    const [localHash, existingHash] = await Promise.all([sha512File(artifact.path), remoteSha512(key)]);
    if (existingHash !== localHash) {
      // No live manifest names this candidate version yet, so a mismatched key
      // is debris from an interrupted attempt rather than an immutable release.
      await put(
        artifact.name,
        artifact.path,
        'public, max-age=31536000, immutable',
        `attachment; filename="${basename(artifact.name)}"`,
      );
      const r2Hash = await remoteSha512(key);
      if (r2Hash !== localHash) throw new Error(`Remote SHA-512 mismatch for r2://${bucket}/${key}`);
    }
    versioned.push({ hash: localHash, url: publicUrl(artifact.name) });
  }
  const canonicalDmg = release.artifacts.find((artifact) => artifact.name.endsWith('.dmg'));
  if (!canonicalDmg) throw new Error('Sideline release is missing its DMG');
  const dmgHash = await sha512File(canonicalDmg.path);
  const canonicalKey = `${prefix}/Sideline.dmg`;
  if (await remoteSha512(canonicalKey) !== dmgHash) {
    await put('Sideline.dmg', canonicalDmg.path, 'public, max-age=3600', 'attachment; filename="Sideline.dmg"');
  }
  const r2Hash = await remoteSha512(canonicalKey);
  if (r2Hash !== dmgHash) throw new Error(`Remote SHA-512 mismatch for r2://${bucket}/${canonicalKey}`);
  // Purge only Sideline's channel, including cached interrupted candidates,
  // then check the exact URLs the updater and recovery installer use.
  await purgeChannel();
  for (const artifact of versioned) {
    await verifyPublic({ expectedHash: artifact.hash, url: artifact.url });
  }
  await verifyPublic({ expectedHash: dmgHash, url: publicUrl('Sideline.dmg') });

  // The manifest is the commit point. Every referenced artifact and the
  // recovery installer has passed a full hash check at its exact public URL.
  await put('latest-mac.yml', release.manifestPath, 'no-cache, no-store, must-revalidate');
  await purgeChannel();
  const feedHash = await sha512File(release.manifestPath);
  await verifyPublic({ expectedHash: feedHash, url: publicUrl('latest-mac.yml') });
  log(`Published Sideline ${release.feed.version} at ${publicUrl('latest-mac.yml')}`);
}
