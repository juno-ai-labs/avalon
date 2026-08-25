import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notarizationCredentialMode, prepareNotarizationEnvironment } from './apple-notarization.mjs';
import { writeFinalMacFeed } from './finalize-macos-release.mjs';
import { smokeLaunch } from './launch-smoke.mjs';

const mode = process.argv[2] ?? 'local';
if (!['local', 'release'].includes(mode)) {
  throw new Error('Usage: node package-macos.mjs <local|release>');
}
if (process.platform !== 'darwin') throw new Error('The guarded macOS packager must run on macOS.');

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = join(desktopDirectory, 'release');
const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
const stagingDirectory = join(releaseDirectory, `.staging-${mode}-${suffix}`);
const publishedDirectory = join(releaseDirectory, mode);
const backupDirectory = join(releaseDirectory, `.previous-${mode}-${suffix}`);
const configFile = mode === 'local' ? 'electron-builder.local.yml' : 'electron-builder.yml';
const desktopPackage = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'));

if (mode === 'release') {
  if (process.env.CSC_LINK) {
    throw new Error(
      'Do not pass CSC_LINK to the release packager. Import the certificate into a user-search-list keychain and set CSC_NAME instead.',
    );
  }
  if (!process.env.CSC_NAME) {
    throw new Error('Set CSC_NAME explicitly; release builds never auto-select a signing identity.');
  }
  if (process.env.CSC_NAME?.startsWith('Developer ID Application:')) {
    throw new Error('CSC_NAME must omit the "Developer ID Application:" prefix; electron-builder selects that certificate type automatically.');
  }
  notarizationCredentialMode(process.env);
}

async function run(command, args, environment = process.env) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: desktopDirectory,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`${command} exited with ${signal ?? `status ${String(code)}`}`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function publishVerifiedBuild() {
  const hadPublishedBuild = await exists(publishedDirectory);
  if (hadPublishedBuild) await rename(publishedDirectory, backupDirectory);
  try {
    await rename(stagingDirectory, publishedDirectory);
  } catch (error) {
    if (hadPublishedBuild) await rename(backupDirectory, publishedDirectory);
    throw error;
  }
  if (hadPublishedBuild) await rm(backupDirectory, { recursive: true, force: true });
}

await mkdir(releaseDirectory, { recursive: true });
const notarizationSecretDirectory = mode === 'release'
  ? await mkdtemp(join(tmpdir(), 'rally-notarization-'))
  : undefined;
const smokeUserDataDirectory = mode === 'local'
  ? await mkdtemp(join(tmpdir(), 'rally-local-smoke-user-data-'))
  : undefined;
try {
  await run(process.execPath, [join(desktopDirectory, 'scripts', 'build-macos-native-components.mjs')]);
  const builderArgs = [
    'exec',
    'electron-builder',
    '--config',
    configFile,
    '--mac',
    '--arm64',
    `--config.directories.output=${stagingDirectory}`,
    '--publish',
    'never',
  ];
  if (mode === 'local') builderArgs.push('--dir');

  const environment = mode === 'release'
    ? {
      ...await prepareNotarizationEnvironment(process.env, notarizationSecretDirectory),
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    }
    : process.env;
  await run('pnpm', builderArgs, environment);

  const appPath = join(stagingDirectory, 'mac-arm64', 'Rally.app');
  if (mode === 'release') {
    // electron-builder writes update info after afterAllArtifactBuild. Rewrite
    // it now so every manifest entry describes the signed and stapled bytes.
    await writeFinalMacFeed(stagingDirectory, desktopPackage.version, environment);
    await run(process.execPath, [join(desktopDirectory, 'scripts', 'verify-macos-release.mjs'), stagingDirectory]);
  } else {
    await run(process.execPath, [join(desktopDirectory, 'scripts', 'verify-macos-app.mjs'), mode, appPath]);
    await smokeLaunch(appPath, smokeUserDataDirectory);
  }
  await publishVerifiedBuild();
  console.log(`Published verified ${mode} build to ${publishedDirectory}`);
} catch (error) {
  await rm(stagingDirectory, { recursive: true, force: true });
  throw error;
} finally {
  if (notarizationSecretDirectory) {
    await rm(notarizationSecretDirectory, { recursive: true, force: true });
  }
  if (smokeUserDataDirectory) {
    await rm(smokeUserDataDirectory, { recursive: true, force: true });
  }
}
