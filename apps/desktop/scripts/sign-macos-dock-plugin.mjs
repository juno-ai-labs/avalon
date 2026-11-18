import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { APPLE_NETWORK_MAX_ATTEMPTS, runAppleNetworkCommand } from './apple-notarization.mjs';
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
    join(applicationPath, 'Contents/Resources/native/push-notifications.node'),
  ];
  // A local build has no job timeout to bound the retries, so it tries once
  // and fails fast, as it did before release builds retried.
  const maxAttempts = process.env.RALLY_PACKAGE_MODE === 'release' ? APPLE_NETWORK_MAX_ATTEMPTS : 1;
  for (const componentPath of componentPaths) {
    // --timestamp asks Apple's timestamp server, which a dropped connection
    // fails as "A timestamp was expected but was not found".
    await runAppleNetworkCommand(`codesign ${componentPath}`, '/usr/bin/codesign', [
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      '--sign',
      identity.hash,
      componentPath,
    ], { maxAttempts });
    await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', componentPath]);
    console.log(`Signed ${componentPath} with ${identity.name}`);
  }
}
