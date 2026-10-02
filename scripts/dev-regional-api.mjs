import { configuredRegions, regions } from "./regions.mjs";
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = join(scriptsDirectory, '..', 'apps', 'api');

/**
 * The region's main config without its `containers` block, for local mode.
 *
 * `--enable-containers=false` is ignored once more than one `--config` is
 * passed (wrangler 4.126.0), so Wrangler still tries to build the crash
 * symbolicator's image and dies without Docker. Only the block's absence stops
 * it. Two name segments keep region discovery from reading the copy as a
 * region, and it is rewritten on every start, so it cannot go stale.
 */
export function containerFreeConfig(source) {
  const config = parseWranglerConfig(source);
  delete config.containers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function localMainConfig(region) {
  return `wrangler.${region}.scratch.jsonc`;
}

function writeLocalMainConfigs() {
  for (const region of configuredRegions) {
    const source = readFileSync(join(apiDirectory, `wrangler.${region}.jsonc`), 'utf8');
    writeFileSync(join(apiDirectory, localMainConfig(region)), containerFreeConfig(source));
  }
}

function regionalApiCommands({ local }) {
  return configuredRegions.map((region, index) => ({
    name: region,
    arguments: ['--filter', '@rally/api', 'exec', '--', 'wrangler', 'dev',
      ...(local ? ['--local', '--enable-containers=false'] : []),
      '--config', local ? localMainConfig(region) : `wrangler.${region}.jsonc`,
      ...['documents.', 'terminal.', ...(region === 'global' ? ['telemetry.'] : [])]
        .flatMap((service) => ['--config', `wrangler.${service}${region}.jsonc`]),
      '--env-file', `.dev.vars.${region}`, '--persist-to', `.wrangler/state/${region}`,
      '--port', new URL(regions[region].localApiUrl).port,
      '--inspector-port', String(9230 + index)],
  }));
}

export function wranglerReadyLine(line) {
  return /\bReady on https?:\/\//u.test(line);
}

function startRegion(specification) {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(executable, specification.arguments, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  let resolveReady;
  let rejectReady;
  let ready = false;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const writeLines = (stream, destination) => {
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => {
      destination.write(`[${specification.name}] ${line}\n`);
      if (!ready && wranglerReadyLine(line)) {
        ready = true;
        resolveReady();
      }
    });
  };
  writeLines(child.stdout, process.stdout);
  writeLines(child.stderr, process.stderr);
  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      if (!ready) rejectReady(error);
      resolve({ code: 1, signal: null });
    });
    child.once('exit', (code, signal) => {
      if (!ready) {
        rejectReady(new Error(`${specification.name} Worker exited before becoming ready`));
      }
      resolve({ code, signal });
    });
  });
  return { child, readiness, exit, name: specification.name };
}

function openLocalAuthority() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(scriptsDirectory, 'open-local-authority.mjs')], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const writeLines = (stream, destination) => {
      createInterface({ input: stream }).on('line', (line) => destination.write(`[open-authority] ${line}\n`));
    };
    writeLines(child.stdout, process.stdout);
    writeLines(child.stderr, process.stderr);
    child.once('error', (error) => {
      process.stderr.write(`[open-authority] could not start: ${error.message}\n`);
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        process.stderr.write(`[open-authority] failed (${signal ?? String(code)}); run \`pnpm db:open-authority\` by hand\n`);
      }
      resolve();
    });
  });
}

async function run() {
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--local');
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments[0]}`);
  }
  const local = process.argv.includes('--local');
  if (local) writeLocalMainConfigs();
  const commands = regionalApiCommands({ local });
  const running = [];
  let stopping = false;
  const stop = (signal = 'SIGTERM') => {
    stopping = true;
    for (const region of running) {
      if (region.child.exitCode === null && region.child.signalCode === null) {
        region.child.kill(signal);
      }
    }
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  try {
    for (const command of commands) {
      const previous = [...running];
      const next = startRegion(command);
      running.push(next);
      await Promise.race([next.readiness, ...previous.map((region) => region.exit.then(() => {
        throw new Error(`${region.name} Worker exited while ${next.name} was starting`);
      }))]);
    }
    // A local stack serves nothing until its authority is open: the workspace
    // socket answers 503 and the client waits on "Opening channels" forever.
    // Idempotent, so every start runs it; a failure leaves the Workers up.
    if (local && !stopping) await openLocalAuthority();

    const firstExit = await Promise.race(running.map(async (region) => ({
      region: region.name,
      ...await region.exit,
    })));
    if (!stopping) {
      process.stderr.write(
        `[regional-api] ${firstExit.region} exited unexpectedly (${firstExit.signal ?? String(firstExit.code)})\n`,
      );
      process.exitCode = firstExit.code ?? 1;
      stop();
    } else {
      process.exitCode = firstExit.signal === 'SIGINT' ? 130 : 0;
    }
    await Promise.all(running.map((region) => region.exit));
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    stop();
  }
}

if (isEntryPoint(import.meta.url)) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
