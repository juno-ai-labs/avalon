import { compareVersions, parseVersion } from './release-lib.mjs';

export const LEGACY_RELEASE_MANIFEST = 'latest-mac.yml';
export const STABLE_RELEASE_MANIFEST = 'stable-mac.yml';
export const FASTER_RELEASE_MANIFEST = 'faster-mac.yml';
export const STABLE_CHANNEL_RECEIPT = 'stable-channel.json';
export const STABLE_PROMOTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function parseStableChannelReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stable channel receipt must be an object');
  }
  const version = value.version;
  const promotedAt = value.promotedAt;
  if (typeof version !== 'string') throw new Error('Stable channel receipt version is required');
  parseVersion(version);
  if (typeof promotedAt !== 'string' || !Number.isFinite(Date.parse(promotedAt))) {
    throw new Error('Stable channel receipt promotion timestamp is invalid');
  }
  return { version, promotedAt };
}

/**
 * Stable's manifest is the release authority; the receipt only remembers when
 * that pointer moved. A missing/stale receipt is repaired conservatively at
 * `now`, which delays the next promotion instead of allowing two inside a day.
 */
export function decideStableChannelPromotion({ candidateVersion, stableVersion, receipt, now }) {
  const promotedAt = new Date(now).toISOString();
  if (!stableVersion) {
    if (receipt) throw new Error('Stable channel receipt exists without a stable manifest');
    return { promote: true, receipt: { version: candidateVersion, promotedAt }, reason: 'bootstrap' };
  }

  const comparison = compareVersions(stableVersion, candidateVersion);
  if (comparison > 0) {
    throw new Error(`Refusing to roll Stable back from ${stableVersion} to ${candidateVersion}`);
  }
  if (receipt && compareVersions(receipt.version, stableVersion) > 0) {
    throw new Error(`Stable channel receipt ${receipt.version} is ahead of manifest ${stableVersion}`);
  }
  if (!receipt || receipt.version !== stableVersion) {
    return {
      promote: false,
      receipt: { version: stableVersion, promotedAt },
      reason: 'receipt_repaired',
    };
  }
  if (comparison === 0) {
    return { promote: false, receipt, reason: 'already_promoted' };
  }

  const elapsed = now - Date.parse(receipt.promotedAt);
  if (elapsed < STABLE_PROMOTION_INTERVAL_MS) {
    return { promote: false, receipt, reason: 'cooldown' };
  }
  return { promote: true, receipt: { version: candidateVersion, promotedAt }, reason: 'cooldown_elapsed' };
}

export function encodeStableChannelReceipt(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}
