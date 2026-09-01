import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPostHogStartupBoundary } from './check-posthog-startup-boundary.mjs';

const postHogModules = [
  '// ../../node_modules/.pnpm/posthog-node@5.48.2/node_modules/posthog-node/dist/index.mjs',
  '// ../../node_modules/.pnpm/@posthog+core@1.47.1/node_modules/@posthog/core/dist/index.mjs',
  '// src/telemetry/posthog-adapter.ts',
].join('\n');

test('accepts regional API graphs without PostHog modules', () => {
  assert.doesNotThrow(() => assertPostHogStartupBoundary({
    globalBundle: '// src/index.ts',
    euBundle: '// src/index.ts',
  }));
});

test('rejects a PostHog module leaking into either regional API graph', () => {
  for (const [label, bundles] of [
    ['Global API', { globalBundle: `// src/index.ts\n${postHogModules}`, euBundle: '// src/index.ts' }],
    ['EU API', { globalBundle: '// src/index.ts', euBundle: `// src/index.ts\n${postHogModules}` }],
  ]) {
    assert.throws(() => assertPostHogStartupBoundary({
      ...bundles,
    }), new RegExp(`${label} startup graph contains`, 'u'));
  }
});
