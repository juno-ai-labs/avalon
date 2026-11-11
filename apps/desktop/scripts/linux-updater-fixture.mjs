import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

if (process.platform !== 'linux') throw new Error('The Linux update fixture requires Linux');
const directory = await mkdtemp(join(tmpdir(), 'rally-linux-update-'));
try {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/linux-updater'),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], {
      env: { ...process.env, XDG_CACHE_HOME: join(directory, 'cache'), RALLY_UPDATE_FIXTURE_DIRECTORY: directory }, stdio: 'inherit',
    });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Linux update fixture timed out')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(); else reject(new Error(`Linux update fixture exited ${code}`));
    });
  });
  let marker;
  for (let attempt = 0; attempt < 20; attempt++) {
    marker = await readFile(join(directory, 'restarted'), 'utf8').catch(() => undefined);
    if (marker === 'updated') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (marker !== 'updated') throw new Error('Linux updater did not execute the installed payload');
  console.log('Linux updater rejected corrupt bytes, downloaded, replaced and restarted the fixture.');
} finally { await rm(directory, { recursive: true, force: true }); }
