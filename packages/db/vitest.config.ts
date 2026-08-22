import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test in `migrations.test.ts` is synchronous and builds a fresh
    // SQLite database by replaying the whole migration chain, so its runtime is
    // CPU and nothing else. Under `pnpm test` it competes with every other
    // package's suite at once, and a run that took four seconds alone overruns
    // Vitest's five-second default — reporting a timeout in whichever test the
    // scheduler happened to be in, which reads as a flake in the code rather
    // than as contention. Five seconds costs a passing run nothing and only
    // slows one that was going to fail anyway; `apps/desktop/vitest.config.ts`
    // carries the same number for the same reason.
    testTimeout: 15_000,
  },
});
