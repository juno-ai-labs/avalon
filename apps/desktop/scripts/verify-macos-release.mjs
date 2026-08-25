import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { assertBlockmapMatches } from './blockmap.mjs';
import { smokeLaunch } from './launch-smoke.mjs';
import {
  RALLY_APP_ID,
  RALLY_APPLE_TEAM_ID,
  loadReleaseDirectory,
  verifyFeedArtifact,
} from './release-lib.mjs';

if (process.platform !== 'darwin') throw new Error('macOS release verification must run on macOS');

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const releaseDirectory = resolve(process.argv[2] ?? join(desktopDirectory, 'release/release'));
const desktopPackage = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'));
const release = await loadReleaseDirectory(releaseDirectory);

if (release.feed.version !== desktopPackage.version) {
  throw new Error(`Feed version ${release.feed.version} does not match desktop package ${desktopPackage.version}`);
}
for (const artifact of release.artifacts) {
  if (!artifact.name.includes(desktopPackage.version)) {
    throw new Error(`Versioned release artifact does not contain ${desktopPackage.version}: ${artifact.name}`);
  }
}
await verifyFeedArtifact(release);

const zipBlockmap = `${release.zipPath}.blockmap`;
const dmgBlockmap = `${release.dmgPath}.blockmap`;
for (const requiredPath of [zipBlockmap, dmgBlockmap]) {
  if (!release.artifacts.some((artifact) => artifact.path === requiredPath)) {
    throw new Error(`Release is missing final-byte blockmap ${requiredPath}`);
  }
}

function run(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: repositoryDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    return typeof output === 'string' ? output.trim() : '';
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    throw new Error(`${command} ${args.join(' ')} failed\n${stderr || stdout}`.trim(), { cause: error });
  }
}

async function findApp(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const app = entries.find((entry) => entry.isDirectory() && entry.name === 'Rally.app');
  if (app) return join(directory, app.name);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith('.app')) continue;
    const nested = await findApp(join(directory, entry.name));
    if (nested) return nested;
  }
  return undefined;
}

function verifyBundle(appPath, source) {
  run(process.execPath, [join(desktopDirectory, 'scripts/verify-macos-app.mjs'), 'release', appPath], {
    stdio: 'inherit',
  });
  const plist = join(appPath, 'Contents/Info.plist');
  const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  if (identifier !== RALLY_APP_ID) throw new Error(`${source} has bundle identifier ${identifier}`);
  if (version !== desktopPackage.version) {
    throw new Error(`${source} has version ${version}; expected ${desktopPackage.version}`);
  }
}

function verifyDmgSignature(dmgPath) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', dmgPath]);
  const inspection = spawnSync('/usr/bin/codesign', ['-dvvv', dmgPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (inspection.status !== 0) {
    throw new Error(`Could not inspect DMG signature.\n${inspection.stderr || inspection.stdout}`.trim());
  }
  const details = `${inspection.stdout ?? ''}${inspection.stderr ?? ''}`;
  if (!details.includes('Authority=Developer ID Application:')) {
    throw new Error('DMG is not signed with a Developer ID Application certificate');
  }
  const team = details.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim();
  if (team !== RALLY_APPLE_TEAM_ID) {
    throw new Error(`DMG is signed by Apple team ${team ?? '(missing)'}; expected ${RALLY_APPLE_TEAM_ID}`);
  }
  run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
  run('/usr/sbin/spctl', [
    '-a',
    '-t',
    'open',
    '--context',
    'context:primary-signature',
    '-v',
    dmgPath,
  ]);
}

const zipDirectory = await mkdtemp(join(tmpdir(), 'rally-release-zip-'));
const dmgMount = await mkdtemp(join(tmpdir(), 'rally-release-dmg-'));
const smokeUserData = await mkdtemp(join(tmpdir(), 'rally-release-user-data-'));
let dmgAttached = false;
try {
  await Promise.all([
    assertBlockmapMatches(
      release.zipPath,
      zipBlockmap,
      join(zipDirectory, 'zip-verification.blockmap'),
    ),
    assertBlockmapMatches(
      release.dmgPath,
      dmgBlockmap,
      join(zipDirectory, 'dmg-verification.blockmap'),
    ),
  ]);

  run('/usr/bin/ditto', ['-x', '-k', release.zipPath, zipDirectory]);
  const zipApp = await findApp(zipDirectory);
  if (!zipApp) throw new Error('The update ZIP does not contain Rally.app');
  verifyBundle(zipApp, 'Update ZIP');
  await smokeLaunch(zipApp, smokeUserData);

  verifyDmgSignature(release.dmgPath);
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', dmgMount, release.dmgPath]);
  dmgAttached = true;
  const dmgApp = await findApp(dmgMount);
  if (!dmgApp) throw new Error('The DMG does not contain Rally.app');
  verifyBundle(dmgApp, 'DMG');
} finally {
  if (dmgAttached) {
    try {
      run('/usr/bin/hdiutil', ['detach', dmgMount]);
    } catch {
      run('/usr/bin/hdiutil', ['detach', '-force', dmgMount]);
    }
  }
  await Promise.all([
    rm(zipDirectory, { recursive: true, force: true }),
    rm(dmgMount, { recursive: true, force: true }),
    rm(smokeUserData, { recursive: true, force: true }),
  ]);
}

console.log(
  `Verified Rally ${desktopPackage.version} release: signed/notarized DMG, signed/notarized ZIP, clean-profile launch, and matching latest-mac.yml`,
);
