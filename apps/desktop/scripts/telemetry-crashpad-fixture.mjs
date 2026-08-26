import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(currentDirectory, 'fixtures', 'crashpad');
const require = createRequire(import.meta.url);

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The released desktop crash fixture currently requires macOS arm64');
}

async function run(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const { code, signal } = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(`${command} exited with ${signal ?? `status ${String(code)}`}\n${stderr || stdout}`.trim());
  }
  return { stdout, stderr };
}

async function filesBelow(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const scratchDirectory = await mkdtemp(join(tmpdir(), 'rally-packaged-crashpad-'));
try {
  const fixtureSource = await readFile(join(fixtureDirectory, 'main.cjs'), 'utf8');
  if (fixtureSource.includes('submitURL')) {
    throw new Error('Packaged Crashpad fixture must not configure a submission URL');
  }
  const outputDirectory = join(scratchDirectory, 'build');
  const packagedFixtureDirectory = join(scratchDirectory, 'fixture');
  const bundledControllerPath = join(packagedFixtureDirectory, 'production-controller.cjs');
  await mkdir(packagedFixtureDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(join(fixtureDirectory, 'main.cjs'), join(packagedFixtureDirectory, 'main.cjs')),
    copyFile(join(fixtureDirectory, 'package.json'), join(packagedFixtureDirectory, 'package.json')),
  ]);
  await run('pnpm', [
    '--filter',
    '@rally/desktop',
    'exec',
    'esbuild',
    join(fixtureDirectory, 'production-controller.mjs'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundledControllerPath}`,
  ], { cwd: join(currentDirectory, '..', '..', '..') });
  if ((await stat(bundledControllerPath)).size === 0) throw new Error('Crashpad fixture controller bundle is empty');
  await build({
    projectDir: packagedFixtureDirectory,
    targets: Platform.MAC.createTarget('dir', Arch.arm64),
    publish: 'never',
    config: {
      appId: 'ai.rallywith.crashpad-fixture',
      productName: 'Rally Crashpad Fixture',
      electronVersion: '43.2.0',
      asar: true,
      npmRebuild: false,
      directories: { output: outputDirectory },
      files: ['main.cjs', 'production-controller.cjs', 'package.json'],
      mac: { identity: null },
    },
  });

  const applicationPath = join(outputDirectory, 'mac-arm64', 'Rally Crashpad Fixture.app');
  const executablePath = join(
    applicationPath,
    'Contents',
    'MacOS',
    'Rally Crashpad Fixture',
  );
  const firstGenerationId = '00000000-0000-7000-8000-000000000001';
  const secondGenerationId = '00000000-0000-7000-8000-000000000002';
  const firstGenerationDirectory = join(scratchDirectory, 'active', firstGenerationId);
  const firstLaunchAt = new Date();
  const secondLaunchAt = new Date(firstLaunchAt.getTime() + 60_000);
  await run(executablePath, [
    `--fixture-root=${scratchDirectory}`,
    `--fixture-generation-id=${firstGenerationId}`,
    '--fixture-route=global',
    `--fixture-now=${firstLaunchAt.toISOString()}`,
  ], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });

  const firstResult = JSON.parse(await readFile(join(scratchDirectory, 'fixture-result.json'), 'utf8'));
  if (firstResult.route !== 'global' || firstResult.generationId !== firstGenerationId
    || firstResult.rotatedGenerationIds.length !== 0) {
    throw new Error('Production route/generation controller returned an unexpected first launch');
  }
  const minidumps = (await filesBelow(join(firstGenerationDirectory, 'crashpad')))
    .filter((path) => path.endsWith('.dmp'));
  if (minidumps.length !== 1) {
    throw new Error(`Expected one completed packaged renderer minidump, found ${minidumps.length}`);
  }
  const dumpSize = (await stat(minidumps[0])).size;
  if (dumpSize === 0) throw new Error('Packaged renderer minidump is empty');

  await run(executablePath, [
    `--fixture-root=${scratchDirectory}`,
    `--fixture-generation-id=${secondGenerationId}`,
    '--fixture-route=global',
    `--fixture-now=${secondLaunchAt.toISOString()}`,
  ], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  const secondResult = JSON.parse(await readFile(join(scratchDirectory, 'fixture-result.json'), 'utf8'));
  if (secondResult.route !== 'global' || secondResult.generationId !== secondGenerationId
    || JSON.stringify(secondResult.rotatedGenerationIds) !== JSON.stringify([firstGenerationId])) {
    throw new Error('Production generation controller did not rotate the first database');
  }

  const rotatedMinidumps = (await filesBelow(join(
    scratchDirectory,
    'upload',
    'global',
    firstGenerationId,
  ))).filter((path) => path.endsWith('.dmp'));
  if (rotatedMinidumps.length !== 1) {
    throw new Error('Expected the first inactive database to survive as one rotated report');
  }
  const secondMinidumps = (await filesBelow(join(
    scratchDirectory,
    'active',
    secondGenerationId,
    'crashpad',
  ))).filter((path) => path.endsWith('.dmp'));
  if (secondMinidumps.length !== 1) {
    throw new Error('Expected the second crash to remain in the fresh active generation');
  }
  const rotatedDumpSize = (await stat(rotatedMinidumps[0])).size;
  if (rotatedDumpSize !== dumpSize) {
    throw new Error('Rotating the inactive database changed the first minidump bytes');
  }
  const { uploadFixtureGeneration } = require(bundledControllerPath);
  const requests = await uploadFixtureGeneration({
    rootDirectory: scratchDirectory,
    route: 'global',
  });
  if (requests.length !== 1
    || requests[0].endpoint !== 'https://api.rallywith.ai/telemetry/crashes'
    || requests[0].metadata.route !== 'global') {
    throw new Error('Production native crash uploader did not use the route-final API');
  }
  const remainingRotatedDumps = (await filesBelow(join(
    scratchDirectory,
    'upload',
    'global',
    firstGenerationId,
  ))).filter((path) => path.endsWith('.dmp'));
  if (remainingRotatedDumps.length !== 0) {
    throw new Error('Production uploader did not remove the acknowledged inactive dump');
  }
  console.log(
    `Packaged Crashpad fixture routed, rotated, and uploaded a real renderer minidump; first size ${dumpSize}`,
  );
} finally {
  if (process.env.RALLY_KEEP_CRASHPAD_FIXTURE !== 'true') {
    await rm(scratchDirectory, { recursive: true, force: true });
  } else {
    console.log(`Preserved Crashpad fixture at ${scratchDirectory}`);
  }
}
