import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(desktopDirectory, 'native', 'unified-log', 'UnifiedLog.mm');
const outputPath = join(desktopDirectory, '.native-build', 'unified-log.node');
const nodeIncludeDirectory = resolve(dirname(process.execPath), '../include/node');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The Rally unified-log bridge must be built on arm64 macOS.');
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
  '-fmodules',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-mmacosx-version-min=13.0',
  '-bundle',
  '-undefined',
  'dynamic_lookup',
  '-DNODE_GYP_MODULE_NAME=unified_log',
  '-I',
  nodeIncludeDirectory,
  sourcePath,
  '-o',
  outputPath,
]);
await run('/usr/bin/lipo', [outputPath, '-verify_arch', 'arm64']);

const smoke = await run(process.execPath, [
  '-e',
  `const binding = require(${JSON.stringify(outputPath)}); if (typeof binding.writePerformance !== 'function') process.exit(1); binding.writePerformance('{"event":"rally_unified_log_smoke"}');`,
]);
if (smoke.stderr) process.stderr.write(smoke.stderr);
console.log(`Built ${outputPath}`);
