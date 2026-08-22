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
    // `VITEST_MAX_WORKERS` overrides this if a machine ever disagrees.
    maxWorkers: availableParallelism(),
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
