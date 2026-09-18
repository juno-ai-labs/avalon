import {
  assertNextReleaseVersion,
  assertReleaseAfterMissingManifest,
  compareVersions,
  parseMacUpdateFeed,
} from './release-lib.mjs';
import { createPublishedSiteReleaseConfig } from './site-release-config.mjs';
import {
  FASTER_RELEASE_MANIFEST,
  STABLE_RELEASE_MANIFEST,
  decideStableChannelPromotion,
} from './release-channels.mjs';

export const RELEASE_PUBLICATION_RECEIPT = 'release-publication.json';

function canonicalBase64(value) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new Error('Release publication receipt manifest is not canonical base64');
  }
  return value;
}

function validatePublicationOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Release publication receipt options must be an object');
  }
  if (!Array.isArray(options.artifactNames)) {
    throw new Error('Release publication receipt artifact names are required');
  }
  // Reuse the site record's validation as the single schema authority for
  // artifact names, hashes, bucket, prefix, origin, version, and commit.
  createPublishedSiteReleaseConfig({ version: options.version }, {
    ...options,
    publishedAt: '1970-01-01T00:00:00.000Z',
  });
  return structuredClone(options);
}

export function encodePreparedReleasePublication({ manifestBytes, publicationOptions }) {
  const options = validatePublicationOptions(publicationOptions);
  const feed = parseMacUpdateFeed(manifestBytes.toString('utf8'));
  if (feed.version !== options.version) {
    throw new Error(
      `Release publication receipt manifest ${feed.version} does not match options ${options.version}`,
    );
  }
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    version: feed.version,
    manifestBase64: manifestBytes.toString('base64'),
    publicationOptions: options,
  }, null, 2)}\n`, 'utf8');
}

export function parsePreparedReleasePublication(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error('Release publication receipt has an unsupported schema');
  }
  const manifestBytes = Buffer.from(canonicalBase64(value.manifestBase64), 'base64');
  const publicationOptions = validatePublicationOptions(value.publicationOptions);
  const feed = parseMacUpdateFeed(manifestBytes.toString('utf8'));
  if (value.version !== feed.version || publicationOptions.version !== feed.version) {
    throw new Error('Release publication receipt version does not match its manifest and options');
  }
  return { manifestBytes, publicationOptions, version: feed.version };
}

function readFeed(manifestBytes, name) {
  if (!manifestBytes) return undefined;
  try {
    return parseMacUpdateFeed(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${name} is invalid`, { cause: error });
  }
}

/**
 * Validate every release pointer and the Stable receipt before the publisher
 * performs its first write. Returning a plan separates the fallible read and
 * decision phase from the deliberately resumable pointer writes.
 */
export function planReleasePointerPublication({
  candidateManifestBytes,
  currentSiteVersion,
  fasterManifestBytes,
  legacyManifestBytes,
  now,
  stableManifestBytes,
  stableReceipt,
}) {
  const candidateFeed = readFeed(candidateManifestBytes, 'Candidate manifest');
  const existingFeeds = new Map();
  const liveArtifactNames = new Set();
  let releaseIsCommitted = false;

  const legacyFeed = readFeed(legacyManifestBytes, 'Legacy manifest');
  if (legacyFeed) {
    const comparison = compareVersions(legacyFeed.version, candidateFeed.version);
    if (comparison > 0) {
      throw new Error(
        `Refusing to roll the legacy manifest back from ${legacyFeed.version} to ${candidateFeed.version}`,
      );
    }
    if (comparison < 0) assertNextReleaseVersion(legacyFeed.version, candidateFeed.version);
    if (comparison === 0 && !legacyManifestBytes.equals(candidateManifestBytes)) {
      throw new Error(`Release ${candidateFeed.version} already has different legacy manifest bytes`);
    }
    releaseIsCommitted = comparison === 0;
    for (const { url } of legacyFeed.files) liveArtifactNames.add(url);
  } else {
    assertReleaseAfterMissingManifest(currentSiteVersion, candidateFeed.version);
  }

  for (const [name, bytes] of [
    [STABLE_RELEASE_MANIFEST, stableManifestBytes],
    [FASTER_RELEASE_MANIFEST, fasterManifestBytes],
  ]) {
    const feed = readFeed(bytes, name);
    if (!feed) continue;
    if (compareVersions(feed.version, candidateFeed.version) > 0) {
      throw new Error(`Refusing to roll ${name} back from ${feed.version} to ${candidateFeed.version}`);
    }
    if (feed.version === candidateFeed.version && !bytes.equals(candidateManifestBytes)) {
      throw new Error(`Release ${candidateFeed.version} already has different ${name} bytes`);
    }
    for (const { url } of feed.files) liveArtifactNames.add(url);
    existingFeeds.set(name, feed);
  }

  const stableDecision = decideStableChannelPromotion({
    candidateVersion: candidateFeed.version,
    stableVersion: existingFeeds.get(STABLE_RELEASE_MANIFEST)?.version,
    receipt: stableReceipt,
    now,
  });
  return {
    candidateFeed,
    liveArtifactNames,
    releaseIsCommitted,
    stableDecision,
  };
}
