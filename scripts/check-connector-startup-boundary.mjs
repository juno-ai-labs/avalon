import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

export function assertConnectorIngressStartupBoundary(bundle) {
  for (const module of ['src/app.ts', 'src/worker-events.ts', 'src/services/connection-service.ts', 'src/lib/connector-registry.ts', 'src/durable-objects/agent-loop-do.ts']) {
    if (bundle.includes(`// ${module}\n`)) throw new Error(`Connector ingress startup imports ${module}`);
  }
  if (!bundle.includes('// src/ashby-ingress-worker.ts')) throw new Error('The artifact is not the Ashby ingress Worker');
}
if (isEntryPoint(import.meta.url)) {
  const path = fileURLToPath(new URL('../apps/api/dist-ashby/worker.bundle', import.meta.url));
  assertConnectorIngressStartupBoundary(await readFile(path, 'utf8'));
  process.stdout.write('Ashby ingress startup boundary verified\n');
}
