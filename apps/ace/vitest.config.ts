import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

// Merged onto the app's own Vite config rather than written standalone: a
// `vitest.config.ts` takes priority over `vite.config.ts` and Vitest then never
// loads it, which would silently drop the React plugin these tests render
// through.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    // Ace had no `test` block anywhere, so it ran on Vitest's five-second
    // default while CI fans four package suites out onto one shared four-core
    // runner — and its client tests render React against a real 400ms debounce.
    // `packages/db/vitest.config.ts` writes out the reasoning and carries the
    // same number; a hook is not cheaper than the test it prepares, so it takes
    // that number too rather than Vitest's 10_000 default.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // A test that stubs a global, an env var, or a mock must not hand it to
    // whichever test runs next. Vitest restores spies by default but leaves
    // `vi.stubGlobal` and `vi.stubEnv` in place, which is the leak most likely
    // to make one file's failure depend on another file having run.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // `expect.poll` has its own budget, and its default is Vitest's 1_000,
    // which is under the debounce window a client test legitimately waits out.
    expect: { poll: { timeout: 15_000, interval: 50 } },
  },
}));
