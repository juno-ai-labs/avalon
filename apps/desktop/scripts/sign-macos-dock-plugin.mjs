import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { selectDeveloperIdIdentity } from './finalize-macos-release.mjs';

const run = promisify(execFile);

export default async function signMacosNativeComponents(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const applicationPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const identities = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const qualifier = process.env.CSC_NAME
    || context.packager.platformSpecificBuildOptions.identity
    || '';
  const identity = selectDeveloperIdIdentity(
    `${identities.stdout}\n${identities.stderr}`,
    qualifier,
  );

  const componentPaths = [
    join(applicationPath, 'Contents/PlugIns/RallyDockTilePluginV2.docktileplugin'),
    join(applicationPath, 'Contents/Resources/native/system-audio-tap.node'),
    join(applicationPath, 'Contents/Resources/native/unified-log.node'),
  ];
  for (const componentPath of componentPaths) {
    await run('/usr/bin/codesign', [
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      '--sign',
      identity.hash,
      componentPath,
    ]);
    await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', componentPath]);
    console.log(`Signed ${componentPath} with ${identity.name}`);
  }
}
