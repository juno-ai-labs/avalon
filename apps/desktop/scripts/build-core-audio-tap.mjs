import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(desktopDirectory, 'native', 'system-audio-tap', 'SystemAudioTap.mm');
const outputPath = join(desktopDirectory, '.native-build', 'system-audio-tap.node');
const nodeIncludeDirectory = resolve(dirname(process.execPath), '../include/node');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The Rally Core Audio tap must be built on arm64 macOS.');
}
await access(join(nodeIncludeDirectory, 'node_api.h'));
await mkdir(dirname(outputPath), { recursive: true });
await run('/usr/bin/xcrun', [
  '--sdk',
  'macosx',
  'clang++',
  '-arch',
  'arm64',
  '-std=c++20',
  '-fobjc-arc',
  '-fblocks',
  '-fmodules',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-mmacosx-version-min=13.0',
  '-bundle',
  '-undefined',
  'dynamic_lookup',
  '-DNODE_GYP_MODULE_NAME=system_audio_tap',
  '-I',
  nodeIncludeDirectory,
  '-framework',
  'CoreAudio',
  '-framework',
  'Foundation',
  sourcePath,
  '-o',
  outputPath,
]);
await run('/usr/bin/lipo', [outputPath, '-verify_arch', 'arm64']);

const smoke = await run(process.execPath, [
  '-e',
  `const tap = require(${JSON.stringify(outputPath)}); if (typeof tap.start !== 'function' || typeof tap.stop !== 'function' || tap.isSupported() !== true) process.exit(1);`,
]);
if (smoke.stderr) process.stderr.write(smoke.stderr);
console.log(`Built ${outputPath}`);
