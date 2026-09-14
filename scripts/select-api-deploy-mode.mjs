import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { isEntryPoint } from './entry-point.mjs';

const execFile = promisify(execFileCallback);

const DIRECT_DEPLOY_PATHS = new Set([
  'apps/api/wrangler.documents.global.jsonc',
  'apps/api/wrangler.global.jsonc',
  'apps/api/wrangler.telemetry.global.jsonc',
  'apps/api/wrangler.pricing.global.jsonc',
  'apps/api/wrangler.terminal.global.jsonc',
  'apps/api/wrangler.artifacts.global.jsonc',
]);

export function selectApiDeployMode({ deployedShas, changedPaths }) {
  const knownShas = deployedShas.filter(Boolean);
  if (knownShas.length !== deployedShas.length || new Set(knownShas).size !== 1) {
    return {
      mode: 'direct',
      reason: 'active regional versions do not identify one shared source revision',
    };
  }

  const directPath = changedPaths.find((path) =>
    DIRECT_DEPLOY_PATHS.has(path) || path.startsWith('apps/api/crash-symbolicator/'));
  if (directPath) {
    return {
      mode: 'direct',
      reason: `${directPath} requires Wrangler to apply deployment configuration or platform state`,
    };
  }

  return {
    mode: 'versioned',
    reason: 'the release changes only Worker version content and version-compatible bindings',
  };
}

export async function changedPathsSince(repositoryDirectory, sha) {
  await execFile('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repositoryDirectory });
  const { stdout } = await execFile('git', ['diff', '--name-only', sha, 'HEAD'], {
    cwd: repositoryDirectory,
  });
  return stdout.trim().split('\n').filter(Boolean);
}

function parseArguments(argv) {
  const deployedShas = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--deployed-sha') throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--deployed-sha requires a value');
    deployedShas.push(value === 'unknown' ? null : value);
    index += 1;
  }
  if (deployedShas.length === 0) {
    throw new Error('Usage: select-api-deploy-mode.mjs --deployed-sha <sha|unknown> [...]');
  }
  return deployedShas;
}

if (isEntryPoint(import.meta.url)) {
  const deployedShas = parseArguments(process.argv.slice(2));
  let effectiveDeployedShas = deployedShas;
  let changedPaths = [];
  try {
    if (deployedShas.every(Boolean)) {
      changedPaths = await changedPathsSince(process.cwd(), deployedShas[0]);
    }
  } catch {
    effectiveDeployedShas = deployedShas.map(() => null);
  }
  const selection = selectApiDeployMode({ deployedShas: effectiveDeployedShas, changedPaths });
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}
