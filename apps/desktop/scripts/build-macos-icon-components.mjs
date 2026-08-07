import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(desktopDirectory, 'native', 'dock-tile-plugin');
const outputBundle = join(
  desktopDirectory,
  '.native-build',
  'AvalonDockTilePlugin.docktileplugin',
);
const contentsDirectory = join(outputBundle, 'Contents');
const executableDirectory = join(contentsDirectory, 'MacOS');
const resourcesDirectory = join(contentsDirectory, 'Resources');
const executablePath = join(executableDirectory, 'AvalonDockTilePlugin');
const smokeExecutablePath = join(desktopDirectory, '.native-build', 'AvalonDockTilePluginSmoke');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The Avalon Dock tile plugin must be built on arm64 macOS.');
}

await rm(outputBundle, { recursive: true, force: true });
await mkdir(executableDirectory, { recursive: true });
await mkdir(resourcesDirectory, { recursive: true });
await copyFile(join(sourceDirectory, 'Info.plist'), join(contentsDirectory, 'Info.plist'));
await writeFile(join(resourcesDirectory, 'version.txt'), 'Avalon Dock Tile Plugin 1\n');
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
  join(sourceDirectory, 'AvalonDockTilePlugin.m'),
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
    join(sourceDirectory, 'AvalonDockTilePlugin.m'),
    join(sourceDirectory, 'AvalonDockTilePluginSmoke.m'),
    '-o',
    smokeExecutablePath,
  ]);
  await run(smokeExecutablePath, []);
} finally {
  await rm(smokeExecutablePath, { force: true });
}

console.log(`Built ${outputBundle}`);
