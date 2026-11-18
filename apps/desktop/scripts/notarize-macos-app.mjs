import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  notarizeWithResumableWait,
  notarytoolCredentialArgs,
  runAndCapture,
  runAppleNetworkCommand,
} from './apple-notarization.mjs';

/**
 * electron-builder `afterSign` hook: notarizes and staples the signed Rally.app
 * before the ZIP and DMG targets are built from it.
 *
 * This replaces electron-builder's own notarization (`mac.notarize: false`),
 * which runs `notarytool submit --wait` as one call: a connection lost during an
 * hour-long wait failed the whole release. Here the wait resumes on the same
 * submission id, and the ZIP mirrors @electron/notarize's.
 */
export default async function notarizeMacosApp(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const productFilename = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${productFilename}.app`);
  const directory = await mkdtemp(join(tmpdir(), 'rally-app-notarization-'));
  try {
    const zipPath = join(directory, `${productFilename}.zip`);
    const zipped = await runAndCapture('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]);
    if (zipped.code !== 0) throw new Error(`ditto of ${appPath} failed with status ${String(zipped.code)}\n${zipped.stderr}`.trim());
    await notarizeWithResumableWait({ path: zipPath, credentials: notarytoolCredentialArgs(process.env) });
    await runAppleNetworkCommand(`stapler of ${appPath}`, '/usr/bin/xcrun', ['stapler', 'staple', appPath]);
    console.log(`Notarized and stapled ${appPath}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
