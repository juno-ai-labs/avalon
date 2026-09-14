import { configuredRegions, regions } from "./regions.mjs";
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isEntryPoint } from './entry-point.mjs';

export function regionalApiCommands({ local }) {
  return configuredRegions.map((region, index) => ({
    name: region,
    arguments: ['--filter', '@rally/api', 'exec', '--', 'wrangler', 'dev',
      ...(local ? ['--local', '--enable-containers=false'] : []),
      ...['', 'documents.', 'terminal.', ...(region === 'global' ? ['telemetry.'] : [])]
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

async function run() {
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--local');
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments[0]}`);
  }
  const commands = regionalApiCommands({ local: process.argv.includes('--local') });
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
