import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// One pool, not two. Every unit worth testing here either owns SQLite storage
// or answers a Request, so running the whole suite in workerd costs nothing and
// removes the "passes in node, breaks in the runtime" gap a split would open.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
