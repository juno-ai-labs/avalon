import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        serviceBindings: {
          TERMINAL_RPC_TEST: { name: "terminal-rpc-test-service" },
        },
        workers: [{
          name: "terminal-rpc-test-service",
          scriptPath: "./test-workers/fixtures/terminal-rpc-service.mjs",
          modules: true,
        }],
      },
    }),
  ],
  test: {
    include: ["test-workers/**/*.test.ts"],
    // The budget here covers the platform, not product latency: the first call
    // into the Worker in a file instantiates its whole module graph (about 14
    // seconds — `docs/testing.md`), eviction and alarm delivery are real, and
    // `reset()` takes every object's input gate run-wide, so a hook in a file
    // that never resets can still wait out a sibling file's whole wipe before
    // its own work starts. Four files had each arrived at 30_000 for that
    // interleave on their own; this is the same number applied once. It is not
    // a retry — a genuine hang still fails — and the suite's own useful work is
    // budgeted at about 30 seconds in total, so a 30-second wall can only ever
    // mask a hang, never a productive run. Per-test overrides stay for the
    // tests that need *more* than this floor.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // No explicit `maxWorkers`: the pool's own default, `availableParallelism()
    // minus one`, decides how many module-graph instantiations compete against
    // the one Miniflare the files share, and `VITEST_MAX_WORKERS` overrides it
    // per machine without an edit (docs/dev-environment.md has the
    // multi-session arithmetic). If the team wants a fixed cap instead, the
    // arithmetic for choosing it: 34 files x ~14s of instantiation is ~476s of
    // work, so 3 concurrent files is ~160s of wall clock, 2 is ~240s, and 1 is
    // ~480s — the number is a team decision, not one to hardcode from a
    // four-core sandbox (docs/adding-security-defensive-and-other-limits.md).
    //
    // If a socket test in this directory starts failing intermittently, the
    // documented cause is WebSockets in a Durable Object under per-file storage
    // isolation and the documented remedy is `maxWorkers: 1, isolate: false`
    // here (docs/testing.md) — never a `retry`, and never adopted pre-emptively,
    // because it serialises the suite into roughly eight minutes.
  },
});
