import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalAnalyticsQueries,
  formatTerminalAnalyticsReport,
  parseTerminalAnalyticsArguments,
  queryTerminalAnalytics,
} from "./report-terminal-analytics.mjs";

test("analytics report arguments are bounded and cannot inject SQL", () => {
  assert.deepEqual(parseTerminalAnalyticsArguments([]), {
    days: 7,
    region: "all",
    snapshot: null,
  });
  assert.deepEqual(parseTerminalAnalyticsArguments([
    "--days", "30", "--region", "global", "--snapshot", "daytona-small",
  ]), { days: 30, region: "global", snapshot: "daytona-small" });
  assert.throws(() => parseTerminalAnalyticsArguments(["--days", "91"]), /between 1 and 90/u);
  assert.throws(() => parseTerminalAnalyticsArguments(["--snapshot", "x' OR 1=1"]), /snapshot/u);
});

test("analytics queries use weighted estimates and percentiles", () => {
  const queries = buildTerminalAnalyticsQueries({ days: 7, region: "global", snapshot: "daytona-small" });
  for (const query of Object.values(queries)) {
    assert.match(query, /terminal_platform_v1/u);
    assert.match(query, /timestamp > NOW\(\) - INTERVAL '7' DAY/u);
    assert.match(query, /blob4 = 'global'/u);
    assert.match(query, /blob5 = 'daytona-small'/u);
  }
  assert.match(queries.operations, /SUM\(_sample_interval\)/u);
  assert.match(queries.operations, /quantileExactWeighted\(0\.95\)\(double1, _sample_interval\)/u);
});

test("human report includes the observed start, warming, phase timings, and image signal", () => {
  const report = formatTerminalAnalyticsReport({ days: 7, region: "all", snapshot: null }, {
    overview: [{
      observed_start: "2026-08-13 16:00:00.000",
      observed_end: "2026-08-13 18:00:00.000",
      sampled_rows: 120,
      estimated_operations: 120,
    }],
    operations: [
      {
        region: "global", snapshot: "daytona-small", operation: "sandbox_create",
        outcome: "completed", source_state: "absent", sampled_rows: 40,
        estimated_operations: 40, avg_duration_ms: 6_000, p50_duration_ms: 5_500,
        p95_duration_ms: 9_000, max_duration_ms: 10_000,
        p50_provider_create_ms: 4_500, p95_provider_create_ms: 8_000,
        p50_policy_readback_ms: 1_000, p95_policy_readback_ms: 1_500,
        p50_install_ms: 0, p95_install_ms: 0, p50_verify_ms: 0, p95_verify_ms: 0,
      },
      {
        region: "global", snapshot: "daytona-small", operation: "sandbox_bootstrap",
        outcome: "completed", source_state: "running", sampled_rows: 40,
        estimated_operations: 40, avg_duration_ms: 13_000, p50_duration_ms: 12_000,
        p95_duration_ms: 18_000, max_duration_ms: 20_000,
        p50_provider_create_ms: 0, p95_provider_create_ms: 0,
        p50_policy_readback_ms: 500, p95_policy_readback_ms: 800,
        p50_install_ms: 9_000, p95_install_ms: 15_000,
        p50_verify_ms: 2_500, p95_verify_ms: 3_000,
      },
      {
        region: "global", snapshot: "daytona-small", operation: "sandbox_start",
        outcome: "completed", source_state: "stopped", sampled_rows: 40,
        estimated_operations: 40, avg_duration_ms: 1_200, p50_duration_ms: 1_000,
        p95_duration_ms: 2_000, max_duration_ms: 2_500,
        p50_provider_create_ms: 0, p95_provider_create_ms: 0,
        p50_policy_readback_ms: 0, p95_policy_readback_ms: 0,
        p50_install_ms: 0, p95_install_ms: 0, p50_verify_ms: 0, p95_verify_ms: 0,
      },
    ],
    capabilities: [
      { region: "global", snapshot: "daytona-small", installed_capabilities: "gh,pnpm,sqlite3", estimated_bootstraps: 40 },
    ],
  });

  assert.match(report, /Observed data: 2026-08-13 16:00:00\.000 → 2026-08-13 18:00:00\.000/u);
  assert.match(report, /Warm stopped sandbox/u);
  assert.match(report, /install p50 9\.00s, p95 15\.00s/u);
  assert.match(report, /gh: 40/u);
  assert.match(report, /Collect 60 more successful bootstrap observations/u);
});

test("query client sends SQL as the body and rejects provider failures without echoing them", async () => {
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: [{ estimated_operations: 1 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const rows = await queryTerminalAnalytics({
    accountId: "account-id",
    apiToken: "token",
    sql: "SELECT 1",
    fetchImplementation,
  });
  assert.deepEqual(rows, [{ estimated_operations: 1 }]);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/account-id/analytics_engine/sql");
  assert.equal(calls[0].init.body, "SELECT 1");
  assert.equal(calls[0].init.headers.Authorization, "Bearer token");

  await assert.rejects(queryTerminalAnalytics({
    accountId: "account-id",
    apiToken: "token",
    sql: "SELECT 1",
    fetchImplementation: async () => new Response("credential-shaped provider detail", { status: 403 }),
  }), (error) => error.message === "Cloudflare Analytics Engine query failed with HTTP 403");
});
