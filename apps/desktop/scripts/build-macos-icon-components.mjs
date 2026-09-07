import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(desktopDirectory, 'native', 'dock-tile-plugin');
const outputBundle = join(
  desktopDirectory,
  '.native-build',
  'RallyDockTilePluginV2.docktileplugin',
);
const contentsDirectory = join(outputBundle, 'Contents');
const executableDirectory = join(contentsDirectory, 'MacOS');
const resourcesDirectory = join(contentsDirectory, 'Resources');
const executablePath = join(executableDirectory, 'RallyDockTilePluginV2');
const smokeExecutablePath = join(desktopDirectory, '.native-build', 'RallyDockTilePluginV2Smoke');
const selectableIconSourceDirectory = join(desktopDirectory, 'resources', 'app-icons');
const selectableIconTemplateDirectory = join(desktopDirectory, 'native', 'selectable-app-icon');
const selectableIconOutputDirectory = join(desktopDirectory, '.native-build', 'app-icons');
const selectableIconNames = [
  'light',
  'dark',
  'calm',
  'ludicrous',
  'homage',
  'builder',
  'quiet',
];

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The Rally Dock tile plugin must be built on arm64 macOS.');
}

await rm(outputBundle, { recursive: true, force: true });
await rm(selectableIconOutputDirectory, { recursive: true, force: true });
await mkdir(executableDirectory, { recursive: true });
await mkdir(resourcesDirectory, { recursive: true });
await mkdir(selectableIconOutputDirectory, { recursive: true });
await copyFile(join(sourceDirectory, 'Info.plist'), join(contentsDirectory, 'Info.plist'));
await writeFile(join(resourcesDirectory, 'version.txt'), 'Rally Dock Tile Plugin 2\n');
await run('/usr/bin/xcrun', [
  '--sdk',
  'macosx',
  'clang',
  '-arch',
  'arm64',
  '-fobjc-arc',
  '-fblocks',
  '-fmodules',
  '-mmacosx-version-min=13.0',
  '-bundle',
  '-framework',
  'AppKit',
  '-framework',
  'Foundation',
  join(sourceDirectory, 'RallyDockTilePlugin.m'),
  '-o',
  executablePath,
]);
await run('/usr/bin/plutil', ['-lint', join(contentsDirectory, 'Info.plist')]);
await run('/usr/bin/lipo', [executablePath, '-verify_arch', 'arm64']);

try {
  await run('/usr/bin/xcrun', [
    '--sdk',
    'macosx',
    'clang',
    '-arch',
    'arm64',
    '-fobjc-arc',
    '-fblocks',
    '-fmodules',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Winfinite-recursion',
    '-mmacosx-version-min=13.0',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    join(sourceDirectory, 'RallyDockTilePlugin.m'),
    join(sourceDirectory, 'RallyDockTilePluginSmoke.m'),
    '-o',
    smokeExecutablePath,
  ]);
  await run(smokeExecutablePath, selectableIconNames.map((name) => join(selectableIconSourceDirectory, `${name}.png`)));
} finally {
  await rm(smokeExecutablePath, { force: true });
}

async function compileSelectableIcon(name) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), `rally-${name}-icon-`));
  const iconPackage = join(temporaryDirectory, 'Icon.icon');
  const iconAssetsDirectory = join(iconPackage, 'Assets');
  const compiledDirectory = join(temporaryDirectory, 'compiled');
  try {
    await mkdir(iconAssetsDirectory, { recursive: true });
    await mkdir(compiledDirectory, { recursive: true });
    await copyFile(
      join(selectableIconTemplateDirectory, 'icon.json'),
      join(iconPackage, 'icon.json'),
    );
    await copyFile(
      join(selectableIconSourceDirectory, `${name}.png`),
      join(iconAssetsDirectory, 'artwork.png'),
    );
    await run('/usr/bin/xcrun', [
      'actool',
      iconPackage,
      '--compile',
      compiledDirectory,
      '--output-format',
      'human-readable-text',
      '--notices',
      '--warnings',
      '--output-partial-info-plist',
      join(compiledDirectory, 'assetcatalog_generated_info.plist'),
      '--app-icon',
      'Icon',
      '--include-all-app-icons',
      '--enable-on-demand-resources',
      'NO',
      '--development-region',
      'en',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '26.0',
      '--platform',
      'macosx',
    ]);
    const compiledIconPath = join(compiledDirectory, 'Icon.icns');
    const compiledIcon = await readFile(compiledIconPath);
    if (compiledIcon.subarray(0, 4).toString('ascii') !== 'icns') {
      throw new Error(`actool did not produce a valid ICNS rendition for ${name}`);
    }
    await copyFile(compiledIconPath, join(selectableIconOutputDirectory, `${name}.icns`));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

for (const name of selectableIconNames) await compileSelectableIcon(name);
await writeFile(
  join(selectableIconOutputDirectory, 'manifest.json'),
  `${JSON.stringify({ version: 1, icons: selectableIconNames }, null, 2)}\n`,
);

console.log(`Built ${outputBundle}`);
console.log(`Built ${selectableIconNames.length} system-rendered selectable icons in ${selectableIconOutputDirectory}`);
