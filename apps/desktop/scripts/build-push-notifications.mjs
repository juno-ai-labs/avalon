import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(desktopDirectory, 'native', 'push-notifications', 'PushNotifications.mm');
const outputPath = join(desktopDirectory, '.native-build', 'push-notifications.node');
const nodeIncludeDirectory = resolve(dirname(process.execPath), '../include/node');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The Rally push notification bridge must be built on arm64 macOS.');
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
  '-framework', 'Foundation', '-framework', 'UserNotifications',
  '-bundle',
  '-undefined',
  'dynamic_lookup',
  '-DNODE_GYP_MODULE_NAME=push_notifications',
  '-I',
  nodeIncludeDirectory,
  sourcePath,
  '-o',
  outputPath,
]);
await run('/usr/bin/lipo', [outputPath, '-verify_arch', 'arm64']);

console.log(`Built ${outputPath}`);
