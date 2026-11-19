// Proves that the API's HTTP, queue and cron graph loads neither Durable Object.
//
// Today every module ships in one Worker, so this changes nothing about
// startup. It keeps open the option of splitting that graph into its own
// Worker: one stray value import (`conversationObjectName` from
// `agent-loop-do.ts`, the migration list from `workspace-do.ts`) is enough to
// pull a whole object's graph back in, and nothing else would notice.
// `docs/api-worker-deployment.md` records what each leak cost.

import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { parseWranglerConfig } from './wrangler-config.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDirectory = join(repositoryDirectory, 'apps/api');
const ENTRY = 'src/worker-events.ts';
const OBJECT_MODULES = ['src/durable-objects/agent-loop-do.ts', 'src/durable-objects/workspace-do.ts'];

/** Rejects a bundle of the HTTP/queue/cron entry that contains a Durable Object module. */
export function assertObjectStartupBoundary(bundle) {
  if (!bundle.includes(`// ${ENTRY}\n`)) throw new Error(`The artifact is not a bundle of ${ENTRY}`);
  for (const module of OBJECT_MODULES) {
    if (bundle.includes(`// ${module}\n`)) throw new Error(`${ENTRY} startup graph imports ${module}`);
  }
}

async function run() {
  // The Global config names Durable Object classes the entry does not export,
  // which Wrangler refuses, so bundle with only the settings that shape the
  // module graph: compatibility and the text-module rules. The config sits in
  // `apps/api` (the name is gitignored) because Wrangler writes each module's
  // marker relative to the config's directory, and the markers must read
  // `// src/...`.
  const global = parseWranglerConfig(await readFile(join(apiDirectory, 'wrangler.global.jsonc'), 'utf8'));
  const config = join(apiDirectory, 'wrangler.object-boundary.scratch.jsonc');
  try {
    await writeFile(config, JSON.stringify({
      name: 'object-startup-boundary',
      main: ENTRY,
      compatibility_date: global.compatibility_date,
      compatibility_flags: global.compatibility_flags,
      rules: global.rules,
    }));
    const outfile = join(apiDirectory, 'dist-object-boundary/worker.bundle');
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--config', config, '--outfile', outfile], {
      cwd: apiDirectory,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    assertObjectStartupBoundary(await readFile(outfile, 'utf8'));
  } finally {
    await rm(config, { force: true });
  }
  process.stdout.write('Durable Object startup boundary verified\n');
}

if (isEntryPoint(import.meta.url)) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
