import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_MARKERS = [
  { name: 'posthog-node', pattern: /^\/\/ .*\/posthog-node@/mu },
  { name: '@posthog/core', pattern: /^\/\/ .*\/@posthog\+core@/mu },
  { name: 'the PostHog adapter', pattern: /^\/\/ src\/telemetry\/posthog-adapter\.ts$/mu },
];

/** Proves the regional startup exclusion against Wrangler's exact emitted artifacts. */
export function assertTelemetryStartupBoundary({ globalBundle }) {
  for (const [label, bundle] of [
    ['Global API', globalBundle],
  ]) {
    for (const marker of MODULE_MARKERS) {
      if (marker.pattern.test(bundle)) {
        throw new Error(`${label} startup graph contains ${marker.name}`);
      }
    }
  }
}

async function run() {
  const globalBundle = await readFile(join(repositoryDirectory, 'apps/api/dist/worker.bundle'), 'utf8');
  assertTelemetryStartupBoundary({ globalBundle });
  process.stdout.write('Telemetry destination startup boundary verified\n');
}

if (isEntryPoint(import.meta.url)) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
