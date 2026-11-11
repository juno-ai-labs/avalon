import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadLinuxRelease } from './linux-release.mjs';
import { smokeLinux } from './smoke-linux.mjs';
import { isEntryPoint } from './entry-point.mjs';

export async function verifyLinuxApplication(executable) {
  const updateConfig = await readFile(join(dirname(executable), 'resources', 'app-update.yml'), 'utf8');
  if (!/^provider: generic$/mu.test(updateConfig)
    || !/^url: https:\/\/downloads\.rallywith\.ai\/stable\/linux\/x64$/mu.test(updateConfig)) {
    throw new Error('Packaged Linux updater is not pinned to the Linux release feed');
  }
  await smokeLinux(executable);
}

export async function verifyLinuxRelease(directory) {
  const release = await loadLinuxRelease(directory);
  const appImage = release.feed.files.find((file) => file.url.endsWith('.AppImage'));
  const deb = release.feed.files.find((file) => file.url.endsWith('.deb'));
  await smokeLinux(join(directory, appImage.url), undefined, { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' });
  const extracted = await mkdtemp(join(tmpdir(), 'rally-verify-deb-'));
  try {
    execFileSync('dpkg-deb', ['-x', join(directory, deb.url), extracted], { stdio: 'inherit' });
    const root = join(extracted, 'opt', 'Rally');
    if ((await readFile(join(root, 'resources', 'package-type'), 'utf8')).trim() !== 'deb') {
      throw new Error('Debian package is missing its updater package-type marker');
    }
    await verifyLinuxApplication(join(root, 'rally'));
  } finally { await rm(extracted, { recursive: true, force: true }); }
}

if (isEntryPoint(import.meta.url)) await verifyLinuxRelease(resolve(process.argv[2] ?? 'release/linux-release'));
