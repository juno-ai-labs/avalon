import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { version: appBuilderLibVersion } = require('app-builder-lib/package.json');
const { version: electronBuilderVersion } = require('electron-builder/package.json');
if (appBuilderLibVersion !== electronBuilderVersion) {
  throw new Error(
    `app-builder-lib ${appBuilderLibVersion} must exactly match electron-builder ${electronBuilderVersion}`,
  );
}

const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');

export const BLOCKMAP_BUILDER_VERSION = appBuilderLibVersion;

export async function writeBlockmap(artifactPath, outputPath = `${artifactPath}.blockmap`) {
  return await buildBlockMap(artifactPath, 'gzip', outputPath);
}

export async function assertBlockmapMatches(artifactPath, expectedPath, scratchPath) {
  await writeBlockmap(artifactPath, scratchPath);
  const [expected, actual] = await Promise.all([readFile(expectedPath), readFile(scratchPath)]);
  if (!expected.equals(actual)) {
    throw new Error(`Blockmap ${expectedPath} does not describe the final bytes of ${artifactPath}`);
  }
}
