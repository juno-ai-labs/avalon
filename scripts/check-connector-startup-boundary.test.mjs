import assert from 'node:assert/strict';
import test from 'node:test';
import { assertConnectorIngressStartupBoundary } from './check-connector-startup-boundary.mjs';

test('requires the dedicated entry point and refuses API runtime modules', () => {
  const leaf = '// src/ashby-ingress-worker.ts\n';
  assert.doesNotThrow(() => assertConnectorIngressStartupBoundary(leaf));
  assert.throws(() => assertConnectorIngressStartupBoundary('// another.ts\n'), /not the Ashby/u);
  for (const module of ['app', 'worker-events', 'services/connection-service', 'lib/connector-registry', 'durable-objects/agent-loop-do']) {
    assert.throws(() => assertConnectorIngressStartupBoundary(`${leaf}// src/${module}.ts\n`), /startup imports/u);
  }
});
