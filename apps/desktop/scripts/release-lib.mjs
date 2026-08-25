import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const AVALON_APP_ID = 'app.avalon.desktop';
export const AVALON_APPLE_TEAM_ID = '7ZLT6A8W25';
export const DEFAULT_RELEASE_PREFIX = 'stable/darwin/arm64';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseVersion(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

export function assertMinorReleaseVersion(version) {
  const parsed = parseVersion(version);
  if (parsed.patch !== 0 || parsed.prerelease.length > 0) {
    throw new Error(`Avalon releases must use a stable minor version with patch 0; received ${version}`);
  }
  return version;
}

// The shape half of assertReleaseTag: everything that can be judged from the
// tag alone, with no checkout to compare against. The planner uses this to
// reject a malformed dispatch before a macOS runner is claimed; assertReleaseTag
// then adds the checks that need the working tree.
export function parseReleaseTag(tag) {
  if (!tag?.startsWith('v')) throw new Error(`Release tag must have the form v<semver>; received ${tag || '(empty)'}`);
  const taggedVersion = tag.slice(1);
  assertMinorReleaseVersion(taggedVersion);
  return taggedVersion;
}

export function assertReleaseTag(tag, rootVersion, desktopVersion) {
  const taggedVersion = parseReleaseTag(tag);
  if (rootVersion !== taggedVersion) {
    throw new Error(`Root package version ${rootVersion} does not match tag ${tag}`);
  }
  if (desktopVersion !== taggedVersion) {
    throw new Error(`Desktop package version ${desktopVersion} does not match tag ${tag}`);
  }
  return taggedVersion;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/u.test(aPart);
    const bNumeric = /^\d+$/u.test(bPart);
    if (aNumeric && bNumeric) return Number(aPart) < Number(bPart) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

// The version the pipeline cuts on its own. Every release advances exactly one
// minor, so this is the only successor automation ever picks: the one-time
// 0.x -> 1.0.0 stable promotion that assertNextReleaseVersion also accepts is a
// deliberate human decision and is made by hand.
export function nextReleaseVersion(currentVersion) {
  const current = parseVersion(currentVersion);
  return `${current.major}.${current.minor + 1}.0`;
}

export function assertNextReleaseVersion(currentVersion, nextVersion) {
  const current = parseVersion(currentVersion);
  assertMinorReleaseVersion(nextVersion);
  const expectedVersion = `${current.major}.${current.minor + 1}.0`;
  const stablePromotion = current.major === 0 && nextVersion === '1.0.0';
  if (nextVersion !== expectedVersion && !stablePromotion) {
    throw new Error(
      `Next Avalon release after ${currentVersion} must be ${expectedVersion}`
        + `${current.major === 0 ? ' or the one-time stable promotion 1.0.0' : ''}; received ${nextVersion}`,
    );
  }
  return nextVersion;
}

export async function reconcileImmutableReleaseObject({
  existingHash,
  localHash,
  releaseIsCommitted,
  objectLocation,
  upload,
}) {
  if (existingHash === localHash) return 'reused';
  if (existingHash !== undefined && releaseIsCommitted) {
    throw new Error(`Immutable release key ${objectLocation} already exists with different bytes`);
  }
  await upload();
  return existingHash === undefined ? 'uploaded' : 'replaced-orphan';
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseMacUpdateFeed(text) {
  const lines = text.split(/\r?\n/u);
  const versionLine = lines.find((line) => /^version:\s*/u.test(line));
  if (!versionLine) throw new Error('latest-mac.yml is missing its version');
  const version = yamlScalar(versionLine.replace(/^version:\s*/u, ''));
  parseVersion(version);

  const fileIndexes = lines
    .map((line, index) => (/^\s*-\s+url:\s*/u.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (fileIndexes.length === 0) throw new Error('latest-mac.yml is missing files[0].url');
  const files = fileIndexes.map((fileIndex, position) => {
    const url = yamlScalar(lines[fileIndex].replace(/^\s*-\s+url:\s*/u, ''));
    if (!url || /^https?:\/\//u.test(url) || url.includes('/') || url.includes('?') || url.includes('#')) {
      throw new Error(`latest-mac.yml must reference a sibling artifact filename; received ${url}`);
    }
    let sha512;
    let size;
    for (let index = fileIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*-\s+url:/u.test(line) || /^\S/u.test(line)) break;
      if (/^\s+sha512:\s*/u.test(line)) sha512 = yamlScalar(line.replace(/^\s+sha512:\s*/u, ''));
      if (/^\s+size:\s*/u.test(line)) size = Number(yamlScalar(line.replace(/^\s+size:\s*/u, '')));
    }
    if (!sha512 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(sha512)) {
      throw new Error(`latest-mac.yml is missing a valid files[${position}].sha512`);
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`latest-mac.yml is missing a valid positive files[${position}].size`);
    }
    return { url, sha512, size };
  });
  if (new Set(files.map((file) => file.url)).size !== files.length) {
    throw new Error('latest-mac.yml contains duplicate file URLs');
  }
  return { version, files, file: files[0] };
}

export async function sha512File(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}

export async function loadReleaseDirectory(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const manifestNames = names.filter((name) => name === 'latest-mac.yml');
  if (manifestNames.length !== 1) {
    throw new Error(`Expected exactly one latest-mac.yml in ${directory}; found ${manifestNames.length}`);
  }
  const manifestPath = join(directory, manifestNames[0]);
  const manifestBytes = await readFile(manifestPath);
  const feed = parseMacUpdateFeed(manifestBytes.toString('utf8'));
  const artifactNames = names.filter((name) => /\.(?:dmg|zip|blockmap)$/u.test(name));
  for (const file of feed.files) {
    if (!artifactNames.includes(file.url)) {
      throw new Error(`Update feed references missing artifact ${file.url}`);
    }
  }
  const zipNames = artifactNames.filter((name) => name.endsWith('.zip'));
  const dmgNames = artifactNames.filter((name) => name.endsWith('.dmg'));
  if (zipNames.length !== 1 || dmgNames.length !== 1) {
    throw new Error(`Expected one ZIP and one DMG; found ${zipNames.length} ZIP and ${dmgNames.length} DMG`);
  }
  return {
    directory,
    manifestPath,
    manifestBytes,
    feed,
    artifacts: artifactNames.map((name) => ({ name, path: join(directory, name) })),
    zipPath: join(directory, zipNames[0]),
    dmgPath: join(directory, dmgNames[0]),
  };
}

export async function verifyFeedArtifact(release) {
  for (const file of release.feed.files) {
    const artifactPath = join(release.directory, file.url);
    const [actualSha512, metadata] = await Promise.all([sha512File(artifactPath), stat(artifactPath)]);
    if (actualSha512 !== file.sha512) {
      throw new Error(`SHA-512 mismatch for ${basename(artifactPath)}`);
    }
    if (metadata.size !== file.size) {
      throw new Error(`Size mismatch for ${basename(artifactPath)}: feed=${file.size}, actual=${metadata.size}`);
    }
  }
}

export function normalizeReleasePrefix(prefix = DEFAULT_RELEASE_PREFIX) {
  const normalized = prefix.replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error(`Invalid release prefix: ${prefix}`);
  }
  return normalized;
}

export function releaseContentType(name) {
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.yml')) return 'application/yaml; charset=utf-8';
  return 'application/octet-stream';
}
