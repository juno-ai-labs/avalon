import { execFileSync, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argumentsAfterSeparator = process.argv.slice(2);
while (argumentsAfterSeparator[0] === '--') argumentsAfterSeparator.shift();
const modeIndex = argumentsAfterSeparator.findIndex((value) => value === '--release');
const mode = modeIndex === -1 ? 'local' : 'release';
if (modeIndex !== -1) argumentsAfterSeparator.splice(modeIndex, 1);

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appPath = join(desktopDirectory, 'release', mode, 'mac-arm64', 'Rally.app');
await access(appPath);
execFileSync(process.execPath, [
  join(desktopDirectory, 'scripts', 'verify-macos-app.mjs'),
  mode,
  appPath,
], { stdio: 'inherit' });

// LaunchServices establishes the macOS application identity. Never invoke the
// inner Contents/MacOS/Rally executable from a sandboxed terminal or runner.
const child = spawn('/usr/bin/open', ['-na', appPath, '--args', ...argumentsAfterSeparator], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
console.log(`Opened ${appPath}`);
