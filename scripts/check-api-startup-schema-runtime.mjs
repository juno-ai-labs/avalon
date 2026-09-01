#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const schemaHeavyWorkerRoots = [
  'apps/api/src',
  'packages/agent-harness/src',
  'packages/connectors/src',
  'packages/contracts/src',
  'packages/db/src',
];

export const sharedSchemaConsumerRoots = [
  ...schemaHeavyWorkerRoots,
  'apps/ace/src',
  'apps/desktop/src',
];

export const schemaCompatibilityRoots = [
  ...sharedSchemaConsumerRoots,
];

/**
 * The harness consumes Zod v4 schemas owned by Bind and compiles JSON Schema
 * back into Zod v4 for argument classification. Keep that compatibility edge
 * explicit; ordinary API and shared contract validation belongs on `zod/v3`.
 */
export const zodV4WorkerAllowlist = new Set([
  'packages/agent-harness/src/bind-runtime.ts',
  'packages/agent-harness/src/tool-arguments.ts',
  'packages/contracts/src/zod-error.ts',
]);

const BARE_ZOD_IMPORT = /\b(?:from\s+|import\s*)["']zod["']/u;
const ZOD_V3_IMPORT = /\bfrom\s+["']zod\/v3["']/u;
// These lexical checks deliberately keep the repository rule cheap and
// dependency-free. A comment or string that spells a governed call may need to
// be reworded; parsing TypeScript just to distinguish that rare case is not
// justified until one occurs in production source.
const UNSAFE_V3_INTEGER = /\.int\((?:[^()]|\([^()]*\))*\)(?!\.safe\(\))/u;
const LOOSE_V3_UUID = /\.uuid\(\)/u;
const NONFINITE_V3_NUMBER = /\b(?:z|z3)(?:\.coerce)?\.number\(\)(?!\.(?:int|finite)\()/u;
const LOOSE_V3_OFFSET_DATETIME = /\.datetime\(\{\s*offset:\s*true\s*\}\)/u;
const OPTIONAL_V3_UNKNOWN_FIELD = /:\s*z(?:3)?\.unknown\(\)(?!(?:\.nullable\(\))?(?:\.optional\(\)|\.default\())/u;

export async function findBareWorkerZodImports({
  rootDirectory = repositoryDirectory,
  roots = sharedSchemaConsumerRoots,
  allowlist = zodV4WorkerAllowlist,
} = {}) {
  const violations = [];
  for (const root of roots) {
    const directory = resolve(rootDirectory, root);
    for (const file of await sourceFiles(directory)) {
      const repositoryPath = relative(rootDirectory, file).replaceAll('\\', '/');
      if (allowlist.has(repositoryPath) || repositoryPath.includes('.test.')) continue;
      if (BARE_ZOD_IMPORT.test(await readFile(file, 'utf8'))) violations.push(repositoryPath);
    }
  }
  return violations.sort();
}

export async function findWorkerSchemaCompatibilityViolations({
  rootDirectory = repositoryDirectory,
  roots = schemaCompatibilityRoots,
  v4Allowlist = zodV4WorkerAllowlist,
} = {}) {
  const violations = [];
  for (const root of roots) {
    for (const file of await sourceFiles(resolve(rootDirectory, root))) {
      const repositoryPath = relative(rootDirectory, file).replaceAll('\\', '/');
      if (repositoryPath.includes('.test.')) continue;
      const source = await readFile(file, 'utf8');
      if (v4Allowlist.has(repositoryPath)) {
        // Adapter modules own only v4 schemas. The error classifier is the one
        // exception: it imports both error classes but constructs no schema.
        if (repositoryPath !== 'packages/contracts/src/zod-error.ts' && ZOD_V3_IMPORT.test(source)) {
          violations.push(`${repositoryPath}: mixed schema runtimes`);
        }
        continue;
      }
      if (UNSAFE_V3_INTEGER.test(source)) violations.push(`${repositoryPath}: unsafe integer`);
      if (LOOSE_V3_UUID.test(source)) violations.push(`${repositoryPath}: loose UUID`);
      if (OPTIONAL_V3_UNKNOWN_FIELD.test(source)) violations.push(`${repositoryPath}: optional unknown field`);
      if (NONFINITE_V3_NUMBER.test(source)) violations.push(`${repositoryPath}: non-finite number`);
      if (repositoryPath !== 'packages/contracts/src/schema-runtime.ts'
        && LOOSE_V3_OFFSET_DATETIME.test(source)) {
        violations.push(`${repositoryPath}: loose offset datetime`);
      }
    }
  }
  return violations.sort();
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function run() {
  const violations = await findBareWorkerZodImports();
  violations.push(...await findWorkerSchemaCompatibilityViolations());
  if (violations.length > 0) {
    throw new Error([
      'Modules that compose shared Worker schemas must import the startup-efficient `zod/v3` runtime.',
      ...violations.map((file) => `- ${file}`),
    ].join('\n'));
  }
  process.stdout.write('API startup schema runtime boundary verified\n');
}

if (isEntryPoint(import.meta.url)) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
