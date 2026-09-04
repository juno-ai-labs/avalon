import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

function run(command, args) {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return typeof output === 'string' ? output.trim() : '';
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    throw new Error(`${command} ${args.join(' ')} failed\n${stderr || stdout}`.trim(), { cause: error });
  }
}

function runningSmokePids(marker) {
  return new Set(
    run('/bin/ps', ['-axo', 'pid=,command='])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('Contents/MacOS/Rally') && line.includes(marker))
      .map((line) => Number(line.match(/^(\d+)/u)?.[1]))
      .filter(Number.isSafeInteger),
  );
}

function runningRendererPids(appPath, userDataDirectory) {
  const rendererExecutable = join(
    appPath,
    'Contents/Frameworks/Rally Helper (Renderer).app/Contents/MacOS/Rally Helper (Renderer)',
  );
  return new Set(
    run('/bin/ps', ['-axo', 'pid=,command='])
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) => line.includes(rendererExecutable)
          && line.includes('--type=renderer')
          && line.includes(`--user-data-dir=${userDataDirectory}`),
      )
      .map((line) => Number(line.match(/^(\d+)/u)?.[1]))
      .filter(Number.isSafeInteger),
  );
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function stopIsolatedProcesses(discover, kill = process.kill, settle = () => sleep(100)) {
  // Two explicit termination stages, not an unbounded retry of SIGTERM.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const smokePids = discover();
    if (smokePids.size === 0) return;
    for (const pid of smokePids) {
      try {
        kill(pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await settle();
  }
  const survivors = discover();
  if (survivors.size > 0) throw new Error(`Isolated smoke processes did not exit: ${[...survivors].join(', ')}`);
}

async function stopSmokeProcesses(marker, appPath, userDataDirectory) {
  await stopIsolatedProcesses(() => new Set([
    ...runningSmokePids(marker),
    ...runningRendererPids(appPath, userDataDirectory),
  ]));
}

/**
 * Launch a packaged app through LaunchServices with an isolated Electron
 * profile, require both main and renderer processes, and keep them alive long
 * enough to catch top-level ESM/CommonJS interop failures.
 */
export async function smokeLaunch(appPath, userDataDirectory) {
  // Chromium canonicalizes macOS's /tmp and /var symlinks in child-process
  // arguments. Pass the canonical path ourselves so renderer detection compares
  // like with like (`/private/tmp/...` instead of `/tmp/...`).
  const canonicalUserDataDirectory = await realpath(userDataDirectory);
  const marker = `--rally-package-smoke=${randomUUID()}`;
  run('/usr/bin/open', [
    '-na',
    appPath,
    '--args',
    `--user-data-dir=${canonicalUserDataDirectory}`,
    marker,
  ]);
  let launchedPid;
  let launchError;
  try {
    let rendererPids = new Set();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      launchedPid = [...runningSmokePids(marker)][0];
      rendererPids = runningRendererPids(appPath, canonicalUserDataDirectory);
      if (launchedPid && rendererPids.size > 0) break;
    }
    if (!launchedPid) throw new Error('Packaged Rally did not start through LaunchServices');
    if (rendererPids.size === 0) {
      throw new Error('Packaged Rally did not start a signed Renderer helper');
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(500);
      process.kill(launchedPid, 0);
      rendererPids = runningRendererPids(appPath, canonicalUserDataDirectory);
      if (rendererPids.size === 0) {
        throw new Error('Packaged Rally Renderer helper exited during launch smoke');
      }
    }
  } catch (error) {
    launchError = launchedPid && error?.message?.includes('Renderer helper')
      ? error
      : new Error(`Packaged Rally process ${launchedPid ?? '(missing)'} exited during launch smoke`, { cause: error });
  }
  // Cleanup always runs, but cannot erase the launch failure it is cleaning up.
  try {
    await stopSmokeProcesses(marker, appPath, canonicalUserDataDirectory);
  } catch (cleanupError) {
    if (launchError) throw new AggregateError([launchError, cleanupError], 'Launch smoke and cleanup both failed', { cause: cleanupError });
    throw cleanupError;
  }
  if (launchError) throw launchError;
}
