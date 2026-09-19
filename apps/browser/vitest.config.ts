import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      serviceBindings: { GLOBAL_API: { name: "browser-api-transport-fixture" } },
      workers: [{ name: "browser-api-transport-fixture", scriptPath: "./test/transport-fixture.mjs", modules: true }],
    },
  })],
  test: {
    include: ["test/**/*.test.ts"],
    // The same workerd pool `apps/api/vitest.workers.config.ts` runs on, and
    // the same budget, transcribed from there rather than chosen: Vitest's
    // 5-second default has to cover pool startup, and under a whole-monorepo
    // `pnpm test` with the API's workerd shards saturating the machine
    // `host.test.ts` timed out on that default while passing in isolation.
    // The wait being budgeted is the pool's cold start, not the test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
