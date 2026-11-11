import { spawnSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLinuxApplication, verifyLinuxRelease } from './verify-linux-release.mjs';
import { writeLinuxChecksums } from './linux-release.mjs';

const mode = process.argv[2] ?? 'local';
if (!['local', 'release'].includes(mode)) throw new Error('Usage: package-linux.mjs <local|release>');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build Linux packages on Linux x64');
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(desktop, 'release', `linux-${mode}`);
const staging = `${output}.staging-${process.pid}`;
function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
}
try {
  run('pnpm', ['build', ...(mode === 'release' ? ['--mode', 'packaged'] : [])]);
  run('pnpm', ['exec', 'electron-builder', '--config', 'electron-builder.linux.yml', '--linux', '--x64',
    '--publish', 'never', `--config.directories.output=${staging}`, ...(mode === 'local' ? ['--dir'] : [])]);
  if (mode === 'release') {
    await writeLinuxChecksums(staging);
    await verifyLinuxRelease(staging);
  } else {
    await verifyLinuxApplication(join(staging, 'linux-unpacked', 'rally'));
  }
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  console.log(`Verified Linux ${mode} build: ${output}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
