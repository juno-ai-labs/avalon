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
  test: { include: ["test/**/*.test.ts"] },
});
