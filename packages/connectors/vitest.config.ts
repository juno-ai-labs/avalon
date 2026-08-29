import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // This package had no config at all, so it ran on Vitest's five-second
    // default while CI fans four package suites out onto one shared four-core
    // runner — the condition under which a timeout lands in whichever test the
    // scheduler happened to be in rather than in the one that is actually slow.
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
    // which is unrelated to anything measured here.
    expect: { poll: { timeout: 15_000, interval: 50 } },
  },
});
