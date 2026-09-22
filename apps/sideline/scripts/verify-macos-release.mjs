import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { assertBlockmapMatches } from '../../desktop/scripts/blockmap.mjs';
import { RALLY_APPLE_TEAM_ID, loadReleaseDirectory, verifyFeedArtifact } from '../../desktop/scripts/release-lib.mjs';

if (process.platform !== 'darwin') throw new Error('Sideline release verification must run on macOS');

const SIDELINE_APP_ID = 'ai.rallywith.sideline';
const sidelineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(process.argv[2] ?? join(sidelineDirectory, 'release/release'));
const packageJson = JSON.parse(await readFile(join(sidelineDirectory, 'package.json'), 'utf8'));
const release = await loadReleaseDirectory(releaseDirectory);

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: sidelineDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    throw new Error(`${command} ${args.join(' ')} failed\n${stderr || stdout}`.trim(), { cause: error });
  }
}

async function findApp(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'Sideline.app') return join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith('.app')) {
      const nested = await findApp(join(directory, entry.name));
      if (nested) return nested;
    }
  }
  return undefined;
}

function signatureDetails(path) {
  const result = spawnSync('/usr/bin/codesign', ['-dvvv', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`Could not inspect ${path}\n${result.stderr || result.stdout}`.trim());
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function verifyApp(appPath, source) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
  const details = signatureDetails(appPath);
  if (!details.includes('Authority=Developer ID Application:')) throw new Error(`${source} is not Developer ID signed`);
  if (!details.includes(`TeamIdentifier=${RALLY_APPLE_TEAM_ID}`)) throw new Error(`${source} has the wrong Apple team`);
  const plist = join(appPath, 'Contents/Info.plist');
  const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  if (identifier !== SIDELINE_APP_ID) throw new Error(`${source} has bundle identifier ${identifier}`);
  if (version !== packageJson.version) throw new Error(`${source} has version ${version}`);
  const architectures = run('/usr/bin/lipo', ['-archs', join(appPath, 'Contents/MacOS/Sideline')]);
  if (architectures !== 'arm64') throw new Error(`${source} is not arm64-only`);

  const updateConfigPath = join(appPath, 'Contents/Resources/app-update.yml');
  if (!existsSync(updateConfigPath)) throw new Error(`${source} is missing app-update.yml`);
  const updateConfig = readFileSync(updateConfigPath, 'utf8');
  if ((updateConfig.match(/^provider:\s*generic\s*$/gmu) ?? []).length !== 1
    || (updateConfig.match(/^url:\s*https:\/\/downloads\.rallywith\.ai\/sideline\/stable\/darwin\/arm64\s*$/gmu) ?? []).length !== 1) {
    throw new Error(`${source} does not contain Sideline's isolated generic update feed`);
  }

  const entitlementResult = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (entitlementResult.status !== 0 || !entitlementResult.stdout?.trim()) {
    throw new Error(`${source} is missing hardened-runtime entitlements`);
  }
  const entitlementJson = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    encoding: 'utf8',
    input: entitlementResult.stdout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (entitlementJson.status !== 0) throw new Error(`${source} entitlements are unreadable`);
  const entitlements = JSON.parse(entitlementJson.stdout);
  if (entitlements['com.apple.security.cs.allow-jit'] !== true
    || entitlements['com.apple.security.network.client'] !== true
    || Object.hasOwn(entitlements, 'com.apple.security.get-task-allow')) {
    throw new Error(`${source} has unexpected hardened-runtime entitlements`);
  }
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  run('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', appPath]);
}

if (release.feed.version !== packageJson.version) {
  throw new Error(`Feed version ${release.feed.version} does not match Sideline ${packageJson.version}`);
}
await verifyFeedArtifact(release);
for (const artifact of release.artifacts) {
  if (!artifact.name.includes(packageJson.version)) throw new Error(`Unversioned Sideline artifact: ${artifact.name}`);
}

const zipBlockmap = `${release.zipPath}.blockmap`;
const dmgBlockmap = `${release.dmgPath}.blockmap`;
const zipDirectory = await mkdtemp(join(tmpdir(), 'sideline-release-zip-'));
const dmgMount = await mkdtemp(join(tmpdir(), 'sideline-release-dmg-'));
let mounted = false;
try {
  await Promise.all([
    assertBlockmapMatches(release.zipPath, zipBlockmap, join(zipDirectory, 'zip.blockmap')),
    assertBlockmapMatches(release.dmgPath, dmgBlockmap, join(zipDirectory, 'dmg.blockmap')),
  ]);
  run('/usr/bin/ditto', ['-x', '-k', release.zipPath, zipDirectory]);
  const zipApp = await findApp(zipDirectory);
  if (!zipApp) throw new Error('The Sideline update ZIP does not contain Sideline.app');
  verifyApp(zipApp, 'Update ZIP');

  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', release.dmgPath]);
  const dmgDetails = signatureDetails(release.dmgPath);
  if (!dmgDetails.includes('Authority=Developer ID Application:')
    || !dmgDetails.includes(`TeamIdentifier=${RALLY_APPLE_TEAM_ID}`)) {
    throw new Error('Sideline DMG is not signed by the expected Developer ID team');
  }
  run('/usr/bin/xcrun', ['stapler', 'validate', release.dmgPath]);
  run('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', release.dmgPath]);
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', dmgMount, release.dmgPath]);
  mounted = true;
  const dmgApp = await findApp(dmgMount);
  if (!dmgApp) throw new Error('The Sideline DMG does not contain Sideline.app');
  verifyApp(dmgApp, 'DMG');
} finally {
  if (mounted) {
    try { run('/usr/bin/hdiutil', ['detach', dmgMount]); }
    catch { run('/usr/bin/hdiutil', ['detach', '-force', dmgMount]); }
  }
  await Promise.all([
    rm(zipDirectory, { recursive: true, force: true }),
    rm(dmgMount, { recursive: true, force: true }),
  ]);
}

console.log(`Verified signed, notarized Sideline ${packageJson.version} release`);
