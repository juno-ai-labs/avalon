import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findBareWorkerZodImports,
  findWorkerSchemaCompatibilityViolations,
  schemaHeavyWorkerRoots,
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
  await writeFile(join(sourceDirectory, 'compatible.ts'), [
    'z.number().int().safe();',
    'z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID");',
  ].join('\n'));

  assert.deepEqual(await findWorkerSchemaCompatibilityViolations({
    rootDirectory,
    roots: ['src'],
  }), [
    'src/loose.ts: loose UUID',
    'src/loose.ts: unsafe integer',
  ]);
});

test('the production Worker graph keeps Zod v4 behind its compatibility edge', async () => {
  assert.deepEqual(await findBareWorkerZodImports({
    roots: [...schemaHeavyWorkerRoots, 'packages/agent-harness/src'],
    allowlist: zodV4WorkerAllowlist,
  }), []);
  assert.deepEqual(await findWorkerSchemaCompatibilityViolations(), []);
});
