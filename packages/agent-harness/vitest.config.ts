import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The harness suites drive whole runs over real timers and real SSE body
    // reads, and their own default wall-clock budget used to sit at exactly
    // Vitest's five-second default — two timers armed microseconds apart, so
    // whichever fired first decided whether a slow run reported a wall-clock
    // failure object or an opaque test timeout. The budgets are now set well
    // above any passing run; this raises the outer limit clear of them so a
    // run that is merely competing for a core under `pnpm test` is not
    // reported as a timeout in whichever test the scheduler happened to be in.
    // `packages/db/vitest.config.ts` and `apps/desktop/vitest.config.ts` carry
    // the same number.
    testTimeout: 15_000,
    // A hook is not cheaper than the test it prepares, so it takes the same
    // number rather than Vitest's 10_000 default.
    hookTimeout: 15_000,
    // A test that stubs a global, an env var, or a mock must not hand it to
    // whichever test runs next. Vitest restores spies by default but leaves
    // `vi.stubGlobal` and `vi.stubEnv` in place, which is the leak most likely
    // to make one file's failure depend on another file having run.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // `expect.poll` has its own budget, and its default is Vitest's 1_000 —
    // sized for nothing in particular and well under the timers this suite
    // legitimately waits on.
    expect: { poll: { timeout: 15_000, interval: 50 } },
  },
});
