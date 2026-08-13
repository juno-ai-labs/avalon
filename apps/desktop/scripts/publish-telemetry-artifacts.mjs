import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isEntryPoint } from '../../../scripts/entry-point.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const SAFE_PART = /^[0-9A-Za-z][0-9A-Za-z._-]{0,159}$/u;

function required(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Set ${name} before publishing telemetry artifacts`);
  return value;
}

async function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: options.env ?? process.env,
      stdio: ['ignore', options.stdoutFile ? 'pipe' : 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let output;
    if (options.stdoutFile) {
      output = pipeline(child.stdout, createWriteStream(options.stdoutFile, { mode: 0o600 }));
    } else {
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    }
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', async (code, signal) => {
      try {
        await output;
        resolveRun({ code, signal, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline((await import('node:fs')).createReadStream(path), hash);
  return hash.digest('hex');
}

function assertSafePart(value, label) {
  if (!SAFE_PART.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
  return value;
}

function assertSafeModuleName(value) {
  if (value.length === 0 || value.length > 200 || value === '.' || value === '..' || /[/\\\0]/u.test(value)) {
    throw new Error(`Unsafe native module name: ${value}`);
  }
  return value;
}

export function javascriptArtifactKey({ release, buildId, process, file }) {
  return [
    'telemetry/javascript-symbols',
    assertSafePart(release, 'release'),
    assertSafePart(buildId, 'build ID'),
    assertSafePart(process, 'process'),
    assertSafePart(file, 'source map name'),
  ].join('/');
}

export function nativeArtifactKey({ release, buildId, platform, architecture }) {
  return [
    'telemetry/symbols',
    assertSafePart(release, 'release'),
    assertSafePart(buildId, 'build ID'),
    assertSafePart(platform, 'platform'),
    `${assertSafePart(architecture, 'architecture')}.tar`,
  ].join('/');
}

async function uploadAndVerify(
  bucket,
  key,
  source,
  contentType,
  temporaryDirectory,
  { environment, runCommand },
) {
  const commandEnvironment = {
    ...environment,
    CLOUDFLARE_ACCOUNT_ID: required('CLOUDFLARE_ACCOUNT_ID', environment),
    CLOUDFLARE_API_TOKEN: required('CLOUDFLARE_API_TOKEN', environment),
  };
  const target = `${bucket}/${key}`;
  const put = await runCommand('pnpm', [
    '--filter', '@avalon/api', 'exec', 'wrangler', 'r2', 'object', 'put', target,
    '--remote', '--file', source, '--content-type', contentType, '--force',
  ], { env: commandEnvironment });
  if (put.code !== 0) throw new Error(`Could not upload r2://${target}: ${put.stderr.slice(0, 2_000)}`);
  const verified = join(temporaryDirectory, `verify-${createHash('sha256').update(target).digest('hex')}`);
  const get = await runCommand('pnpm', [
    '--filter', '@avalon/api', 'exec', 'wrangler', 'r2', 'object', 'get', target,
    '--remote', '--file', verified,
  ], { env: commandEnvironment });
  if (get.code !== 0) throw new Error(`Could not verify r2://${target}: ${get.stderr.slice(0, 2_000)}`);
  const [sourceHash, verifiedHash] = await Promise.all([sha256(source), sha256(verified)]);
  if (sourceHash !== verifiedHash) throw new Error(`Checksum mismatch for r2://${target}`);
}

async function findPackagedApplication(sourceDesktopDirectory) {
  const releaseDirectory = join(sourceDesktopDirectory, 'release');
  const entries = await readdir(releaseDirectory, { recursive: true, withFileTypes: true });
  const applications = entries
    .filter((entry) => entry.isDirectory() && entry.name === 'Avalon.app')
    .map((entry) => join(entry.parentPath, entry.name));
  if (applications.length !== 1) {
    throw new Error(`Expected one packaged Avalon.app, found ${applications.length}`);
  }
  return applications[0];
}

async function isMachO(path, runCommand) {
  const result = await runCommand('file', ['-b', path]);
  return result.code === 0 && /Mach-O 64-bit/u.test(result.stdout);
}

async function readFirstLine(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(1_024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
  } finally {
    await handle.close();
  }
}

