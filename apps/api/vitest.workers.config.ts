import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
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
    // Bounds how many module-graph instantiations compete at once against the
    // one Miniflare the pool shares across concurrently-running files — a cap
    // on contention, not on test throughput. Left implicit this inherited
    // `availableParallelism() - 1`, which is 3 on the four-core sandbox and
    // grows with the machine; 3 is that number made explicit and stable. The
    // arithmetic if it needs revisiting: 34 files x ~14s of instantiation is
    // ~476s of work, so 3 concurrent files is ~160s of wall clock, 2 is ~240s,
    // and 1 is ~480s. `VITEST_MAX_WORKERS` overrides this without an edit.
    //
    // If a socket test in this directory starts failing intermittently, the
    // documented cause is WebSockets in a Durable Object under per-file storage
    // isolation and the documented remedy is `maxWorkers: 1, isolate: false`
    // here (docs/testing.md) — never a `retry`, and never adopted pre-emptively,
    // because it serialises the suite into roughly eight minutes.
    maxWorkers: 3,
  },
});
