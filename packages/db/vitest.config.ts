import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The heavy tests here — `baseline-migration.test.ts`, `dev-seed.test.ts`,
    // and the two retirement-migration files — build a fresh SQLite database by
    // replaying the whole migration chain, so their runtime is CPU and nothing
    // else. Under `pnpm test` they compete with every other package's suite at
    // once, and a run that took four seconds alone overruns Vitest's
    // five-second default — reporting a timeout in whichever test the scheduler
    // happened to be in, which reads as a flake in the code rather than as
    // contention. Fifteen seconds costs a passing run nothing and only slows
    // one that was going to fail anyway; `apps/desktop/vitest.config.ts` and
    // `apps/api/vitest.config.ts` carry the same number for the same reason.
    //
    // The number is sized for contention from the other suites, so treat it as
    // a floor rather than a ceiling: several agent sessions on one machine
    // multiply that contention again, and `VITEST_MAX_WORKERS` is the lever
    // there (see `docs/dev-environment.md`).
    testTimeout: 15_000,
    // `hookTimeout` is a separate option and used to sit at Vitest's 10_000
    // default, which is backwards here: the single heaviest piece of work in
    // the package is the `beforeAll` in `baseline-migration.test.ts` that
    // replays the migrations twice, and it had a third less budget than the
    // tests it prepares.
    hookTimeout: 15_000,
  },
});