async function buildNativeArchive(application, temporaryDirectory, runCommand) {
  const symbolsDirectory = join(temporaryDirectory, 'symbols');
  await mkdir(symbolsDirectory, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const binary of await filesBelow(application)) {
    if (!await isMachO(binary, runCommand)) continue;
    const pending = join(temporaryDirectory, `symbol-${count}.sym`);
    const dumped = await runCommand('dump_syms', [binary], { stdoutFile: pending });
    if (dumped.code !== 0 || (await stat(pending).catch(() => null))?.size === 0) {
      await rm(pending, { force: true });
      continue;
    }
    const header = (await readFirstLine(pending)).split(' ');
    if (header.length < 5 || header[0] !== 'MODULE') {
      await rm(pending, { force: true });
      continue;
    }
    const identifier = assertSafePart(header[3], 'native module identifier');
    const module = assertSafeModuleName(basename(header.slice(4).join(' ')));
    const destination = join(symbolsDirectory, module, identifier, `${module}.sym`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(pending, destination);
    count += 1;
  }
  if (count === 0) throw new Error('No native Breakpad symbols were extracted');
  const archive = join(temporaryDirectory, 'darwin-arm64-symbols.tar');
  const archived = await runCommand('tar', ['-cf', archive, '-C', symbolsDirectory, '.']);
  if (archived.code !== 0) throw new Error(`Could not archive native symbols: ${archived.stderr.slice(0, 2_000)}`);
  return archive;
}

export async function publishTelemetryArtifacts(options = {}) {
  const sourceDesktopDirectory = options.desktopDirectory ?? desktopDirectory;
  const environment = options.environment ?? process.env;
  const runCommand = options.runCommand ?? run;
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const packageJson = JSON.parse(await readFile(join(sourceDesktopDirectory, 'package.json'), 'utf8'));
  const release = assertSafePart(packageJson.version, 'release');
  // Desktop runtime currently sends appVersion for both fields. Keeping the
  // artifact coordinate identical prevents a crash from requesting a symbol
  // tree that the release job never published.
  const buildId = release;
  const buckets = [
    required('AVALON_GLOBAL_TELEMETRY_R2_BUCKET', environment),
    required('AVALON_EU_TELEMETRY_R2_BUCKET', environment),
  ];
  for (const bucket of buckets) assertSafePart(bucket, 'R2 bucket');
  if (new Set(buckets).size !== 2) throw new Error('Global and EU telemetry artifacts require distinct buckets');

  const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'avalon-telemetry-artifacts-'));
  try {
    const maps = (await filesBelow(join(sourceDesktopDirectory, 'out'))).filter((path) => path.endsWith('.map'));
    const allowedProcesses = new Set(['main', 'preload', 'renderer']);
    const foundProcesses = new Set();
    const artifacts = maps.map((path) => {
      const process = relative(join(sourceDesktopDirectory, 'out'), path).split(sep)[0];
      if (!allowedProcesses.has(process)) throw new Error(`Unexpected source-map process: ${process}`);
      foundProcesses.add(process);
      return {
        source: path,
        key: javascriptArtifactKey({ release, buildId, process, file: basename(path) }),
        contentType: 'application/json',
      };
    });
    const missingProcesses = [...allowedProcesses].filter((process) => !foundProcesses.has(process));
    if (missingProcesses.length > 0) {
      throw new Error(`Missing source maps for: ${missingProcesses.join(', ')}`);
    }
    const nativeArchive = await buildNativeArchive(
      await findPackagedApplication(sourceDesktopDirectory),
      temporaryDirectory,
      runCommand,
    );
    artifacts.push({
      source: nativeArchive,
      key: nativeArtifactKey({ release, buildId, platform: 'darwin', architecture: 'arm64' }),
      contentType: 'application/x-tar',
    });
    for (const bucket of buckets) {
      for (const artifact of artifacts) {
        await uploadAndVerify(
          bucket,
          artifact.key,
          artifact.source,
          artifact.contentType,
          temporaryDirectory,
          { environment, runCommand },
        );
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (isEntryPoint(import.meta.url)) {
  await publishTelemetryArtifacts();
}
