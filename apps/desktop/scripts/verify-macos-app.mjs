import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RALLY_APPLE_TEAM_ID } from './release-lib.mjs';
import {
  assertDeveloperIdDetails,
  assertEmbeddedUpdateConfig,
  assertExactNestedEntitlements,
} from './mac-signature-policy.mjs';

const [mode = 'local', appArgument] = process.argv.slice(2);
if (!['local', 'release'].includes(mode) || !appArgument) {
  throw new Error('Usage: node verify-macos-app.mjs <local|release> <path-to-app>');
}

const appPath = resolve(appArgument);
if (!existsSync(appPath)) throw new Error(`Rally app bundle not found: ${appPath}`);

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runWithStderr(command, args) {
  try {
    return run(command, args);
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    throw new Error(`${command} ${args.join(' ')} failed\n${stderr || stdout}`.trim(), { cause: error });
  }
}

runWithStderr('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);

const displayResult = spawnSync('/usr/bin/codesign', ['-dvvv', appPath], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (displayResult.status !== 0) {
  throw new Error(`Could not inspect the packaged signature.\n${displayResult.stderr || displayResult.stdout}`.trim());
}
// `codesign -d` writes its successful result to stderr.
const details = `${displayResult.stdout ?? ''}${displayResult.stderr ?? ''}`;

for (const requirement of [
  ['Identifier=ai.rallywith.desktop', 'the Rally bundle identifier'],
  ['Info.plist entries=', 'a bound Info.plist'],
  ['Sealed Resources version=', 'sealed application resources'],
]) {
  if (!details.includes(requirement[0])) {
    throw new Error(`Packaged app is missing ${requirement[1]}. codesign reported:\n${details}`);
  }
}
if (details.includes('flags=0x20002(adhoc,linker-signed)')) {
  throw new Error('Packaged app has only the Electron executable linker signature.');
}
assertDeveloperIdDetails(details, RALLY_APPLE_TEAM_ID, 'Packaged app');

function verifyArm64(executablePath, label) {
  if (!existsSync(executablePath)) throw new Error(`Packaged app is missing ${label} executable`);
  const architectures = runWithStderr('/usr/bin/lipo', ['-archs', executablePath]).trim();
  if (architectures !== 'arm64') {
    throw new Error(`${label} must contain exactly arm64; lipo reported ${architectures || '(none)'}`);
  }
}

const mainExecutable = join(appPath, 'Contents/MacOS/Rally');
runWithStderr('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', mainExecutable]);
verifyArm64(mainExecutable, 'Rally');

const resourcesDirectory = join(appPath, 'Contents/Resources');
const infoPlistPath = join(appPath, 'Contents/Info.plist');
const iconName = runWithStderr('/usr/bin/plutil', [
  '-extract',
  'CFBundleIconName',
  'raw',
  infoPlistPath,
]).trim();
if (iconName !== 'Icon') {
  throw new Error(`Packaged app must select the Icon Composer asset catalog; found ${iconName || '(none)'}`);
}
const dockTilePluginName = runWithStderr('/usr/bin/plutil', [
  '-extract',
  'NSDockTilePlugIn',
  'raw',
  infoPlistPath,
]).trim();
if (dockTilePluginName !== 'RallyDockTilePlugin.docktileplugin') {
  throw new Error(`Packaged app must declare the Rally Dock tile plugin; found ${dockTilePluginName || '(none)'}`);
}

const legacyIconPath = join(resourcesDirectory, 'icon.icns');
if (!existsSync(legacyIconPath)) throw new Error('Packaged app is missing its generated ICNS fallback');
if (readFileSync(legacyIconPath).subarray(0, 4).toString('ascii') !== 'icns') {
  throw new Error('Packaged icon fallback is not an ICNS file');
}

const assetCatalogPath = join(resourcesDirectory, 'Assets.car');
if (!existsSync(assetCatalogPath)) throw new Error('Packaged app is missing its Icon Composer asset catalog');
const assetCatalog = JSON.parse(runWithStderr('/usr/bin/assetutil', ['--info', assetCatalogPath]));
if (!Array.isArray(assetCatalog) || !assetCatalog.some((asset) => asset?.AssetType === 'Icon Image')) {
  throw new Error('Packaged Icon Composer asset catalog contains no icon renditions');
}
const iconStackAppearances = new Set(
  assetCatalog
    .filter((asset) => asset?.AssetType === 'IconImageStack' && asset?.Name === 'Icon')
    .map((asset) => asset.Appearance),
);
for (const appearance of ['NSAppearanceNameAqua', 'NSAppearanceNameDarkAqua', 'ISAppearanceTintable']) {
  if (!iconStackAppearances.has(appearance)) {
    throw new Error(`Packaged Icon Composer asset catalog is missing ${appearance}`);
  }
}

const applicationIconNames = [
  'light',
  'dark',
  'calm',
  'ludicrous-speed',
  'homage',
  'builder',
  'quiet',
];
const applicationIconDirectory = join(resourcesDirectory, 'app-icons');
const expectedApplicationIconFiles = new Set(applicationIconNames.map((name) => `${name}.icns`));
for (const fileName of readdirSync(applicationIconDirectory)) {
  if (!expectedApplicationIconFiles.has(fileName)) {
    throw new Error(`Packaged app contains unexpected selectable icon resource ${fileName}`);
  }
}
for (const name of applicationIconNames) {
  const iconPath = join(applicationIconDirectory, `${name}.icns`);
  if (!existsSync(iconPath)) throw new Error(`Packaged app is missing selectable icon ${name}`);
  const icon = readFileSync(iconPath);
  if (icon.subarray(0, 4).toString('ascii') !== 'icns') {
    throw new Error(`Selectable icon ${name} is not an ICNS file compiled by actool`);
  }
}
const nativeIconScriptPath = join(resourcesDirectory, 'native/set-application-icon.js');
if (!existsSync(nativeIconScriptPath)) throw new Error('Packaged app is missing its native application-icon bridge');

// The Retina rendition is resolved by name at runtime rather than referenced in
// code, so a bundle missing it fails nowhere until someone looks at the menu bar
// on a Retina Mac and sees a blurred mark.
for (const fileName of ['rallyTemplate.png', 'rallyTemplate@2x.png']) {
  const menuBarIconPath = join(resourcesDirectory, 'menu-bar', fileName);
  if (!existsSync(menuBarIconPath)) {
    throw new Error(`Packaged app is missing its menu bar icon ${fileName}`);
  }
}

function inspectEntitlementKeys(componentPath, label, { allowEmpty = false } = {}) {
  const entitlementResult = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', componentPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (entitlementResult.status !== 0) {
    throw new Error(
      `Could not inspect ${label} entitlements.\n${entitlementResult.stderr || entitlementResult.stdout}`.trim(),
    );
  }
  if (!entitlementResult.stdout?.trim()) {
    if (allowEmpty) return [];
    throw new Error(`${label} is missing its required entitlements`);
  }
  const plistResult = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    encoding: 'utf8',
    input: entitlementResult.stdout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (plistResult.status !== 0) {
    throw new Error(`Could not parse ${label} entitlements.\n${plistResult.stderr || plistResult.stdout}`.trim());
  }
  const parsed = JSON.parse(plistResult.stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} entitlements are not a dictionary`);
  }
  return Object.keys(parsed);
}

function verifyNestedComponent(componentPath, executablePath, label, { expectEntitlements = true } = {}) {
  if (!existsSync(componentPath)) throw new Error(`Packaged app is missing nested component ${label}`);
  runWithStderr('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', componentPath]);
  const display = spawnSync('/usr/bin/codesign', ['-dvvv', componentPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (display.status !== 0) {
    throw new Error(`Could not inspect ${label}.\n${display.stderr || display.stdout}`.trim());
  }
  const componentDetails = `${display.stdout ?? ''}${display.stderr ?? ''}`;
  assertDeveloperIdDetails(componentDetails, RALLY_APPLE_TEAM_ID, label);
  if (expectEntitlements) {
    assertExactNestedEntitlements(inspectEntitlementKeys(componentPath, label), label);
  } else {
    const entitlementKeys = inspectEntitlementKeys(componentPath, label, { allowEmpty: true });
    if (entitlementKeys.length > 0) {
      throw new Error(`${label} must not carry entitlements; found ${entitlementKeys.join(', ')}`);
    }
  }
  verifyArm64(executablePath, label);
}

const helperDirectory = join(appPath, 'Contents/Frameworks');
const expectedHelpers = new Set([
  'Rally Helper.app',
  'Rally Helper (GPU).app',
  'Rally Helper (Plugin).app',
  'Rally Helper (Renderer).app',
]);
const helperNames = readdirSync(helperDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('Rally Helper') && entry.name.endsWith('.app'))
  .map((entry) => entry.name)
  .sort();
for (const expected of expectedHelpers) {
  if (!helperNames.includes(expected)) throw new Error(`Packaged app is missing nested helper ${expected}`);
}
for (const helperName of helperNames) {
  if (!expectedHelpers.has(helperName)) throw new Error(`Packaged app contains unexpected nested helper ${helperName}`);
  const helperPath = join(helperDirectory, helperName);
  verifyNestedComponent(
    helperPath,
    join(helperPath, 'Contents/MacOS', helperName.replace(/\.app$/u, '')),
    helperName,
  );
}

const shipItPath = join(helperDirectory, 'Squirrel.framework/Versions/A/Resources/ShipIt');
verifyNestedComponent(shipItPath, shipItPath, 'Squirrel ShipIt');
const crashpadPath = join(
  helperDirectory,
  'Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
);
verifyNestedComponent(crashpadPath, crashpadPath, 'Electron chrome_crashpad_handler');

const dockTilePluginPath = join(
  appPath,
  'Contents/PlugIns/RallyDockTilePlugin.docktileplugin',
);
verifyNestedComponent(
  dockTilePluginPath,
  join(dockTilePluginPath, 'Contents/MacOS/RallyDockTilePlugin'),
  'Rally Dock tile plugin',
  { expectEntitlements: false },
);
const systemAudioTapPath = join(resourcesDirectory, 'native/system-audio-tap.node');
verifyNestedComponent(
  systemAudioTapPath,
  systemAudioTapPath,
  'Rally Core Audio tap',
  { expectEntitlements: false },
);
const unifiedLogPath = join(resourcesDirectory, 'native/unified-log.node');
verifyNestedComponent(
  unifiedLogPath,
  unifiedLogPath,
  'Rally unified-log bridge',
  { expectEntitlements: false },
);

if (mode === 'release') {
  const updateConfigPath = join(appPath, 'Contents/Resources/app-update.yml');
  if (!existsSync(updateConfigPath)) throw new Error('Packaged release is missing embedded app-update.yml');
  assertEmbeddedUpdateConfig(readFileSync(updateConfigPath, 'utf8'));
  runWithStderr('/usr/sbin/spctl', ['-a', '-vv', '--type', 'execute', appPath]);
  runWithStderr('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
}

console.log(`Verified ${mode} Rally bundle: ${appPath}`);
