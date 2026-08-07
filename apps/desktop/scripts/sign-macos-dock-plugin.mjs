import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { selectDeveloperIdIdentity } from './finalize-macos-release.mjs';

const run = promisify(execFile);

export default async function signMacosDockPlugin(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const applicationPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const pluginPath = join(
    applicationPath,
    'Contents/PlugIns/AvalonDockTilePlugin.docktileplugin',
  );
  const identities = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const qualifier = process.env.CSC_NAME
    || context.packager.platformSpecificBuildOptions.identity
    || '';
  const identity = selectDeveloperIdIdentity(
    `${identities.stdout}\n${identities.stderr}`,
    qualifier,
  );

  await run('/usr/bin/codesign', [
    '--force',
    '--timestamp',
    '--options',
    'runtime',
    '--sign',
    identity.hash,
    pluginPath,
  ]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', pluginPath]);
  console.log(`Signed ${pluginPath} with ${identity.name}`);
}
