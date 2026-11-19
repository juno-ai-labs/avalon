import assert from 'node:assert/strict';
import test from 'node:test';

import { assertObjectStartupBoundary } from './check-object-startup-boundary.mjs';

const entry = '// src/worker-events.ts\nvar handler = {};\n';

test('accepts an HTTP/queue/cron graph without a Durable Object module', () => {
  assert.doesNotThrow(() => assertObjectStartupBoundary(`// src/app.ts\nvar app = {};\n${entry}`));
});

test('rejects each Durable Object module leaking into the graph', () => {
  for (const module of ['src/durable-objects/agent-loop-do.ts', 'src/durable-objects/workspace-do.ts']) {
    assert.throws(
      () => assertObjectStartupBoundary(`// ${module}\nvar x = 1;\n${entry}`),
      { message: `src/worker-events.ts startup graph imports ${module}` },
    );
  }
});

test('does not mistake a module whose name extends an object module for the object', () => {
  assert.doesNotThrow(() => assertObjectStartupBoundary(`// src/durable-objects/workspace-do-schema-migrations.ts\n${entry}`));
});

test('rejects an artifact that is not a bundle of the entry', () => {
  assert.throws(() => assertObjectStartupBoundary('// src/index.ts\n'), { message: 'The artifact is not a bundle of src/worker-events.ts' });
});
