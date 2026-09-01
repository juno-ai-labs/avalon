import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findBareWorkerZodImports,
  findWorkerSchemaCompatibilityViolations,
  sharedSchemaConsumerRoots,
  zodV4WorkerAllowlist,
} from './check-api-startup-schema-runtime.mjs';

test('finds an eager Zod v4 import but accepts the v3-compatible runtime', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'rally-zod-startup-'));
  const sourceDirectory = join(rootDirectory, 'src');
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, 'eager.ts'), 'import { z } from "zod";\n');
  await writeFile(join(sourceDirectory, 'efficient.ts'), 'import { z } from "zod/v3";\n');

  assert.deepEqual(await findBareWorkerZodImports({
    rootDirectory,
    roots: ['src'],
    allowlist: new Set(),
  }), ['src/eager.ts']);
});

test('finds v3 integer and UUID semantics that are looser than Zod v4', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'rally-zod-compatibility-'));
  const sourceDirectory = join(rootDirectory, 'src');
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, 'loose.ts'), [
    'z.number().int();',
    'z.string().uuid();',
  ].join('\n'));
  await writeFile(
    join(sourceDirectory, 'parameterized.ts'),
    'z.number().int({ message: "whole numbers only" });\n',
  );
  await writeFile(join(sourceDirectory, 'unknown.ts'), [
    'z.object({ required: z.unknown(), requiredNullable: z.unknown().nullable() });',
    'z.object({ optional: z.unknown().optional(), defaulted: z.unknown().default(null) });',
  ].join('\n'));
  await writeFile(join(sourceDirectory, 'scalars.ts'), [
    'z.object({ duration: z.number(), coerced: z.coerce.number() });',
    'z.string().datetime({ offset: true });',
  ].join('\n'));
  await writeFile(join(sourceDirectory, 'compatible.ts'), [
    'z.number().int().safe();',
    'z.number().finite();',
    'z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID");',
    'OffsetDateTimeSchema;',
    'z.unknown().optional();',
  ].join('\n'));

  assert.deepEqual(await findWorkerSchemaCompatibilityViolations({
    rootDirectory,
    roots: ['src'],
  }), [
    'src/loose.ts: loose UUID',
    'src/loose.ts: unsafe integer',
    'src/parameterized.ts: unsafe integer',
    'src/scalars.ts: loose offset datetime',
    'src/scalars.ts: non-finite number',
    'src/unknown.ts: optional unknown field',
  ]);
});

test('the production Worker graph keeps Zod v4 behind its compatibility edge', async () => {
  assert.deepEqual(await findBareWorkerZodImports({
    roots: sharedSchemaConsumerRoots,
    allowlist: zodV4WorkerAllowlist,
  }), []);
  assert.deepEqual(await findWorkerSchemaCompatibilityViolations(), []);
});

test('rejects a mixed schema runtime inside a v4 adapter', async (context) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'rally-zod-mixed-'));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const sourceDirectory = join(rootDirectory, 'adapter');
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, 'mixed.ts'), [
    'import { z } from "zod";',
    'import { z as z3 } from "zod/v3";',
    'z3.object({',
    '  count: z3.number().int()',
    '    .safe(),',
    '});',
  ].join('\n'));

  assert.deepEqual(await findWorkerSchemaCompatibilityViolations({
    rootDirectory,
    roots: ['adapter'],
    v4Allowlist: new Set(['adapter/mixed.ts']),
  }), ['adapter/mixed.ts: mixed schema runtimes']);
});
