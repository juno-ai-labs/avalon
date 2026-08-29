import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/helpers/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // A one-shot `vitest run` has nothing to share the machine with, so it takes
    // the core Vitest holds back by default (`availableParallelism() - 1`) — the
    // right hedge for a watch run beside an editor and a dev server, but idle
    // capacity here. Measured alone: api 98s -> 84s, desktop 84s -> 78s.
    //
    // `pnpm test` starts every package at once, so the budgets do stack — nine
    // runs claiming four workers each put the load average at 8-11 on 4 cores.
    // That was measured and it costs nothing: capping every run at two workers
    // came out at 233s against 234s uncapped, and capping at one at 358s. The
    // scheduler handles the oversubscription, so there is no budget to split.
    //
    // That measurement was of one session on the machine. `VITEST_MAX_WORKERS`
    // is the lever when that stops being true — Vitest applies it after this
    // config resolves, so it overrides the value here — and a machine hosting
    // several agent sessions at once is the case to reach for it in: the total
    // suite runtime barely moves, but the maximum stall one thread sees between
    // schedules grows with the oversubscription, and that stall is what every
    // fixed timeout in the suites is measured against. See
    // `docs/dev-environment.md`.
    maxWorkers: availableParallelism(),
    // The largest suite in the repository, and 80 of its files build a migrated
    // SQLite database, so a run that is merely competing for a core under
    // `pnpm test` must not be reported as a timeout in whichever test the
    // scheduler happened to be in. `packages/db/vitest.config.ts` writes out
    // the reasoning and carries the same number; a hook is not cheaper than the
    // test it prepares, so both get it.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // A test that stubs a global, an env var, or a mock must not hand it to
    // whichever test runs next. Vitest restores spies by default but leaves
    // `vi.stubGlobal` and `vi.stubEnv` in place, which is the leak most likely
    // to make one file's failure depend on another file having run.
    // `apps/desktop/vitest.config.ts` sets the same three for the same reason.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
