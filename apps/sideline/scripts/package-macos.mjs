import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notarizationCredentialMode, prepareNotarizationEnvironment } from '../../desktop/scripts/apple-notarization.mjs';
import { writeSidelineMacFeed } from './finalize-macos-release.mjs';

if (process.platform !== 'darwin') throw new Error('Sideline release packaging must run on macOS');
if (process.env.CSC_LINK) throw new Error('Import CSC_LINK into a keychain and expose only CSC_NAME to packaging');
if (!process.env.CSC_NAME) throw new Error('Set CSC_NAME before packaging Sideline');
notarizationCredentialMode(process.env);

const sidelineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(sidelineDirectory, 'release');
const staging = join(releaseRoot, `.staging-${process.pid}-${randomBytes(6).toString('hex')}`);
const published = join(releaseRoot, 'release');
const backup = join(releaseRoot, `.previous-${process.pid}-${randomBytes(6).toString('hex')}`);
const packageJson = JSON.parse(await readFile(join(sidelineDirectory, 'package.json'), 'utf8'));

async function run(command, args, environment = process.env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: sidelineDirectory, env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${signal ?? `status ${String(code)}`}`));
    });
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

await mkdir(releaseRoot, { recursive: true });
const secretDirectory = await mkdtemp(join(tmpdir(), 'sideline-notarization-'));
try {
  const environment = {
    ...await prepareNotarizationEnvironment(process.env, secretDirectory),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  };
  await run('pnpm', [
    'exec', 'electron-builder', '--config', 'electron-builder.yml', '--mac', '--arm64',
    `--config.directories.output=${staging}`, '--publish', 'never',
  ], environment);
  await writeSidelineMacFeed(staging, packageJson.version, environment);
  await run(process.execPath, [join(sidelineDirectory, 'scripts/verify-macos-release.mjs'), staging], environment);

  const hadPublished = await exists(published);
  if (hadPublished) await rename(published, backup);
  try {
    await rename(staging, published);
  } catch (error) {
    if (hadPublished) await rename(backup, published);
    throw error;
  }
  if (hadPublished) await rm(backup, { recursive: true, force: true });
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
} finally {
  await rm(secretDirectory, { recursive: true, force: true });
}
