import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const directory = dirname(fileURLToPath(import.meta.url));
const desktopRequire = createRequire(join(directory, '../../../apps/desktop/package.json'));
// Test budget for Electron bootstrap and loopback I/O, matching the packaged
// crash fixture's 30s process budget. A missing error event must fail the run.
const NATIVE_FIXTURE_TIMEOUT_MS = 30_000;
// An explicit path lets cloud checks use a staged, unmodified Electron binary.
const electron = process.argv[2]
  ?? desktopRequire('electron');
const staging = await mkdtemp(join(tmpdir(), 'rally-electron-network-'));
try {
  const source = await readFile(join(directory, '../src/index.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  await writeFile(join(staging, 'bridge.cjs'), outputText);
  const flags = process.platform === 'linux'
    ? ['--no-sandbox', '--headless', '--disable-gpu', '--ozone-platform=headless']
    : [];
  for (const fixture of ['native-fixture.mjs', 'updater-native-fixture.mjs']) {
    await copyFile(join(directory, fixture), join(staging, 'main.mjs'));
    const result = spawnSync(electron, [
      ...flags, join(staging, 'main.mjs'),
      desktopRequire.resolve('electron-updater/out/electronHttpExecutor.js'),
    ], { stdio: 'inherit', timeout: NATIVE_FIXTURE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (result.error) throw new Error(`Native fixture ${fixture} failed to complete`, { cause: result.error });
    process.exitCode = result.status ?? 1;
    if (process.exitCode !== 0) break;
  }
} finally {
  await rm(staging, { recursive: true });
}
