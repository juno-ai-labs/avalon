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
    // Vitest's 5-second default is a product-latency budget, and nothing here
    // measures product latency: the first fetch in a file instantiates this
    // host's whole module graph plus the fixture service beside it, which
    // `pnpm test` runs while twelve other packages compete for the same cores.
    // That is the timeout this suite hit, on the one case that also reads a
    // built asset back. Same number and same reasoning as the other workerd
    // pool in the tree, `apps/api/vitest.workers.config.ts`: a hang still
    // fails, because the suite's own work is seconds.
    testTimeout: 30_000,
  },
});
