import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const authorityConfigs = [
  join(repositoryDirectory, 'apps/api/wrangler.global.jsonc'),
  join(repositoryDirectory, 'apps/api/wrangler.eu.jsonc'),
];
const migrationOwnedPaths = [
  '.github/workflows/migrate-supabase.yml',
  'infrastructure/supabase/',
  'scripts/provision-supabase-storage.mjs',
  'scripts/validate-supabase-migration-targets.mjs',
];
const SHA = /^[0-9a-f]{40}$/u;
const ZERO_SHA = /^0{40}$/u;

export function productDataAuthority(source, label) {
  const values = [...source.matchAll(/"PRODUCT_DATA_AUTHORITY"\s*:\s*"([^"]+)"/gu)]
    .map((match) => match[1]);
  if (values.length !== 1) {
    throw new Error(`${label} must declare PRODUCT_DATA_AUTHORITY exactly once`);
  }
  if (!['d1', 'shadow', 'postgres'].includes(values[0])) {
    throw new Error(`${label} declares unsupported PRODUCT_DATA_AUTHORITY ${values[0]}`);
  }
  return values[0];
}

export function packageMigrationInputsChanged(beforePackage, afterPackage) {
  const migrationInputs = (manifest) => ({
    supabase: manifest.devDependencies?.supabase ?? null,
    scripts: Object.fromEntries(
      Object.entries(manifest.scripts ?? {}).filter(([name]) => name.startsWith('postgres:')),
    ),
  });
  return JSON.stringify(migrationInputs(beforePackage)) !== JSON.stringify(migrationInputs(afterPackage));
}

export function migrationOwnedFilesChanged(paths, beforePackage, afterPackage) {
  if (paths.some((path) => migrationOwnedPaths.some((owned) => (
    owned.endsWith('/') ? path.startsWith(owned) : path === owned
  )))) return true;
  return paths.includes('package.json')
    && packageMigrationInputsChanged(beforePackage, afterPackage);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function packageAt(revision) {
  return JSON.parse(git(['show', `${revision}:package.json`]));
}

export async function decideSupabaseMigration(options = {}) {
  const environment = options.environment ?? process.env;
  const read = options.readFile ?? readFile;
  const authorities = await Promise.all(authorityConfigs.map(async (path) => (
    productDataAuthority(await read(path, 'utf8'), path)
  )));
  const authorityRequiresMigration = authorities.some((authority) => authority !== 'd1');
  const forced = environment.FORCE_POSTGRES_MIGRATION === 'true';
  const before = environment.BEFORE_SHA?.trim() ?? '';
  let sourceChanged = false;

  if (before && !ZERO_SHA.test(before)) {
    if (!SHA.test(before)) throw new Error('BEFORE_SHA must be a full Git commit SHA');
    const paths = git(['diff', '--name-only', before, 'HEAD', '--']).split('\n').filter(Boolean);
    const beforePackage = paths.includes('package.json') ? packageAt(before) : {};
    const afterPackage = paths.includes('package.json')
      ? JSON.parse(await read(join(repositoryDirectory, 'package.json'), 'utf8'))
      : {};
    sourceChanged = migrationOwnedFilesChanged(paths, beforePackage, afterPackage);
  } else if (ZERO_SHA.test(before)) {
    sourceChanged = true;
  }

  const reasons = [
    ...(authorityRequiresMigration ? ['authority'] : []),
    ...(sourceChanged ? ['migration-source'] : []),
    ...(forced ? ['operator'] : []),
  ];
  return { required: reasons.length > 0, reasons };
}

if (isEntryPoint(import.meta.url)) {
  const decision = await decideSupabaseMigration();
  process.stdout.write(`required=${decision.required}\nreason=${decision.reasons.join(',') || 'not-required'}\n`);
}
