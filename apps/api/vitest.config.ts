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
    // Vitest keeps one core free by default (`availableParallelism() - 1`),
    // which is the right hedge for a watch run sharing a machine with an editor
    // and a dev server. A one-shot `vitest run` — what CI and the quality gates
    // do — has nothing to share with, and these files spend enough of their time
    // off-CPU (module resolution, SQLite, reading fixtures) that the freed core
    // is idle rather than held in reserve. Measured on a 4-core sandbox: api
    // 98s -> 84s, desktop 84s -> 78s.
    maxWorkers: availableParallelism(),
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
